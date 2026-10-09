import test from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_NOW, mockMatrix, metrics } from './fixtures/supplement-quality.mjs'
import { finalQualityFixture } from './fixtures/supplement-final-quality.mjs'
import { getRequiredMealWindows, isStopAlignedWithMealWindow } from '../../api/_lib/trip-planning-rules.ts'
import { getEstimatedArrivalMinutesForStop } from '../../api/_lib/trip-timeline.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const { repairPlanForDelivery, getDeliveryPlanIssues } = await import('../../api/generate-trip.ts')

async function run(t, name, delay = 0) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = finalQualityFixture(name)
  const calls = mockMatrix(t, f, delay)
  const start = performance.now()
  const result = await repairPlanForDelivery(f.plan, f.input, f.candidates)
  const issues = await getDeliveryPlanIssues(result.plan, f.input, `final-quality-${name}`, { candidates: f.candidates })
  const row = metrics(f, result, issues, calls)
  t.diagnostic(JSON.stringify({ name, ...row, issues, waves: calls.stats.waves,
    elapsedMs: performance.now() - start, legs: calls }))
  return { f, result, row, calls, issues }
}

function assertMeals(f, plan) {
  for (const window of getRequiredMealWindows(f.input)) assert.ok(plan.stops.some((stop, i) =>
    stop.type === 'food' && isStopAlignedWithMealWindow(
      getEstimatedArrivalMinutesForStop(plan.stops, i, f.input, plan.transportSegments), stop.duration, window)))
}

test('Meinong gap of eight minutes: full repair adds lunch without pavilion or forty-minute loss', async t => {
  const { f, result, row, calls } = await run(t, 'meinong', 5)
  // v1, measured on this same matrix: A/meal/near/B/C, stay290/travel10, loss40, nine calls/three waves.
  assert.deepEqual(row.selected, ['A', 'meal', 'B', 'C'].map(f.id))
  assert.deepEqual([row.stay, row.travel, row.originalLoss, row.valid], [270, 8, 0, true])
  assert.equal(calls.length, 6)
  assert.equal(calls.stats.waves, 2)
  assertMeals(f, result.plan)
})

test('reasonable extension reaches minimum before a low-value extra activity', async t => {
  const { f, row } = await run(t, 'extension')
  // v1: added pavilion, stay285/travel9, five calls. Here only eight activity minutes are needed.
  assert.deepEqual(row.selected, ['A', 'B', 'C'].map(f.id))
  assert.deepEqual([row.stay, row.travel, row.originalLoss, row.valid, row.routeCalls], [218, 7, 0, true, 2])
})

test('activities already at reasonable maxima can still receive a necessary new stop', async t => {
  const { f, row } = await run(t, 'no-room')
  assert.deepEqual(row.selected, ['A', 'near', 'B', 'C'].map(f.id))
  assert.deepEqual([row.stay, row.travel, row.originalLoss, row.valid], [345, 9, 0, true])
})

test('meal position comparison avoids the former 43-minute original loss on a long meal route', async t => {
  const { f, result, row } = await run(t, 'meal-route-growth')
  // v1: loss76 including a pavilion. The actual required meal route alone still needs loss43.
  assert.deepEqual(row.selected, ['A', 'B', 'meal', 'C'].map(f.id))
  assert.deepEqual([row.stay, row.travel, row.originalLoss, row.valid], [270, 10, 0, true])
  assertMeals(f, result.plan)
})

test('a formerly accepted 16:30 dinner cannot force unreasonable stays to satisfy the new start rule', async t => {
  const { f, result, row, calls } = await run(t, 'post-route-growth')
  assert.equal(row.valid, false)
  assert.equal(row.originalLoss, 0)
  assert.ok(!row.selected.includes(f.id('near')))
  assert.equal(calls.length, new Set(calls).size)
  assert.ok(getRequiredMealCoverageIssues(result.plan, f.input).length > 0)
})

test('full repair still deletes an original when minimum stays cannot fit the real route', async t => {
  const { f, result, row } = await run(t, 'required-deletion')
  assert.ok(row.valid)
  assert.ok(row.selected.length < f.plan.stops.length)
  assert.ok(row.originalLoss >= 40)
  assert.equal(row.selected[0], f.plan.stops[0].placeId)
  assertMeals(f, result.plan)
})

for (const name of ['night', 'long', 'sparse']) test(`complete repair retains valid ${name} delivery`, async t => {
  const { f, result, row } = await run(t, name)
  assert.ok(row.valid)
  assert.equal(row.originalLoss, 0)
  assertMeals(f, result.plan)
})

test('failed real routes remain explicitly failed throughout full repair', async t => {
  const { result, row } = await run(t, 'failure')
  assert.ok(result.routesFailed)
  assert.equal(row.valid, false)
  assert.ok(result.plan.transportSegments.every(segment => segment.label.includes('(估算)')))
})
