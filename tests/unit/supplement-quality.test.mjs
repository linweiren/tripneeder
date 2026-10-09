import test from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_NOW, BASELINE, fixture, mockMatrix, metrics } from './fixtures/supplement-quality.mjs'
import { SUPPLEMENT_ROUTE_BUDGET } from '../../api/_lib/trip-supplement-quality.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const { repairPlanForDelivery, getDeliveryPlanIssues, expandStopsForLongTrip, selectSupplementalCandidate } =
  await import('../../api/generate-trip.ts')

const expected = {
  city: { selected: ['A', 'near', 'B'], stay: 240, travel: 25 },
  'valuable-far': { selected: ['A', 'far', 'B'], stay: 200, travel: 80 },
  'explore-seventh': { selected: ['A', 'rank-1', 'B'], stay: 240, travel: 25 },
  position: { selected: ['A', 'B', 'C'], stay: 205, travel: 20 },
  compression: { selected: ['A', 'near', 'B'], stay: 240, travel: 25 },
  deletion: { selected: ['A', 'near', 'B'], stay: 240, travel: 25 },
  'legal-gap': { selected: ['A', 'B'], stay: 220, travel: 10 },
  'routes-failure': { selected: ['A', 'B'], stay: 180, travel: 13 },
  diversity: { selected: ['A', 'unused', 'B'], stay: 240, travel: 25 },
  reuse: { selected: ['A', 'used', 'B'], stay: 240, travel: 25 },
}

async function expand(f) {
  return expandStopsForLongTrip(f.plan.stops, f.input, f.candidates,
    new Set(f.plan.stops.map(s => s.placeId)), f.plan.id, f.crossPlanUsed,
    f.plan.transportSegments, f.plan.transportMode)
}

