import https from 'node:https'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { classificationInput, classificationPlace, CLASSIFICATION_NOW } from './candidate-classification.mjs'
import { buildTripPrompt } from '../../../src/services/ai/tripPlanPrompt.ts'

export async function loadQuotaBaseline() {
  const original = execFileSync('git', ['show', '5cf6aaf:api/_lib/google-places.ts'],
    { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) })
  const source = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/_lib/google-places.ts', import.meta.url)).href
      : specifier
    return `from ${quote}${url}${quote}`
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

// Same venue evidence, distances, ratings and pools as the fixed ranking audit.
// No business facts, model responses or route quality are inferred from these fixtures.
export function quotaFixture(kind, tags = []) {
  const make = (id, name, types, distance = 1, rating = 4.5, overrides = {}) =>
    classificationPlace(id, name, types, '高雄市中正路1號', { rating,
      location: { latitude: 22.6 + distance / 111.19492664455873, longitude: 120.3 }, ...overrides })
  const sparse = ['sparse', 'sparse-pure', 'address', 'suburb', 'night', 'night-short', 'illegal', 'default-main'].includes(kind)
  const pure = ['dense-pure', 'sparse-pure', 'address'].includes(kind)
  const cultureDistance = kind === 'suburb' ? 8 : 2.5
  const places = Array.from({ length: sparse ? 3 : 12 }, (_, i) =>
    make(`mixed-anchor-${i}`, `起點咖啡${i}`, ['cafe', 'food']))
  const targets = Array.from({ length: sparse ? 5 : 10 }, (_, i) => make(`mixed-culture-${i}`,
    kind === 'default-main' ? `展示空間${i}` : `城市美術館${String(i).padStart(2, '0')}`,
    kind === 'default-main' ? ['point_of_interest'] : pure ? ['museum']
      : kind === 'dessert-culture' ? ['museum', 'bakery', 'food'] : ['museum', 'cafe', 'food'],
    cultureDistance, 4.7, ['address', 'default-main'].includes(kind) ? { formattedAddress: '高雄市咖啡路1號' } : {}))
  places.push(...targets)
  if (!sparse) places.push(
    ...Array.from({ length: 10 }, (_, i) => make(`plain-culture-${i}`, `歷史博物館${String(i).padStart(2, '0')}`, ['museum'], 2.5, 4.2)),
    ...Array.from({ length: 6 }, (_, i) => make(`mixed-dining-${i}`, `地方餐廳${i}`, ['restaurant', 'food'], 2.5)),
    ...Array.from({ length: 2 }, (_, i) => make(`mixed-park-${i}`, `地方公園${i}`, ['park'], 2.5)),
    ...Array.from({ length: 2 }, (_, i) => make(`mixed-mall-${i}`, `地方商場${i}`, ['shopping_mall'], 2.5)),
    ...Array.from({ length: 2 }, (_, i) => make(`mixed-book-${i}`, `地方書店${i}`, ['book_store'], 2.5, 4.2)),
  )
  if (kind === 'city-near') {
    places.splice(0, places.length,
      ...Array.from({ length: 25 }, (_, i) => make(`city-cafe-${i}`, `連鎖咖啡${String(i).padStart(2, '0')}`, ['cafe', 'food'])),
      ...Array.from({ length: 12 }, (_, i) => make(`city-dining-${i}`, `地方料理餐廳${i}`, ['restaurant', 'food'])),
      ...Array.from({ length: 24 }, (_, i) => make(`mixed-culture-${i}`, `地方博物館${String(i).padStart(2, '0')}`, ['museum', 'cafe', 'food'], 1, 4.7)),
      ...Array.from({ length: 2 }, (_, i) => make(`mixed-park-${i}`, `河濱公園${i}`, ['park'])),
      ...Array.from({ length: 2 }, (_, i) => make(`mixed-mall-${i}`, `地方商場${i}`, ['shopping_mall'])),
      ...Array.from({ length: 2 }, (_, i) => make(`mixed-book-${i}`, `地方書店${i}`, ['book_store'], 1, 4.2)),
    )
  }
  if (kind === 'dining') {
    places.splice(0, places.length, make('first-museum', '起點博物館', ['museum'], 0.5),
      ...Array.from({ length: 15 }, (_, i) => make(`true-cafe-${i}`, `一般咖啡廳${i}`, ['cafe', 'food'], 2.5)),
      ...Array.from({ length: 6 }, (_, i) => make(`true-dining-${i}`, `一般料理餐廳${i}`, ['restaurant', 'food'], 2.5)),
      ...Array.from({ length: 4 }, (_, i) => make(`ambiguous-${i}`, `複合生活空間${i}`, ['museum', 'cafe', 'food'], 2.5)),
      ...Array.from({ length: 3 }, (_, i) => make(`museum-cafe-${i}`, `博物館咖啡廳${i}`, ['museum', 'cafe', 'food'], 2.5)),
    )
  }
  if (kind === 'illegal') {
    places.push(make('closed-culture', '停業博物館', ['museum', 'cafe'], 2.5, 4.9, { businessStatus: 'CLOSED_TEMPORARILY' }),
      make('unknown-culture', '未知時段博物館', ['museum', 'cafe'], 2.5, 4.9, { currentOpeningHours: undefined }),
      make('closing-culture', '快關門博物館', ['museum', 'cafe'], 2.5, 4.9, { currentOpeningHours: { periods: [{
        open: { day: 0, hour: 10, minute: 0, date: { year: 2026, month: 10, day: 4 } },
        close: { day: 0, hour: 11, minute: 0, date: { year: 2026, month: 10, day: 4 } },
      }] } }))
  }
  const input = classificationInput({ tags, ...(kind.startsWith('night')
    ? { startTime: '23:00', endTime: kind === 'night-short' ? '01:00' : '02:00' } : {}) })
  return { kind, input, places }
}

