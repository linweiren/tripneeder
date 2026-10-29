import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { getPlanActualDuration, getMinimumStopDuration } from '../../api/_lib/trip-plan-metrics.ts'
import { getRequiredMealWindows, isStopAlignedWithMealWindow } from '../../api/_lib/trip-planning-rules.ts'
import { getEstimatedPlanArrivalMinutes } from '../../api/_lib/trip-timeline.ts'

// Mock the existing HTTP boundary; production repair and validation run unchanged.
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const {
  expandStopsForLongTrip, realignFoodStopsForMealWindows, ensureMealStopForTrip,
  repairPlanForDelivery, trimPlanToTimeWindow, getDeliveryPlanIssues,
  realignPlanMealsAfterTiming,
  getFirstStopDistanceIssue, pickSoftDiverseCandidate,
} = await import('../../api/generate-trip.ts')

let fixtureId = 0
function input(tags = []) {
  return { startTime: '10:00', endTime: '15:00', tags, location: { name: '中央公園' }, transportMode: 'scooter' }
}
function stop(type, duration) {
  const id = `convergence-${++fixtureId}`
  return { id, placeId: id, name: id, address: `${id} address`, description: '', type, duration,
    googleMapsUrl: `https://example.com/${id}`, lat: 22.6 + fixtureId / 10000, lng: 120.3 }
}
function plan(stops, travel = []) {
  return { id: 'explore', type: 'explore', title: '', subtitle: '', summary: '', budget: 0,
    transportMode: 'scooter', totalTime: 0, stops, rainBackup: [], rainTransportSegments: [],
    transportSegments: travel.map((duration, i) => ({ fromStopId: stops[i].id, toStopId: stops[i + 1].id,
      duration, mode: 'scooter', label: '' })) }
}
function candidate(s, distanceKm = 1, closes = 24 * 60) {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return { ...s, distanceKm, score: 90, role: s.type === 'food' ? 'food' : 'main_activity',
    openingHours: { isKnown: true, utcOffsetMinutes: 0, windows: [{
      openAt: new Date(midnight), closeAt: new Date(midnight + closes * 60000),
    }] } }
}
function pool(stops, extras = []) {
  const allCandidates = [...stops.map((s) => candidate(s)), ...extras]
  return { allCandidates, otherCandidates: allCandidates, firstStopCandidates: allCandidates }
}
function mockGoogle(t, routeMinutes = 20, places = new Map()) {
  let routeCalls = 0
  t.mock.method(https, 'request', (url, _options, callback) => {
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = () => {}
    req.destroy = (error) => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      let payload
      if (String(url).includes('routes.googleapis.com')) {
        routeCalls++
        const minutes = typeof routeMinutes === 'function' ? routeMinutes(routeCalls) : routeMinutes
        payload = { routes: [{ duration: `${minutes * 60}s`, distanceMeters: 1000 }] }
      } else {
        const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
        payload = places.get(id) ?? googlePlace(id)
      }
      res.emit('data', Buffer.from(JSON.stringify(payload)))
      res.emit('end')
    })
    return req
  })
  return () => routeCalls
}
function googlePlace(id, closeHour = 24) {
  return { id, displayName: { text: id }, formattedAddress: `${id} address`, utcOffsetMinutes: 0,
    regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 0, minute: 0 }, close: { day: (day + (closeHour === 24 ? 1 : 0)) % 7,
        hour: closeHour % 24, minute: 0 },
    })) } }
}
async function expand(p, tripInput, candidates) {
  const result = await expandStopsForLongTrip(p.stops, tripInput, candidates, new Set(p.stops.map((s) => s.placeId)),
    p.id, new Set(), p.transportSegments, p.transportMode)
  return result.stops
}

test('coverage uses current stays and route instead of defaults and 18-minute legs', async () => {
  const p = plan([stop('main_activity', 120), stop('food', 60), stop('ending_or_transition', 60)], [20, 20])
  assert.equal(getPlanActualDuration(p), 280)
  assert.deepEqual(await expand(p, input(), pool(p.stops, [candidate(stop('main_activity', 75))])), p.stops)
})

