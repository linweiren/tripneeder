import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTripPrompt, buildRetryTripSkeletonPrompt, parseTripPlanSkeletonResponse } from '../../src/services/ai/tripPlanPrompt.ts'
import { normalizeTripPlanIdentity } from '../../src/services/ai/tripPlanIdentity.ts'
import { getActivityPurpose, compareOriginalActivities } from '../../api/_lib/trip-activity-purpose.ts'
import { getPlanActualDuration } from '../../api/_lib/trip-plan-metrics.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'
import { getMinimumRequiredActualMinutes } from '../../api/_lib/trip-planning-rules.ts'
import { styleGenerationFixture } from './fixtures/style-generation.mjs'
import { mockGeneration, runHandler } from './fixtures/plan-identity.mjs'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.OPENAI_API_KEY = 'unit-test-only'
process.env.SUPABASE_URL = 'https://unit-test.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
process.env.ENABLE_LOCAL_FALLBACK_REFILL = 'false'
process.env.TRIP_CANDIDATE_DEBUG = 'false'
const { default: handler, getDeliveryPlanIssues } = await import('../../api/generate-trip.ts')

function identityExample(prompt) {
  const section = prompt.slice(prompt.indexOf('JSON 身分範例'))
  const start = section.indexOf('{'), end = section.lastIndexOf('}')
  return JSON.parse(section.slice(start, end + 1)).plans
}
function profile(plan) {
  const minutes = {}
  for (const stop of plan.stops) {
    const purpose = getActivityPurpose(stop)
    minutes[purpose] = (minutes[purpose] ?? 0) + stop.duration
  }
  return minutes
}
async function deliver(t, kind, refill) {
  const f = styleGenerationFixture(kind)
  const calls = mockGeneration(t, f, f.aiPlans, refill ? ids => refill(f, ids) : undefined, f.mockOptions)
  const result = await runHandler(handler, f)
  assert.ok(result.response, JSON.stringify(result.events))
  const expected = { aliases: ['safe', 'balanced'], duplicate: ['safe', 'balanced'], identical: ['safe', 'balanced'],
    missing: ['safe', 'explore'], unknown: ['safe', 'explore'], conflict: ['safe', 'explore'], 'missing-balanced': ['safe', 'explore'] }[kind] ?? ['safe', 'balanced', 'explore']
  assert.deepEqual(result.response.plans.map(p => p.id), expected)
  if (expected.length < 3) assert.match(result.response.warnings.join(' '), /合併顯示/)
  for (const plan of result.response.plans) {
    assert.equal(plan.type, plan.id)
    assert.deepEqual(await getDeliveryPlanIssues(plan, f.input, 'style-final', { candidates: f.candidates }), [])
    assert.deepEqual(getRequiredMealCoverageIssues(plan, f.input), [])
    assert.ok(getPlanActualDuration(plan) >= getMinimumRequiredActualMinutes(f.input))
    const original = f.plans.find(p => p.type === plan.type)
    const impact = compareOriginalActivities(original.stops.filter(s => s.type !== 'food'),
      plan.stops.filter(s => s.type !== 'food'))
    assert.equal(impact.retainedStayLoss, 0)
    assert.equal(impact.removedStops, 0)
    assert.equal(impact.identityChanges, 0)
    assert.equal(impact.purposeChanges, 0)
  }
  t.diagnostic(JSON.stringify({ kind, aiCalls: calls.ai.length, routeCalls: calls.routes.length,
    plans: result.response.plans.map(p => ({ type: p.type, profile: profile(p),
      travel: p.transportSegments.reduce((n, s) => n + s.duration, 0) })) }))
  return { f, calls, plans: result.response.plans }
}

test('initial style tasks and identity examples cover all three named styles with shared quality safeguards', () => {
  const f = styleGenerationFixture()
  const prompt = buildTripPrompt(f.input)
  assert.deepEqual(identityExample(prompt).map(p => [p.id, p.type]),
    [['safe', 'safe'], ['balanced', 'balanced'], ['explore', 'explore']])
  assert.match(prompt, /行程集中、交通負擔低/)
  assert.match(prompt, /活動類型與停留節奏均衡/)
  assert.match(prompt, /符合使用者興趣、具有不同體驗價值/)
  assert.match(prompt, /不代表必須更遠、更多站或更趕/)
  assert.match(prompt, /同地點但不同合理停留深度/)
  assert.match(prompt, /不要因風格或個人化重複加分/)
  assert.match(prompt, /第一站距離起點必須 ≤ 2 km/)
})

