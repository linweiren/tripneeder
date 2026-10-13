import https from 'node:https'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

export const CLASSIFICATION_NOW = new Date('2026-10-03T19:29:33.323Z').getTime()
export const SNAPSHOT_PATH = new URL('../../../scripts/investigations/google-places-fine-data-20261004/observations.json', import.meta.url)
const baselineRef = 'ff5b32ca3af74f4f6f9733d0b7e7446cda7da19a'

// Use the original production pipeline for before/after comparisons, without
// copying its classifier or scoring formula into a test implementation.
export async function loadClassificationBaseline() {
  const original = execFileSync('git', ['show', `${baselineRef}:api/_lib/google-places.ts`],
    { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) })
  const source = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/_lib/google-places.ts', import.meta.url)).href
      : specifier
    return `from ${quote}${url}${quote}`
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

export function classificationInput(overrides = {}) {
  return { category: 'explore', startTime: '10:00', endTime: '15:00', tags: [],
    transportMode: 'scooter', location: { name: 'fixture', lat: 22.6, lng: 120.3 }, ...overrides }
}

export function classificationPlace(id, name, types, address = '高雄市文化路1號', overrides = {}) {
  return { id, displayName: { text: name }, formattedAddress: address, types,
    businessStatus: 'OPERATIONAL', rating: 4.5, userRatingCount: 100,
    location: { latitude: 22.609, longitude: 120.3 }, utcOffsetMinutes: 480,
    googleMapsUri: `https://example.com/${id}`,
    currentOpeningHours: { periods: [{
      open: { day: 0, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 4 } },
      close: { day: 2, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 6 } },
    }] }, ...overrides }
}

// No request can fall through to Google or any other external service.
export function mockClassificationSearch(t, places) {
  const calls = []
  t.mock.timers.enable({ apis: ['Date'], now: CLASSIFICATION_NOW })
  t.mock.method(console, 'info', () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  t.mock.method(https, 'request', (url, options, callback) => {
    if (String(url) !== 'https://places.googleapis.com/v1/places:searchText') {
      throw new Error(`Unexpected external request: ${url}`)
    }
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      calls.push({ body: JSON.parse(body), mask: options.headers['x-goog-fieldmask'] })
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify({ places })))
      res.emit('end')
    })
    return req
  })
  return calls
}

export function snapshotAvailable() { return existsSync(SNAPSHOT_PATH) }
export function savedClassificationPipelines() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')).pipelines
}

// Reconstruct only already-saved usable candidates. No missing raw/excluded
// Places records, paid fields or fresh business facts are invented.
export function placesFromSavedCandidates(candidates) {
  return candidates.map(c => {
    const point = value => {
      const date = new Date(new Date(value).getTime() + c.openingHours.utcOffsetMinutes * 60000)
      return { day: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes(),
        date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() } }
    }
    return classificationPlace(c.placeId, c.name, c.types, c.address, {
      rating: c.rating, userRatingCount: c.reviewCount,
      location: { latitude: c.lat, longitude: c.lng }, utcOffsetMinutes: c.openingHours.utcOffsetMinutes,
      googleMapsUri: c.googleMapsUrl,
      currentOpeningHours: { periods: c.openingHours.windows.map(w => ({ open: point(w.openAt), close: point(w.closeAt) })) },
    })
  })
}

export function classificationSummary(implementation, candidates) {
  const selection = implementation.getPromptCandidateSelection(candidates)
  const ids = new Set(selection.promptCandidates.map(c => c.placeId))
  const countRoles = list => list.reduce((counts, c) => {
    counts[c.role] = (counts[c.role] ?? 0) + 1
    return counts
  }, {})
  return { usable: candidates.allCandidates.length, first: candidates.firstStopCandidates.length,
    other: candidates.otherCandidates.length, prompt: ids.size,
    roles: countRoles(candidates.allCandidates), promptRoles: countRoles(selection.promptCandidates),
    groups: { near: selection.nearStops.length, food: selection.foodStops.length, main: selection.mainStops.length },
    candidates: candidates.allCandidates.map((c, index) => ({ name: c.name, placeId: c.placeId,
      role: c.role, score: c.score, rank: index + 1, distanceKm: c.distanceKm,
      indoor: implementation.isIndoorCandidate(c), foodSubtype: c.foodSubtype,
      eligible: c.openingHours?.isKnown && !c.openingHours.isNeverOpen && Boolean(c.availabilitySlots?.length),
      sent: ids.has(c.placeId), group: ['nearStops', 'foodStops', 'mainStops', 'fallbackStops']
        .find(group => selection[group].some(p => p.placeId === c.placeId)) ?? null })) }
}

export async function compareClassificationSearch(before, after, places, input) {
  const oldPool = await before.getNearbyPlaceCandidates({ input: structuredClone(input) })
  const newPool = await after.getNearbyPlaceCandidates({ input: structuredClone(input) })
  return { oldPool, newPool, before: classificationSummary(before, oldPool), after: classificationSummary(after, newPool) }
}