test('overflow and missing or stale route data never trigger supplemental refill', async () => {
  const p = plan([stop('main_activity', 120), stop('food', 60), stop('ending_or_transition', 60)], [40, 40])
  const candidates = pool(p.stops, [candidate(stop('main_activity', 75))])
  assert.deepEqual(await expand(p, input(), candidates), p.stops)
  p.stops.forEach((s) => { s.duration = getMinimumStopDuration(s) })
  assert.deepEqual(await expand({ ...p, transportSegments: [] }, input(), candidates), p.stops)
  assert.deepEqual(await expand({ ...p, transportSegments: p.transportSegments.map((s) => ({ ...s, toStopId: 'stale' })) }, input(), candidates), p.stops)
  assert.deepEqual(await expand({ ...p, transportSegments: p.transportSegments.map((s) => ({ ...s, label: '(估算)' })) }, input(), candidates), p.stops)
})

test('reaching coverage overrides the former minimum stop-count expansion', async () => {
  const p = plan([stop('main_activity', 140), stop('food', 100)], [40])
  assert.deepEqual(await expand(p, input(), pool(p.stops, [candidate(stop('main_activity', 75))])), p.stops)
})

test('supplemental expansion fits the newcomer without overflowing or shortening originals', async (t) => {
  const calls = mockGoogle(t, 100)
  const p = plan([stop('main_activity', 80), stop('food', 45)], [20])
  const extras = [candidate(stop('main_activity', 75)), candidate(stop('main_activity', 75))]
  const result = await expandStopsForLongTrip(p.stops, input(), pool(p.stops, extras),
    new Set(p.stops.map((s) => s.placeId)), p.id, new Set(), p.transportSegments, p.transportMode)
  assert.equal(result.stops.length, 3)
  assert.ok(calls() <= 8)
  assert.ok(getPlanActualDuration({ ...p, stops: result.stops, transportSegments: result.segments }) <= 300)
  for (const original of p.stops) {
    assert.equal(result.stops.find(s => s.id === original.id)?.duration, original.duration)
  }
  assert.ok(result.stops.every(s => s.duration >= getMinimumStopDuration(s)))
})

test('a plan that starts overflowing repairs capacity without adding activity or food stops', async (t) => {
  const calls = mockGoogle(t, 35)
  const p = plan([stop('main_activity', 120), stop('ending_or_transition', 60), stop('food', 60)], [35, 35])
  const candidates = pool(p.stops, [candidate(stop('main_activity', 75)), candidate(stop('food', 60))])
  const result = await repairPlanForDelivery(p, input(), candidates)
  assert.ok(result.plan.stops.every((s) => p.stops.some((original) => original.id === s.id)))
  assert.ok(getPlanActualDuration(result.plan) <= 300)
  assert.ok(calls() <= 12)
})

test('repeated meal alignment keeps food order and reaches a fixed point', () => {
  const stops = [stop('main_activity', 120), stop('main_activity', 40), stop('food', 45), stop('food', 45)]
  const once = realignFoodStopsForMealWindows(stops, input())
  const twice = realignFoodStopsForMealWindows(once, input())
  const third = realignFoodStopsForMealWindows(twice, input())
  assert.deepEqual(twice, once)
  assert.deepEqual(third, once)
  assert.deepEqual(once.filter((s) => s.type === 'food'), stops.filter((s) => s.type === 'food'))
})

test('existing food is aligned before deciding to add another meal', () => {
  const stops = [stop('main_activity', 100), stop('main_activity', 80), stop('food', 60)]
  const result = ensureMealStopForTrip(stops, input(), pool(stops, [candidate(stop('food', 60))]),
    new Set(stops.map((s) => s.placeId)))
  assert.equal(result.filter((s) => s.type === 'food').length, 1)
})