for (const name of ['city', 'valuable-far', 'explore-seventh', 'position', 'compression',
  'deletion', 'legal-gap', 'routes-failure', 'diversity', 'reuse']) {
  test(`fixed route matrix: ${name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
    const f = fixture(name)
    const calls = mockMatrix(t, f)
    const result = await repairPlanForDelivery(f.plan, f.input, f.candidates, new Set(), {
      allowCoverageRepair: name !== 'legal-gap', crossPlanUsedPlaceIds: f.crossPlanUsed,
    })
    const issues = await getDeliveryPlanIssues(result.plan, f.input, 'quality-fixture', { candidates: f.candidates })
    const row = metrics(f, result, issues, calls)
    t.diagnostic(JSON.stringify({ name, before: BASELINE[name], after: row, networkWaves: calls.stats.waves }))
    assert.deepEqual(row.selected, expected[name].selected)
    assert.equal(row.stay, expected[name].stay)
    assert.equal(row.travel, expected[name].travel)
    assert.equal(row.originalLoss, 0)
    assert.equal(row.valid, BASELINE[name].valid)
    assert.ok(row.routeCalls <= f.plan.transportSegments.length + SUPPLEMENT_ROUTE_BUDGET.perPlan)
    assert.ok(calls.stats.peak <= SUPPLEMENT_ROUTE_BUDGET.perRound)
    for (const original of f.plan.stops) {
      assert.ok(result.plan.stops.some(s => s.placeId === original.placeId))
    }
  })
}

test('three styles diversify comparable choices and safely reuse when exhausted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const crossPlanUsed = new Set()
  const selections = []
  for (const id of ['safe', 'balanced', 'explore']) {
    const f = fixture('diversity')
    f.plan.id = id
    f.plan.type = id
    f.crossPlanUsed = crossPlanUsed
    const calls = mockMatrix(t, f)
    const result = await expand(f)
    const added = result.stops.find(s => !f.plan.stops.some(old => old.placeId === s.placeId))
    selections.push(added.placeId)
    crossPlanUsed.add(added.placeId)
    assert.ok(calls.length <= SUPPLEMENT_ROUTE_BUDGET.perRound)
    assert.equal(result.routesFailed, false)
    t.mock.restoreAll()
  }
  assert.deepEqual(selections, ['used', 'unused', 'used'])
})

test('legal minimum coverage does not expand toward target even through expansion entry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('legal-gap')
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops, f.plan.stops)
  assert.equal(calls.length, 0)
})

test('missing, stale, estimated or non-finite route data never establishes spare capacity', async t => {
  const f = fixture('city')
  const calls = mockMatrix(t, f)
  for (const segments of [[], [{ ...f.plan.transportSegments[0], label: '(估算)' }],
    [{ ...f.plan.transportSegments[0], toStopId: 'wrong' }],
    [{ ...f.plan.transportSegments[0], duration: NaN }]]) {
    const result = await expand({ ...f, plan: { ...f.plan, transportSegments: segments } })
    assert.deepEqual(result.stops, f.plan.stops)
  }
  assert.equal(calls.length, 0)
})

test('failed candidate routes are not replaced by estimates or retried through memo', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('city')
  f.routes = { 'A>B': 10 }
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops, f.plan.stops)
  assert.equal(result.routesFailed, true)
  assert.equal(new Set(calls).size, calls.length)
  assert.ok(calls.length <= SUPPLEMENT_ROUTE_BUDGET.perRound)
})

test('unknown candidate hours reject before spending Routes budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('city')
  f.extras.forEach(c => { c.openingHours.isKnown = false })
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops, f.plan.stops)
  assert.equal(calls.length, 0)
})

test('appending preserves downstream closing buffer when earlier insertion would break it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('position')
  f.plan.stops[2].openingHours = { ...f.plan.stops[2].openingHours,
    windows: [{ openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 14 * 3600000) }] }
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops.map(s => s.placeId), ['A', 'B', 'C', 'near'])
  assert.equal(result.stops.at(-1).duration, 65)
  assert.deepEqual(result.stops.slice(0, 3), f.plan.stops)
  assert.ok(calls.length <= 4)
})

test('existing lunch remains aligned; valid tail insertion wins over disruptive middle', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('position')
  f.input.tags = []
  f.plan.stops[0].duration = 90
  f.plan.stops[1].duration = 45
  f.plan.stops[2].duration = 45
  f.plan.stops[1].type = 'food'
  f.plan.stops[1].role = 'food'
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops.map(s => s.placeId), ['A', 'B', 'C', 'near'])
  assert.ok(calls.length <= 4)
})

test('comparison budget is per round and per plan; exhaustion leaves final validation authoritative', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('explore-seventh')
  f.input.endTime = '08:00'
  f.extras = Array.from({ length: 20 }, (_, i) => ({ ...f.extras[0],
    id: `budget-${i}`, placeId: `budget-${i}`, name: `budget-${i}`, score: 100, lat: 22.61 + i * 0.001 }))
  f.candidates.allCandidates = [...f.plan.stops, ...f.extras]
  f.candidates.otherCandidates = f.candidates.allCandidates
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 15
  }
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.equal(calls.length, SUPPLEMENT_ROUTE_BUDGET.perPlan)
  assert.ok(calls.stats.peak <= SUPPLEMENT_ROUTE_BUDGET.perRound)
  assert.equal(new Set(calls).size, calls.length)
  for (const s of f.plan.stops) assert.equal(result.stops.find(next => next.id === s.id).duration, s.duration)
  const issues = await getDeliveryPlanIssues({ ...f.plan, stops: result.stops, transportSegments: result.segments },
    f.input, 'quality-budget', { candidates: f.candidates })
  assert.ok(issues.some(issue => issue.includes('行程時長不足')))
})

test('unselected route failures do not invalidate a fully routed successful alternative', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('city')
  delete f.routes['A>far']
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops.map(s => s.placeId), ['A', 'near', 'B'])
  assert.equal(result.routesFailed, false)
  assert.ok(result.segments.every(s => !s.label.includes('(估算)')))
  assert.ok(calls.length <= SUPPLEMENT_ROUTE_BUDGET.perRound)
})

test('clearly weaker candidate is a bounded fallback when the high-value routes fail', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('valuable-far')
  delete f.routes['A>far']
  delete f.routes['B>far']
  const calls = mockMatrix(t, f)
  const result = await expand(f)
  assert.deepEqual(result.stops.map(s => s.placeId), ['A', 'near', 'B'])
  assert.equal(result.routesFailed, false)
  assert.ok(calls.length <= SUPPLEMENT_ROUTE_BUDGET.perRound)
})

test('standalone supplemental picker uses final score instead of style offset', t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('explore-seventh')
  assert.equal(selectSupplementalCandidate(f.extras, new Set(), 12 * 60, 6).placeId, 'rank-1')
})

test('food first stop remains unchanged and its 2km final gate still rejects', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('city')
  Object.assign(f.plan.stops[0], { type: 'food', role: 'food', distanceKm: 2.5 })
  mockMatrix(t, f)
  const result = await expand(f)
  assert.equal(result.stops[0], f.plan.stops[0])
  const issues = await getDeliveryPlanIssues({ ...f.plan, stops: result.stops, transportSegments: result.segments },
    f.input, 'quality-first-stop', { candidates: f.candidates })
  assert.ok(issues.some(issue => issue.includes('2.5km')))
})

test('memo and parallel comparison retain two network waves with controlled 5ms routes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('city')
  const calls = mockMatrix(t, f, 5)
  const start = performance.now()
  const result = await repairPlanForDelivery(f.plan, f.input, f.candidates)
  t.diagnostic(JSON.stringify({ mockRouteDelayMs: 5, elapsedMs: performance.now() - start,
    networkWaves: calls.stats.waves, calls: calls.length, peak: calls.stats.peak }))
  assert.equal(calls.stats.waves, 2)
  assert.equal(calls.filter(key => key === 'A>B').length, 1)
  assert.deepEqual(result.plan.stops.map(s => s.placeId), ['A', 'near', 'B'])
})