export function mockQuotaSearch(t, places) {
  const requests = []
  t.mock.timers.enable({ apis: ['Date'], now: CLASSIFICATION_NOW })
  t.mock.method(console, 'info', () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  t.mock.method(https, 'request', (url, options, callback) => {
    if (String(url) !== 'https://places.googleapis.com/v1/places:searchText') throw new Error(`Unexpected external request: ${url}`)
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      const data = JSON.parse(body)
      const index = requests.length
      requests.push({ body: data, mask: options.headers['x-goog-fieldmask'] })
      // Return at most the requested 20 records; initial query batches union to
      // the fixed pool. Repeat the same pagination for before and after calls.
      const response = places.length <= data.maxResultCount ? places
        : Array.from({ length: data.maxResultCount }, (_, offset) => places[(index * data.maxResultCount + offset) % places.length])
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify({ places: response })))
      res.emit('end')
    })
    return req
  })
  return requests
}

export function quotaSummary(api, pool, input) {
  const selection = api.getPromptCandidateSelection(pool)
  const ids = new Set(selection.promptCandidates.map(c => c.placeId))
  const uses = selection.promptCandidates.reduce((counts, c) => {
    const key = api.hasConfirmedCulturalPrimaryPurpose(c) ? 'confirmedCulture' : c.role === 'food' ? 'food' : 'other'
    counts[key]++
    return counts
  }, { confirmedCulture: 0, food: 0, other: 0 })
  const candidateBlock = api.formatNearbyRecommendations(pool)
  return { promptCount: ids.size, promptCharacters: candidateBlock.length,
    aiPromptCharacters: buildTripPrompt(input, undefined, candidateBlock).length,
    uses, groups: Object.fromEntries(['nearStops', 'foodStops', 'mainStops', 'fallbackStops'].map(k => [k, selection[k].map(c => c.placeId)])),
    candidates: pool.allCandidates.map((c, i) => ({ name: c.name, placeId: c.placeId, role: c.role,
      foodSubtype: c.foodSubtype, types: c.types, score: c.score, rank: i + 1, distanceKm: c.distanceKm,
      first: pool.firstStopCandidates.some(p => p.placeId === c.placeId),
      confirmedCulture: api.hasConfirmedCulturalPrimaryPurpose(c), sent: ids.has(c.placeId),
      group: ['nearStops', 'foodStops', 'mainStops', 'fallbackStops'].find(k => selection[k].some(p => p.placeId === c.placeId)) ?? null })) }
}
