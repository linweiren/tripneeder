import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { assertHonestDeliveryChoices } from './paid-generation-regression-contract.mjs'

export function assertWorkingTreeHandler(row) {
  assert.equal(row.handlerSourceSha256, createHash('sha256')
    .update(readFileSync(new URL('../../../api/generate-trip.ts', import.meta.url), 'utf8')).digest('hex'))
}

// Run while the fixture's clock and network mocks are active. In particular,
// opening-hours assertions use the real final gate, never a fabricated pass flag.
export async function assertDemandDelivery(result, fixture) {
  const api = await import('../../../api/generate-trip.ts')
  const demand = await import('../../../api/_lib/trip-demand-compliance.ts')
  const { getPlanActualDuration, getMinimumStopDuration } = await import('../../../api/_lib/trip-plan-metrics.ts')
  const { getRequiredMealCoverageIssues } = await import('../../../api/_lib/trip-quality-rules.ts')
  const { getMinimumRequiredActualMinutes, getScheduleCapacityMinutes } = await import('../../../api/_lib/trip-planning-rules.ts')
  const plans = result.response?.plans ?? []
  assert.ok(plans.length, 'a delivered response must contain lawful plans')
  assert.equal(new Set(plans.map(plan => plan.type)).size, plans.length)
  const assessments = []
  for (const plan of plans) {
    assert.ok(['safe', 'balanced', 'explore'].includes(plan.type))
    assert.equal(plan.id, plan.type)
    assert.equal(new Set(plan.stops.map(stop => stop.placeId)).size, plan.stops.length)
    assert.equal(plan.transportSegments.length, plan.stops.length - 1)
    plan.transportSegments.forEach((leg, i) => {
      assert.equal(leg.fromStopId, plan.stops[i].id)
      assert.equal(leg.toStopId, plan.stops[i + 1].id)
      assert.ok(Number.isFinite(leg.duration) && leg.duration > 0)
    })
    assert.equal(plan.totalTime, getPlanActualDuration(plan))
    assert.ok(plan.totalTime >= getMinimumRequiredActualMinutes(fixture.input))
    assert.ok(plan.totalTime <= getScheduleCapacityMinutes({ ...fixture.input, scheduleStartTime: plan.scheduleStartTime }))
    for (const stop of plan.stops) {
      assert.ok(stop.duration >= getMinimumStopDuration(stop))
      const candidate = fixture.candidates.allCandidates.find(item => item.placeId === stop.placeId)
      if (candidate?.types) assert.deepEqual(stop.googleTypes, candidate.types, 'venue purpose must retain provider evidence')
    }
    assert.deepEqual(getRequiredMealCoverageIssues(plan, fixture.input), [])
    assert.deepEqual(demand.getForbiddenVisitIssues(plan, fixture.input, fixture.candidates), [])
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, fixture.input, 'fixture-demand-contract'), [])
    const requirements = demand.assessVisitRequirements(plan, fixture.input)
    for (const requirement of requirements) {
      assert.equal(requirement.otherOptionsAvailability, 'unknown')
      if (requirement.fulfillment !== 'satisfied') {
        assert.ok(result.response.warnings?.some(warning => warning.includes(requirement.label)),
          `${plan.type}: an unconfirmed/alternative request must be disclosed`)
      }
    }
    assessments.push(Object.fromEntries(requirements.map(item => [item.theme, item.status])))
  }
  return assessments
}

export async function assertIntentDelivery(result, fixture, kind) {
  assertHonestDeliveryChoices(result.response)
  const states = await assertDemandDelivery(result, fixture)
  const { resolveVisitRequirements } = await import('../../../api/_lib/candidate-ranking-context.ts')
  const expected = states.map(() => Object.fromEntries(resolveVisitRequirements(fixture.input).map(item => [item.theme, 'satisfied'])))
  if (kind === 'uncertain') result.response.plans.forEach((plan, i) => { expected[i].culture = plan.type === 'balanced' ? 'unmet' : 'unknown' })
  if (kind === 'illegal-culture') expected.forEach(value => { value.culture = 'unmet' })
  if (kind === 'unexposed') result.response.plans.forEach((plan, i) => { if (plan.type === 'safe') expected[i].coffee = 'unmet' })
  if (kind === 'three-themes') result.response.plans.forEach((plan, i) => { if (plan.type !== 'explore') expected[i].coffee = 'unmet' })
  assert.deepEqual(states, expected, `${kind}: fixed bodies have explicit demand outcomes, not blanket permission to differ`)
  if (kind === 'unexposed') assert.match(result.response.warnings.find(value => value.includes('咖啡廳')), /^保守方案：/)
  if (kind === 'three-themes') assert.match(result.response.warnings.find(value => value.includes('咖啡廳')), /^保守方案、平衡方案：/)
  return states
}
