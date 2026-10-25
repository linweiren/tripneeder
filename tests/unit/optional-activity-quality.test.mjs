import test from 'node:test'
import assert from 'node:assert/strict'
import { replayOptionalActivity } from './fixtures/optional-activity-quality.mjs'
import { FIXED_NOW } from './fixtures/supplement-quality.mjs'
import { assessVisitRequirements } from '../../api/_lib/trip-demand-compliance.ts'
import { getActivityPurpose } from '../../api/_lib/trip-activity-purpose.ts'

Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only',
  TRIP_CANDIDATE_DEBUG: 'false' })
const api = await import('../../api/generate-trip.ts')

async function deliver(t, kind, options) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  for (const key of ['info', 'warn', 'error']) t.mock.method(console, key, () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  const row = await replayOptionalActivity(t, api, kind, options)
  assert.equal(row.metrics.valid, true, JSON.stringify(row.metrics))
  assert.equal(row.calls.length, new Set(row.calls).size, 'full fallback must reuse route evidence')
  assert.ok(row.attempts.filter(phase => phase.includes('diversity-fallback')).length <= 1)
  assert.ok(row.attempts.length <= 3, JSON.stringify(row.attempts))
  assert.equal(row.result.plan.stops.filter(s => s.type === 'food').length, 1)
  t.diagnostic(JSON.stringify(row.metrics))
  return row
}

for (const kind of ['same-purpose', 'ranking-only', 'route-loss', 'route-gain-demand-loss', 'route-gain-shortens-activity']) {
  test(`${kind}: retain a fulfilled distinct museum when diversity has no confirmed improvement`, async t => {
    const { f, result, metrics } = await deliver(t, kind)
    assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
    assert.equal(metrics.requirements[0].fulfillment, 'satisfied')
    assert.equal(metrics.impact.identityChanges, 0)
    assert.equal(result.plan.stops[0].duration, f.plan.stops[0].duration)
    assert.equal(metrics.decisions[0].reason,
      'activity_equivalence_unknown;retain_feasible_fulfilled_original_without_confirmed_gain')
    if (kind === 'same-purpose' || kind === 'ranking-only') {
      const original = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
      const replacement = api.applyCandidateGroundingToPlan({ ...f.plan, stops: [
        { ...f.plan.stops[0], placeId: f.alternative.placeId, name: f.alternative.name },
        ...f.plan.stops.slice(1),
      ] }, f.candidates)
      assert.equal(getActivityPurpose(original.stops[0]), getActivityPurpose(replacement.stops[0]))
      assert.equal(original.stops[0].duration, replacement.stops[0].duration)
      assert.ok(metrics.originalRequirements.length > 0)
      assert.ok(metrics.originalRequirements.every(item => item.fulfillment === 'satisfied'))
      assert.ok(assessVisitRequirements(replacement, f.input, f.candidates)
        .every(item => item.fulfillment === 'satisfied'))
      assert.deepEqual(await api.getDeliveryPlanIssues(replacement, f.input, 'equivalence-unknown',
        { candidates: f.candidates }), [])
      // Equal purpose, fulfillment and stay do not establish experience equivalence.
      assert.equal(metrics.repairAttempts, 2)
      assert.equal(metrics.routeCalls, 3)
      assert.ok(!metrics.decisions.some(item => item.reason.includes('comparison_not_needed')))
    }
  })
}

for (const kind of ['demand-gain', 'route-gain', 'ranking-and-route']) {
  test(`${kind}: keep a replacement with a confirmed demand or route improvement`, async t => {
    const { f, result, metrics } = await deliver(t, kind)
    assert.equal(result.plan.stops[0].placeId, f.alternative.placeId)
    assert.ok(metrics.requirements.every(item => item.fulfillment === 'satisfied'))
    assert.equal(metrics.impact.purposeChanges, 0)
    assert.equal(result.plan.stops[0].duration, 90)
    assert.equal(metrics.decisions[0].phase, 'fallback:activity-diversity-retained')
    assert.equal(metrics.decisions[0].reason, kind === 'demand-gain'
      ? 'confirmed_visit_requirement_gain_with_preserved_purpose_and_stay;comparison_not_needed'
      : 'verified_travel_improvement_with_preserved_demand_purpose_and_stay')
    assert.equal(metrics.repairAttempts, kind === 'demand-gain' ? 1 : 2)
    assert.equal(metrics.routeCalls, kind === 'demand-gain' ? 2 : 3)
  })
}

test('demand gain with lost visit time still requires the full bounded comparison', async t => {
  const { result, metrics } = await deliver(t, 'demand-gain-shortens-activity')
  assert.ok(metrics.requirements.every(item => item.fulfillment === 'satisfied'))
  assert.equal(result.plan.stops[0].duration, 90)
  assert.equal(metrics.repairAttempts, 2)
  assert.equal(metrics.routeCalls, 3)
  assert.equal(metrics.decisions[0].reason, 'preserve_confirmed_visit_requirement_improvement')
})

test('demand gain cannot skip comparison using failed route evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  for (const key of ['info', 'warn', 'error', 'debug']) t.mock.method(console, key, () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  const { result, attempts, transitions } = await replayOptionalActivity(t, api, 'demand-gain-route-failure')
  assert.equal(result.routesFailed, true)
  assert.equal(attempts.filter(phase => phase.includes('diversity-fallback')).length, 1)
  assert.ok(!transitions.some(item => item.reason?.includes('comparison_not_needed')))
})

for (const kind of ['generic', 'unknown', 'closed', 'far-original', 'fallback-route-failure']) {
  test(`${kind}: no automatic original preference or refusal of an executable replacement`, async t => {
    const { f, result, metrics } = await deliver(t, kind)
    assert.equal(result.plan.stops[0].placeId, f.alternative.placeId)
    if (kind === 'unknown') assert.equal(metrics.originalRequirements[0].status, 'unknown')
  })
}

test('three styles may share a fulfilled distinct museum while all remain deliverable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  for (const key of ['info', 'warn', 'error']) t.mock.method(console, key, () => {})
  const used = new Set(), rows = []
  for (const style of ['safe', 'balanced', 'explore']) {
    const row = await replayOptionalActivity(t, api, 'same-purpose', { style, used })
    assert.equal(row.metrics.valid, true, JSON.stringify(row.metrics))
    assert.equal(row.result.plan.stops[0].placeId, row.f.museum.placeId)
    row.result.plan.stops.forEach(stop => used.add(stop.placeId))
    rows.push(row.metrics)
    t.mock.restoreAll()
  }
  t.diagnostic(JSON.stringify(rows))
})