test('route growth after meal realignment gets a final capacity repair', async (t) => {
  const calls = mockGoogle(t, (call) => call <= 2 ? 20 : 50)
  const p = plan([stop('main_activity', 40), stop('food', 45), stop('main_activity', 40)], [20, 20])
  const result = await repairPlanForDelivery(p, input(), pool(p.stops))
  assert.ok(calls() >= 2)
  assert.ok(getPlanActualDuration(result.plan) <= 300)
  assert.ok(result.plan.stops.every((s) => s.duration >= getMinimumStopDuration(s)))
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, input(), 'unit-route-growth', { candidates: pool(p.stops) }), [])
})

test('meal reroute that increases actual travel repairs capacity immediately', async (t) => {
  const calls = mockGoogle(t, 50)
  const p = plan([stop('main_activity', 100), stop('main_activity', 60), stop('food', 60)], [40, 40])
  assert.equal(getPlanActualDuration(p), 300)
  const result = await realignPlanMealsAfterTiming(p, input())
  assert.equal(calls(), 2)
  assert.equal(result.plan.transportSegments.reduce((sum, s) => sum + s.duration, 0), 100)
  assert.notDeepEqual(result.plan.stops.map((s) => s.id), p.stops.map((s) => s.id))
  assert.ok(getPlanActualDuration(result.plan) <= 300)
  assert.ok(result.plan.stops.every((s) => s.duration >= getMinimumStopDuration(s)))
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, input(), 'unit-meal-reroute'), [])
})

test('minimum-duration overflow removes a non-food stop when the tail is a required meal', async (t) => {
  const calls = mockGoogle(t, 28)
  const stops = [stop('main_activity', 40), stop('main_activity', 40), stop('main_activity', 40),
    stop('main_activity', 40), stop('food', 45)]
  const p = plan(stops, [35, 35, 35, 35])
  const { plan: result } = await trimPlanToTimeWindow(p, input())
  assert.ok(getPlanActualDuration(result) <= 300)
  assert.equal(result.stops[0].id, stops[0].id)
  assert.ok(result.stops.some((s) => s.type === 'food'))
  assert.ok(result.stops.every((s) => s.duration >= getMinimumStopDuration(s)))
  assert.ok(calls() <= 20)
})

test('deletion can stretch remaining stays to coverage without refilling stops', async (t) => {
  const calls = mockGoogle(t, 28)
  const stops = [stop('main_activity', 40), stop('food', 45), stop('main_activity', 40),
    stop('main_activity', 40), stop('food', 45)]
  const p = plan(stops, [28, 28, 28, 28])
  const candidates = pool(stops, [candidate(stop('main_activity', 75)), candidate(stop('food', 60))])
  const result = await repairPlanForDelivery(p, input(), candidates)
  assert.ok(result.plan.stops.length < stops.length)
  assert.ok(result.plan.stops.every((s) => stops.some((original) => original.id === s.id)))
  assert.ok(getPlanActualDuration(result.plan) <= 300)
  assert.ok(calls() <= 80)
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, input(), 'unit-after-deletion', { candidates }), [])
})

test('safe deletion preserves both required meal windows and first stop', async (t) => {
  mockGoogle(t, 10)
  const tripInput = { ...input(), startTime: '10:00', endTime: '20:00' }
  const stops = [stop('main_activity', 80), stop('food', 60), stop('main_activity', 290),
    stop('main_activity', 40), stop('food', 45), stop('main_activity', 40)]
  const { plan: result } = await trimPlanToTimeWindow(plan(stops, [15, 15, 15, 15, 15]), tripInput)
  assert.equal(result.stops[0].id, stops[0].id)
  assert.ok(result.stops.length < stops.length)
  assert.ok(getPlanActualDuration(result) <= 600)
  const arrivals = getEstimatedPlanArrivalMinutes(result, tripInput)
  for (const window of getRequiredMealWindows(tripInput)) {
    assert.ok(result.stops.some((s, i) => s.type === 'food' && isStopAlignedWithMealWindow(arrivals[i], s.duration, window)))
  }
  assert.deepEqual(await getDeliveryPlanIssues(result, tripInput, 'unit-two-meal-deletion'), [])
})

