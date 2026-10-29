import https from 'node:https'
import { createHash } from 'node:crypto'
import { fixture, mockMatrix, FIXED_NOW } from './supplement-quality.mjs'

export function durationReplayDigest(value) {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  return createHash('sha256').update(canonical).digest('hex')
}

// Controlled copies of the 2026-10-17 investigation matrix, not recovered AI JSON.
// Reuse the tracked clock/Places/Routes fixture; never read local investigation files.
export function durationQualityFixture(kind = 'pressure', style = 'explore') {
  const f = fixture('legal-gap'), base = f.plan.stops[0]
  f.input = { ...f.input, category: 'other', customCategory: '文化景點＋咖啡廳', tags: [] }
  const make = (id, name, duration, types, role = 'main_activity') => ({
    ...structuredClone(base), id, placeId: id, name, duration, types, googleTypes: types,
    role, candidateRole: role, type: role === 'food' ? 'food' : 'main_activity', description: '',
    address: 'fixture address', score: 100, availabilitySlots: ['early', 'middle', 'late'],
    foodSubtype: role === 'food' ? (types.includes('cafe') ? 'cafe' : 'restaurant') : undefined,
  })
  const museum = make('museum', '地方文物館', 90, ['museum'])
  const cafe = make('cafe', '咖啡廳', 45, ['cafe'], 'food')
  const bay = make('bay', '愛河灣', 150, ['natural_feature', 'tourist_attraction'], 'open_space')
  const gallery = make('gallery', '地方藝術館', 60, ['art_gallery'])
  if (kind === 'insufficient-excess') gallery.duration = 100
  let stops = [museum, cafe, bay, gallery], extra = [], start = '10:00', leg = 4
  if (kind.startsWith('fallback')) extra = [make('river', '愛河', 90, ['natural_feature'], 'open_space')]
  if (kind === 'slow') [museum.duration, cafe.duration, bay.duration, gallery.duration] = [75, 45, 123, 45]
  if (kind === 'two-stop') { stops = [cafe, bay]; start = '11:00'; leg = 9 }
  if (kind === 'meal') {
    stops = [make('dome', '光之穹頂', 50, ['tourist_attraction']),
      make('meal', '午餐餐廳', 60, ['restaurant'], 'food'),
      make('art', '城市光廊', 70, ['park'], 'open_space'), cafe]
    leg = 30
  }
  if (kind === 'unknown-receivers') {
    Object.assign(museum, { name: '城市光廊', types: ['park'], googleTypes: ['park'], role: 'open_space', candidateRole: 'open_space' })
    Object.assign(gallery, { name: '另一個地標', types: ['tourist_attraction'], googleTypes: ['tourist_attraction'] })
  }
  if (kind === 'ambiguous-donor') Object.assign(bay, {
    name: '城市光廊', types: ['park', 'tourist_attraction'], googleTypes: ['park', 'tourist_attraction'],
  })
  if (kind === 'outdoor-request') f.input.customCategory = '想去文化景點＋戶外景點'
  if (kind === 'late-lunch') { f.input.startTime = start = '11:30'; f.input.endTime = '16:30' }
  const prefix = `${kind}-${style}`
  const all = [...stops, ...extra]
  all.forEach((s, i) => Object.assign(s, { id: `${prefix}-${s.id}`, placeId: `${prefix}-${s.placeId}`,
    lat: 22.6 + i * .003, lng: 120.3, distanceKm: i * .333 }))
  f.candidates = { allCandidates: all, firstStopCandidates: all.filter(c => c.distanceKm <= 2), otherCandidates: all }
  f.routes = {}
  for (const a of all) for (const b of all) if (a !== b) f.routes[`${a.placeId}>${b.placeId}`] = leg
  if (kind.startsWith('fallback') && kind !== 'fallback-legal') {
    for (const a of all) for (const b of all) if (a !== b && (a.name === '愛河' || b.name === '愛河')) {
      f.routes[`${a.placeId}>${b.placeId}`] = 20
    }
  }
  if (kind === 'meal') [5, 9, 3].forEach((n, i) => { f.routes[`${stops[i].placeId}>${stops[i + 1].placeId}`] = n })
  const mode = kind === 'transit' ? 'public_transit' : kind === 'car' ? 'car' : 'scooter'
  f.plan = { ...f.plan, id: style, type: style, title: `原始${style}`, subtitle: '保持原風格', summary: '保留摘要',
    scheduleStartTime: start, transportMode: mode, stops: structuredClone(stops),
    transportSegments: stops.slice(1).map((s, i) => ({ fromStopId: stops[i].id, toStopId: s.id,
      mode, label: 'fixture', duration: f.routes[`${stops[i].placeId}>${s.placeId}`] })) }
  f.plan.totalTime = stops.reduce((n, s) => n + s.duration, 0) + f.plan.transportSegments.reduce((n, s) => n + s.duration, 0)
  f.placeOverrides = Object.fromEntries(all.map(c => [c.placeId, { displayName: { text: c.name }, types: c.types }]))
  if (kind === 'early-close' || kind === 'fallback-early-close') {
    // The existing final gate sees more recent Details than candidate search.
    f.placeOverrides[museum.placeId].regularOpeningHours = { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 0, minute: 0 }, close: { day, hour: 11, minute: 50 },
    })) }
  }
  f.crossPlanUsed = kind.startsWith('fallback') ? new Set([bay.placeId]) : new Set()
  f.failRoutes = kind === 'route-failure'
  return f
}

export function mockDurationQuality(t, f) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  for (const key of ['info', 'warn', 'debug', 'error']) t.mock.method(console, key, () => {})
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No live fetch allowed') })
  const legs = mockMatrix(t, f), counts = { places: 0, routes: 0, ai: 0 }, routeRequests = []
  const request = https.request
  t.mock.method(https, 'request', function (url, ...args) {
    const host = new URL(url).hostname
    if (host === 'places.googleapis.com') counts.places++
    else if (host === 'routes.googleapis.com') counts.routes++
    else throw new Error(`Unexpected host: ${host}`)
    const req = request.call(this, url, ...args)
    if (host === 'routes.googleapis.com') {
      let body = ''
      const write = req.write, end = req.end
      req.write = function (value) { body += value; return write.call(this, value) }
      req.end = function () { routeRequests.push(JSON.parse(body)); return end.call(this) }
    }
    return req
  })
  return { counts, legs, routeRequests }
}
