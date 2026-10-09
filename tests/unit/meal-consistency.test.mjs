import test from 'node:test'
import assert from 'node:assert/strict'
import { mealFixture } from './fixtures/meal-consistency.mjs'
import { FIXED_NOW, mockMatrix, metrics } from './fixtures/supplement-quality.mjs'
import { getRequiredMealWindows, isStopAlignedWithMealWindow } from '../../api/_lib/trip-planning-rules.ts'
import { getEstimatedPlanArrivalMinutes } from '../../api/_lib/trip-timeline.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const { repairAndValidatePlanForDelivery, getDeliveryPlanIssues } = await import('../../api/generate-trip.ts')

async function deliver(t, kind, id = 'balanced', delay = 0, reuse = false) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = mealFixture(kind, id)
  const calls = mockMatrix(t, f, delay)
  const start = performance.now()
  const result = await repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
    new Set(), 'meal-regression', reuse
      ? new Set(f.candidates.allCandidates.filter(stop => stop.type === 'food').map(stop => stop.placeId)) : new Set())
  const issues = result.plan ? await getDeliveryPlanIssues(result.plan, f.input, 'meal-final',
    { candidates: f.candidates }) : result.issues
  const row = result.plan ? metrics(f, result, issues, calls) : { valid: false, routeCalls: calls.length }
  t.diagnostic(JSON.stringify({ kind, id, ...row, issues, elapsedMs: performance.now() - start,
    waves: calls.stats.waves }))
  if (result.plan) {
    assert.equal(result.routesFailed, false)
    assert.deepEqual(issues, [])
    assert.deepEqual(getRequiredMealCoverageIssues(result.plan, f.input), [])
  }
  return { f, result, row, calls, issues }
}

test('Central Park Balanced: reorder existing food instead of adding a second misplaced lunch', async t => {
  const { result, row } = await deliver(t, 'balanced', 'balanced', 5)
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length, 1)
  assert.equal(row.originalLoss, 0)
  assert.equal(result.plan.stops[0].type, 'main_activity')
})

test('Central Park Explore: a legal-coverage plan cannot skip its single required lunch', async t => {
  const { result, row } = await deliver(t, 'explore', 'explore')
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length, 1)
  assert.equal(row.originalLoss, 0)
  assert.ok(row.routeCalls <= 9)
})

for (const kind of ['two-stop', 'one-activity']) test(`existing food realignment works for ${kind}`, async t => {
  const { f, result, row } = await deliver(t, kind)
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length,
    f.plan.stops.filter(stop => stop.type === 'food').length)
  assert.equal(row.originalLoss, 0)
})

test('shifted schedule uses actual start for repair, both meals, and final delivery', async t => {
  const { f, result } = await deliver(t, 'shifted')
  assert.ok(result.plan)
  assert.equal(result.plan.scheduleStartTime, '12:30')
  const arrivals = getEstimatedPlanArrivalMinutes(result.plan, f.input)
  assert.equal(arrivals[0], 12 * 60 + 30)
  for (const window of getRequiredMealWindows({ ...f.input, scheduleStartTime: '12:30' })) {
    assert.ok(result.plan.stops.some((stop, i) => stop.type === 'food' &&
      isStopAlignedWithMealWindow(arrivals[i], stop.duration, window)))
  }
})

test('necessary meal capacity repair remains bounded by original minimum stays', async t => {
  const { f, result, row } = await deliver(t, 'meal-loss')
  assert.ok(result.plan)
  assert.ok(row.originalLoss > 0 && row.originalLoss <= 25)
  assert.ok(result.plan.stops.every(stop => stop.duration >= (stop.type === 'food' ? 45 : 40)))
  assert.ok(f.plan.stops.every(stop => result.plan.stops.some(next => next.id === stop.id)))
})

test('cross-day delivery retains its existing dinner at the real timeline occurrence', async t => {
  const { f, result, row } = await deliver(t, 'overnight-dinner')
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length, 1)
  assert.equal(row.originalLoss, 0)
  assert.deepEqual(getRequiredMealWindows(f.input).map(window => window.id), ['dinner'])
})

test('a legal 45-minute meal is not rejected just because the 60-minute default violates closing buffer', async t => {
  const { result, row } = await deliver(t, 'minimum-food')
  assert.ok(result.plan)
  assert.equal(result.plan.stops.find(stop => stop.type === 'food').duration, 45)
  assert.equal(row.originalLoss, 0)
  assert.ok(row.routeCalls <= 4)
})

for (const kind of ['no-full', 'night', 'outside-window']) test(`${kind} does not force unnecessary meals`, async t => {
  const { result } = await deliver(t, kind)
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length, 0)
})

for (const kind of ['failure', 'meal-route-failure', 'no-candidate', 'unknown-food', 'closing-food']) test(`${kind} safely refuses missing required lunch`, async t => {
  const { result } = await deliver(t, kind)
  assert.equal(result.plan, null)
  assert.ok(result.issues.length)
})

for (const id of ['safe', 'balanced', 'explore']) test(`${id} shares the same meal requirement and can reuse food`, async t => {
  const { result, row } = await deliver(t, 'explore', id, 0, true)
  assert.ok(result.plan)
  assert.equal(row.originalLoss, 0)
})

for (const id of ['safe', 'explore']) test(`${id} also rejects a legal-coverage plan without any meal candidate`, async t => {
  const { result, calls } = await deliver(t, 'no-candidate', id)
  assert.equal(result.plan, null)
  assert.ok(result.issues.some(issue => issue.includes('午餐')))
  assert.equal(calls.length, 1)
})

test('meal requirements use a feasible minimum stay, not a minute of overlap', () => {
  const input = (startTime, endTime, tags = []) => ({ startTime, endTime, tags })
  assert.deepEqual(getRequiredMealWindows(input('10:59', '11:01')), [])
  assert.deepEqual(getRequiredMealWindows(input('12:50', '13:30')), [])
  assert.deepEqual(getRequiredMealWindows(input('12:50', '13:35')).map(w => w.id), ['lunch'])
  assert.deepEqual(getRequiredMealWindows(input('13:00', '15:00')), [])
  assert.deepEqual(getRequiredMealWindows(input('10:00', '15:00', ['no_full_meals'])), [])
  const lunch = getRequiredMealWindows(input('10:00', '15:00'))[0]
  assert.equal(isStopAlignedWithMealWindow(10 * 60 + 59, 60, lunch), false)
  assert.equal(isStopAlignedWithMealWindow(11 * 60, 44, lunch), false)
  assert.equal(isStopAlignedWithMealWindow(11 * 60, 45, lunch), true)
  assert.equal(isStopAlignedWithMealWindow(13 * 60, 45, lunch), false)
})