test('deletion refuses to lose a required meal when no remaining order covers both windows', async (t) => {
  mockGoogle(t, 10)
  const tripInput = { ...input(), startTime: '10:00', endTime: '20:00' }
  const stops = [stop('main_activity', 70), stop('food', 60), stop('main_activity', 270), stop('food', 160)]
  const { plan: result } = await trimPlanToTimeWindow(plan(stops, [20, 20, 20]), tripInput)
  assert.deepEqual(result.stops, stops)
  assert.equal(result.stops[0].id, stops[0].id)
  const arrivals = getEstimatedPlanArrivalMinutes(result, tripInput)
  for (const window of getRequiredMealWindows(tripInput)) {
    assert.ok(result.stops.some((s, i) => s.type === 'food' && isStopAlignedWithMealWindow(arrivals[i], s.duration, window)))
  }
  assert.ok((await getDeliveryPlanIssues(result, tripInput, 'unit-no-safe-deletion')).some((issue) => issue.includes('超出可安排時間')))
})

test('first-stop gate still rejects distant food after alignment', async (t) => {
  mockGoogle(t)
  const food = stop('food', 120)
  const p = plan([food, stop('main_activity', 120)], [20])
  const candidates = pool(p.stops)
  candidates.allCandidates[0].distanceKm = 2.5
  assert.equal(getFirstStopDistanceIssue(p, input(), candidates)?.reason, 'first_stop_too_far')
  assert.ok((await getDeliveryPlanIssues(p, input(), 'unit-food-first', { candidates })).some((issue) => issue.includes('2.5km')))
})

test('final validation retains unknown hours, closing buffer, minimum stays, and capacity rejection', async (t) => {
  const unknown = stop('main_activity', 120)
  const closing = stop('food', 60)
  const p = plan([unknown, closing, stop('main_activity', 60)], [20, 20])
  mockGoogle(t, 20, new Map([[unknown.placeId, { ...googlePlace(unknown.placeId), regularOpeningHours: undefined }],
    [closing.placeId, googlePlace(closing.placeId, 13)]]))
  const issues = await getDeliveryPlanIssues(p, input(), 'unit-hours', { candidates: pool(p.stops) })
  assert.ok(issues.some((issue) => issue.includes('營業時間未知')))
  assert.ok(issues.some((issue) => issue.includes('營業時間內')))
  const tooShort = plan([stop('main_activity', 39), stop('food', 45)], [20])
  assert.ok((await getDeliveryPlanIssues(tooShort, input(), 'unit-minimum')).some((issue) => issue.includes('停留時間過短')))
  const overflow = plan([stop('main_activity', 160), stop('food', 160)], [20])
  assert.ok((await getDeliveryPlanIssues(overflow, input(), 'unit-overflow')).some((issue) => issue.includes('超出可安排時間')))
})

test('unrepairable minimum-duration travel overflow remains rejected', async (t) => {
  mockGoogle(t, 280)
  const p = plan([stop('main_activity', 40), stop('food', 45)], [280])
  const result = await repairPlanForDelivery(p, input(), pool(p.stops))
  assert.equal(result.plan.stops.length, 2)
  assert.ok((await getDeliveryPlanIssues(result.plan, input(), 'unit-unrepairable')).some((issue) => issue.includes('超出可安排時間')))
})

test('all three plans retain soft diversity with candidate reuse', () => {
  const only = candidate(stop('main_activity', 75))
  for (const id of ['safe', 'balanced', 'explore']) {
    assert.equal(pickSoftDiverseCandidate([only], new Set([only.placeId]))?.placeId, only.placeId, id)
  }
})