test('single and multi-style retries use matching tasks, counts and examples with no unrelated style examples', () => {
  const f = styleGenerationFixture()
  for (const types of [['safe'], ['balanced'], ['explore'], ['balanced', 'explore']]) {
    const prompt = buildRetryTripSkeletonPrompt(f.input, types, undefined, undefined, ['需要重新規劃'])
    assert.match(prompt, new RegExp(`產生 ${types.length} 個單日行程`))
    assert.deepEqual(identityExample(prompt).map(p => p.type), types)
    assert.ok(!prompt.includes('產生 3 個'))
    const initial = buildTripPrompt(f.input)
    for (const type of types) {
      const task = initial.split('\n').find(line => line.startsWith(`- ${type}（`))
      assert.ok(prompt.includes(task))
    }
    assert.match(prompt, /不得拿另一種風格的行程改名交付/)
  }
  for (const ids of [[], ['unknown'], ['safe', 'safe']]) {
    assert.throws(() => buildRetryTripSkeletonPrompt(f.input, ids))
  }
})

test('nonreserved aliases preserve explicit distinct types regardless of prefix or array order', () => {
  const f = styleGenerationFixture('aliases')
  const plans = parseTripPlanSkeletonResponse(JSON.stringify({ plans: f.aiPlans })).plans
  assert.deepEqual(plans.map(p => p.id), ['safe', 'balanced', 'explore'])
  for (const plan of plans) assert.equal(plan.title, `原始${plan.type}體驗`)
  for (const id of ['safe-1', 'safe_2', 'balanced-3', 'explore-1']) {
    assert.equal(normalizeTripPlanIdentity({ ...f.plans[2], id }).type, 'explore')
  }
  assert.equal(normalizeTripPlanIdentity({ ...f.plans[2], id: 'safe' }), null)
})

test('legacy aliases with unique valid types retain all original sources without two unnecessary refills', async t => {
  const { plans, calls } = await deliver(t, 'aliases')
  assert.equal(calls.ai.length, 1)
  for (const plan of plans) assert.equal(plan.title, `原始${plan.type}體驗`)
})

test('duplicate, missing and truly conflicting types still require bounded regeneration', async t => {
  for (const [kind, expectedCalls] of [['duplicate', 3], ['missing', 2], ['unknown', 2], ['conflict', 2]]) {
    await t.test(kind, async child => {
      const { calls } = await deliver(child, kind)
      assert.equal(calls.ai.length, expectedCalls)
    })
  }
})

test('a requested Balanced refill can use an arbitrary alias but never an Explore type', async t => {
  const { calls } = await deliver(t, 'missing-balanced', (f, ids) => f.plans.filter(p => ids.includes(p.type))
    .map(p => ({ ...p, id: 'explore-1' })))
  assert.equal(calls.ai.length, 2)
  assert.ok(!calls.ai[1].messages[0].content.includes('Keep the three plans'))
  assert.deepEqual(identityExample(calls.ai[1].messages[0].content).map(p => p.type), ['balanced'])
})

test('a wrong-type alias cannot satisfy the requested style and cannot displace accepted styles', async t => {
  const f = styleGenerationFixture('missing-balanced')
  const calls = mockGeneration(t, f, f.aiPlans, () => [{ ...f.plans[2], id: 'balanced-1' }], f.mockOptions)
  const result = await runHandler(handler, f)
  assert.ok(result.response)
  assert.deepEqual(result.response.plans.map(p => p.type), ['safe', 'explore'])
  assert.equal(calls.ai.length, 2)
  assert.match(result.response.warnings.join(' '), /平衡方案/)
})

test('crafted positioning variants retain different purpose allocation and activity depth without harming original activities', async t => {
  const { plans, calls } = await deliver(t, 'positioning')
  assert.equal(calls.ai.length, 1)
  assert.equal(new Set(plans.map(p => JSON.stringify(profile(p)))).size, 3)
  assert.deepEqual(plans.map(p => p.stops.filter(s => s.type === 'main_activity').length), [2, 2, 3])
  assert.deepEqual(plans.map(p => p.transportSegments.reduce((n, s) => n + s.duration, 0)), [8, 8, 20])
})

test('same places at different lawful depths remain meaningful options even with sparse candidates', async t => {
  const { plans, calls } = await deliver(t, 'sparse')
  assert.equal(calls.ai.length, 1)
  assert.equal(new Set(plans.map(p => p.stops.map(s => s.placeId).join('|'))).size, 1)
  assert.equal(new Set(plans.map(p => JSON.stringify(profile(p)))).size, 3)
})

test('correct identities alone do not manufacture semantic differences from identical fixed AI bodies', async t => {
  const { plans, calls } = await deliver(t, 'identical')
  assert.equal(calls.ai.length, 1)
  assert.equal(new Set(plans.map(p => JSON.stringify(profile(p)))).size, 1)
  assert.equal(new Set(plans.map(p => p.stops.map(s => s.placeId).join('|'))).size, 2)
})
