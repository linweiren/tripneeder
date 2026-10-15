import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { resolveCandidateRankingContext } from '../../../api/_lib/candidate-ranking-context.ts'
import { getMealSuitability } from '../../../src/services/ai/mealSuitability.ts'
import { buildTripPrompt } from '../../../src/services/ai/tripPlanPrompt.ts'

export const searchFixture = JSON.parse(readFileSync(new URL('./context-aware-search.json', import.meta.url), 'utf8'))

// Frozen, rejected search-only candidate. Never imported by the application.
// Keeping its exact source makes both successful and failing cases reviewable
// after restoring production to HEAD, without relying on untracked audit files.
export async function loadRejectedSearchProposal() {
  const file = new URL('../../../api/_lib/google-places.ts', import.meta.url)
  const source = stripTypeScriptTypes(searchFixture.rejectedProposal.source)
    .replace(/from (['"])([^'"]+)\1/g, (_m, quote, specifier) =>
      `from ${quote}${specifier.startsWith('.') ? new URL(specifier.replace(/\.js$/, '.ts'), file).href : specifier}${quote}`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

export async function loadSearchBaseline(experimental = false, restoreActivitySource = false) {
  const file = new URL('../../../api/_lib/google-places.ts', import.meta.url)
  let source = execFileSync('git', ['show', `${searchFixture.baseline}:api/_lib/google-places.ts`],
    { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) })
  if (experimental) {
    const target = 'const queryPlan = buildCandidateSearchQueryPlan(input, request.persona)'
    assert.equal(source.split(target).length, 2)
    source = source.replace(target, 'const queryPlan = __queryPlanner(input, request.persona)')
    source += '\nlet __queryPlanner; export function setQueryPlanner(planner) { __queryPlanner = planner }\n'
    if (restoreActivitySource) {
      const fallback = 'queries.push(`${personaFallback} 營業中 景點`)'
      assert.equal(source.split(fallback).length, 2)
      source = source.replace(fallback, 'queries.push(__queryPlanner(input, persona).queries[0] !== personaFallback ? personaFallback : `${personaFallback} 營業中 景點`)')
    }
  }
  source = stripTypeScriptTypes(source).replace(/from (['"])([^'"]+)\1/g, (_m, quote, specifier) =>
    `from ${quote}${specifier.startsWith('.') ? new URL(specifier.replace(/\.js$/, '.ts'), file).href : specifier}${quote}`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

// Replay the prior investigation's guarded-slot proposal, including its known
// activity-loss failure. This is a frozen experiment, not the new implementation.
export function priorSearchExperiment(api, input, persona) {
  const old = api.buildCandidateSearchQueryPlan(input, persona)
  const context = resolveCandidateRankingContext(input)
  let start = Number(input.startTime.slice(0, 2)) * 60 + Number(input.startTime.slice(3))
  let end = Number(input.endTime.slice(0, 2)) * 60 + Number(input.endTime.slice(3))
  if (end < start) end += 1440
  const overnight = [0, 1440].some(day => Math.max(start, day) < Math.min(end, day + 360) ||
    Math.max(start, day + 1260) < Math.min(end, day + 1440))
  if (input.category !== 'other' || context.customStatus !== 'recognized' || !context.themes.length ||
    overnight || typeof input.location.lat !== 'number' || typeof input.location.lng !== 'number' ||
    (context.themes.includes('outdoor') && input.tags.includes('indoor_first')) ||
    (context.themes.length === 1 && context.themes[0] === 'coffee' && !/咖啡(?:廳|館|店)/.test(input.customCategory))) return old
  if (context.themes.includes('culture')) {
    const anchor = `${input.location.name} attractions`
    return { ...old, queries: [old.queries[0].replace(anchor, `${input.location.name} 博物館 美術館 museum art gallery`), ...old.queries.slice(1)] }
  }
  const outdoor = context.themes.includes('outdoor')
  return { ...old, queries: old.queries.map(query => query === (outdoor
    ? '公園 戶外休閒 parks outdoor' : '咖啡廳 甜點店 cafe dessert')
    ? (outdoor ? '公園 步道 park trail' : '咖啡廳 cafe') : query) }
}

export function searchSummary(api, pool, input) {
  const selection = api.getPromptCandidateSelection(pool)
  const block = api.formatNearbyRecommendations(pool)
  const uses = candidates => ({
    culture: candidates.filter(c => api.hasConfirmedCulturalPrimaryPurpose(c)).length,
    cafe: candidates.filter(c => c.role === 'food' && c.foodSubtype === 'cafe').length,
    restaurant: candidates.filter(c => c.role === 'food' && c.foodSubtype === 'restaurant').length,
    mealLikely: candidates.filter(c => c.role === 'food' && getMealSuitability(c) === 'meal_likely').length,
    outdoor: candidates.filter(c => c.role === 'open_space').length,
    shopping: candidates.filter(c => c.role === 'shopping').length,
    activity: candidates.filter(c => ['main_activity', 'open_space', 'shopping'].includes(c.role)).length,
  })
  return { usable: pool.allCandidates.length, first: pool.firstStopCandidates.length,
    other: pool.otherCandidates.length, legalPrompt: selection.promptCandidates.length,
    poolUses: uses(pool.allCandidates), nearUses: uses(selection.nearStops), promptUses: uses(selection.promptCandidates),
    groups: Object.fromEntries(['nearStops', 'foodStops', 'mainStops', 'fallbackStops'].map(key => [key, selection[key].map(c => c.placeId)])),
    promptCharacters: block.length, fullPromptCharacters: buildTripPrompt(input, undefined, block).length,
    rainCandidates: api.getRainBackupCandidatePool(pool).allCandidates.length }
}

export function candidateFacts(pool) {
  return JSON.parse(JSON.stringify(pool.allCandidates.map(c => ({ placeId: c.placeId, name: c.name,
    role: c.role, foodSubtype: c.foodSubtype, score: c.score, slots: c.availabilitySlots,
    distanceKm: c.distanceKm, types: c.types }))))
}

export function createSearchReplay(t, row, extraResponses = {}) {
  let current
  t.mock.timers.enable({ apis: ['Date'], now: new Date(searchFixture.fixedClock).getTime() })
  t.mock.method(console, 'info', () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(String(url), 'https://places.googleapis.com/v1/places:searchText', 'No paid external endpoint')
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      const data = JSON.parse(body)
      let places
      if (row.places) places = row.places
      else if (searchFixture.snapshots[row.environment]) {
        const saved = searchFixture.snapshots[row.environment]
        places = Array.from({ length: Math.min(20, saved.length) }, (_, offset) => saved[(current.calls.length * 20 + offset) % saved.length])
      } else {
        const ids = extraResponses[data.textQuery] ?? searchFixture.responses[row.environment][data.textQuery]
        assert.ok(ids, `Unmapped fixed query: ${data.textQuery}`)
        places = ids.map(id => searchFixture.places[row.environment][id])
      }
      assert.ok(places.length <= data.maxResultCount)
      current.calls.push({ phase: current.phase, body: data, mask: options.headers['x-goog-fieldmask'], returnedPlaceIds: places.map(p => p.id) })
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify({ places })))
      res.emit('end')
    })
    return req
  })
  return async (api, profile) => {
    current = { calls: [], plans: [], pools: [], phase: 'initial' }
    const pool = await api.getNearbyPlaceCandidates({ input: structuredClone(row.input) }, {
      recordQueryPlan(plan) { current.phase = plan.phase; current.plans.push(plan) },
      recordQueryResult() {}, recordCandidatePool(snapshot) { current.pools.push(snapshot) },
    }, { preferenceProfile: profile })
    const calls = current.calls
    return { pool, plans: current.plans, debugPools: current.pools, requests: calls,
      facts: candidateFacts(pool), summary: {
        calls: calls.length, initialCalls: calls.filter(c => c.phase === 'initial').length,
        gapCalls: calls.filter(c => c.phase === 'gap').length, gapRounds: current.plans.filter(p => p.phase === 'gap').length,
        rawUnique: new Set(calls.flatMap(c => c.returnedPlaceIds)).size,
        ...searchSummary(api, pool, row.input),
      } }
  }
}
