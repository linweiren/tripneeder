import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTripPlanIdentity, normalizeTripPlanIdentities, compareTripPlanStyles,
  getTripPlanStyleLabel } from '../../src/services/ai/tripPlanIdentity.ts'
import { buildTripPrompt, buildRetryTripSkeletonPrompt, parseTripPlanSkeletonResponse,
  parseTripPlanResponse } from '../../src/services/ai/tripPlanPrompt.ts'
import { tripPlanSkeletonResponseSchema } from '../../src/services/ai/tripPlanResponseSchema.ts'
import { ProxyTripPlanner } from '../../src/services/ai/proxyTripPlanner.ts'
import { identityFixture, mockGeneration, runHandler } from './fixtures/plan-identity.mjs'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.OPENAI_API_KEY = 'unit-test-only'
process.env.SUPABASE_URL = 'https://unit-test.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
process.env.ENABLE_LOCAL_FALLBACK_REFILL = 'false'
process.env.TRIP_CANDIDATE_DEBUG = 'false'
const { default: handler, getDeliveryPlanIssues, applyCandidateGroundingToPlan,
  getOriginalActivityImpact } = await import('../../api/generate-trip.ts')

function parse(plans) { return parseTripPlanSkeletonResponse(JSON.stringify({ plans })).plans }
function assertStyles(plans, expected = ['safe', 'balanced', 'explore']) {
  assert.deepEqual(plans.map(p => p.type), expected)
  assert.deepEqual(plans.map(p => p.id), expected)
  assert.equal(new Set(plans.map(p => p.type)).size, plans.length)
}
async function generate(t, initial, refill, options) {
  const f = identityFixture()
  const calls = mockGeneration(t, f, initial(f), refill ? (ids, n, body) => refill(f, ids, n, body) : undefined, options)
  const result = await runHandler(handler, f)
  assert.equal(result.statusCode, 200)
  t.diagnostic(JSON.stringify({ scenario: t.name, aiCalls: calls.ai.length, routeCalls: calls.routes.length,
    delivered: result.response?.plans.map(p => ({ id: p.id, type: p.type,
      stay: p.stops.reduce((n, s) => n + s.duration, 0),
      travel: p.transportSegments.reduce((n, s) => n + s.duration, 0) })) ?? [] }))
  return { ...result, f, calls }
}

test('existing structured schema requires type; prompts distinguish common theme from exactly one of each style', () => {
  const f = identityFixture()
  const item = tripPlanSkeletonResponseSchema.properties.plans.items
  assert.ok(item.required.includes('type'))
  assert.deepEqual(item.properties.type.enum, ['safe', 'balanced', 'explore'])
  const prompt = buildTripPrompt(f.input)
  assert.match(prompt, /plan.id 與 plan.type 必須同時逐字/)
  assert.match(prompt, /行程類型.*共同主題，不是 plan.type/)
  const retry = buildRetryTripSkeletonPrompt(f.input, ['balanced'])
  assert.match(retry, /只產生列出的風格各一案/)
  assert.match(retry, /不得拿另一種風格的行程改名交付/)
})

test('both parsers preserve correct identities and canonical style order without changing route content', () => {
  const f = identityFixture()
  const unordered = [f.plans[2], f.plans[0], f.plans[1]]
  for (const parser of [parseTripPlanSkeletonResponse, parseTripPlanResponse]) {
    const result = parser(JSON.stringify({ plans: unordered }))
    assertStyles(result.plans)
    for (const plan of result.plans) assert.deepEqual(plan.stops, JSON.parse(JSON.stringify(f.plan.stops)))
  }
  assertStyles(unordered.toSorted(compareTripPlanStyles))
})

test('opaque IDs with explicit distinct types are normalized by type, never by array position', () => {
  const f = identityFixture()
  const plans = [f.plans[2], f.plans[0], f.plans[1]].map((p, i) => ({ ...p, id: `model-${i}` }))
  assertStyles(parse(plans))
  assert.equal(plans[0].id, 'model-0')
})

test('explore-1/2/3 with explore types preserve only Explore rather than fabricating other styles', () => {
  const f = identityFixture()
  const plans = f.plans.map((p, i) => ({ ...p, id: `explore-${i + 1}`, type: 'explore', title: `source-${i}` }))
  const result = parse(plans)
  assertStyles(result, ['explore'])
  assert.equal(result[0].title, 'source-0')
})

test('missing, null, unknown types and conflicting reserved IDs cannot be inferred or relabelled', () => {
  const f = identityFixture()
  for (const value of [undefined, null, '', 'custom', 'SAFE']) {
    assert.equal(normalizeTripPlanIdentity({ ...f.plans[0], type: value }), null)
  }
  for (const id of ['safe', 'balanced']) {
    assert.equal(normalizeTripPlanIdentity({ ...f.plans[2], id }), null)
  }
  assert.equal(normalizeTripPlanIdentity({ ...f.plans[0], id: '' }), null)
  assert.deepEqual(normalizeTripPlanIdentities([null, 3, {}, { ...f.plans[0], type: undefined }]), [])
})

test('canonical identity normalization preserves original activity provenance across grounding and final delivery', () => {
  const f = identityFixture()
  const source = structuredClone(f.plans[0])
  source.stops[0].placeId = f.candidates.allCandidates.find(c => c.name === '美濃莊餐廳').placeId
  const grounded = applyCandidateGroundingToPlan(source, f.candidates)
  assert.notEqual(grounded.stops[0].placeId, source.stops[0].placeId)
  const normalized = normalizeTripPlanIdentities([grounded])[0]
  assert.equal(normalized, grounded)
  assert.equal(getOriginalActivityImpact(normalized, normalized.stops).identityChanges, 1)
})

test('correct or opaque distinct identities use one AI call and all three pass actual final validation', async t => {
  const { response, events, calls, f } = await generate(t, f => [f.plans[2], f.plans[0], f.plans[1]])
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assert.equal(calls.ai.length, 1)
  assert.equal(calls.points, 1) // Mocked RPC, not a real charge.
  for (const plan of response.plans) {
    assert.deepEqual(await getDeliveryPlanIssues(plan, f.input, 'identity-final', { candidates: f.candidates }), [])
  }
})

test('three Explore aliases refill only Safe and Balanced with their own regenerated contents', async t => {
  const { response, events, calls } = await generate(t,
    f => f.plans.map((p, i) => ({ ...p, id: `explore-${i + 1}`, type: 'explore', title: `old-${i}` })),
    (f, ids) => f.plans.filter(p => ids.includes(p.type)).map(p => ({ ...p, title: `new-${p.type}` })))
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assert.equal(response.plans[0].title, 'new-safe')
  assert.equal(response.plans[1].title, 'new-balanced')
  assert.equal(response.plans[2].title, 'old-0')
  assert.equal(calls.ai.length, 3)
  assert.deepEqual(calls.ai.slice(1).map(c => /需重產的方案 ID：([^\n]*)/.exec(c.messages[0].content)[1]), ['safe', 'balanced'])
  assertStyles(events.filter(e => e.event === 'plan').map(e => e.plan), ['explore'])
})

test('missing type uses bounded refill and is never recovered from its ID', async t => {
  const { response, calls, events } = await generate(t, f => [
    { ...f.plans[0], type: undefined, title: 'must-not-survive' }, f.plans[1], f.plans[2],
  ])
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assert.equal(calls.ai.length, 2)
  assert.ok(response.plans.every(p => p.title !== 'must-not-survive'))
})

test('unknown and conflicting identities refill the missing style without displacing accepted styles', async t => {
  const { response, calls, events } = await generate(t, f => [
    { ...f.plans[0], id: 'safe', type: 'balanced' }, { ...f.plans[1], type: 'custom' }, f.plans[2],
  ])
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assert.equal(calls.ai.length, 3)
})

test('wrong-style refill cannot be cosmetically renamed; attempts stop and report partial delivery', async t => {
  const { response, calls, events } = await generate(t, f => [f.plans[2]], f => [f.plans[2]])
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans, ['explore'])
  assert.equal(calls.ai.length, 3)
  assert.match(response.warnings.join(' '), /保守方案、平衡方案/)
  assert.equal(calls.points, 1)
})

test('wrong identities in every attempt are safely rejected without an unbounded retry loop or mock charge', async t => {
  const wrong = f => f.plans.map(p => ({ ...p, type: undefined }))
  const { response, calls, events } = await generate(t, wrong, wrong)
  assert.equal(response, undefined)
  assert.ok(events.some(e => e.event === 'error'))
  assert.equal(calls.ai.length, 4)
  assert.equal(calls.routes.length, 0)
  assert.equal(calls.points, 0)
})

test('quality retry requests only invalid styles with the correct item count and retains final safety gates', async t => {
  const { response, calls, events } = await generate(t, f => {
    const plans = structuredClone(f.plans)
    Object.assign(plans[0].stops[0], { name: 'not-found', address: 'not-found', placeId: 'not-found' })
    return plans
  })
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assert.equal(calls.ai.length, 2)
  assert.equal(calls.ai[1].response_format.json_schema.schema.properties.plans.minItems, 1)
  assert.equal(calls.ai[1].response_format.json_schema.schema.properties.plans.maxItems, 1)
  assert.ok(response.plans.every(p => p.stops.every(s => s.placeId !== 'not-found')))
})

test('JSON fallback plus failed identity refill remains bounded by existing one-shot paths', async t => {
  const { response, calls, events } = await generate(t, () => 'incomplete-json',
    (f, ids, n) => n === 2 ? [{ ...f.plans[2], id: 'explore-1' }] : [])
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans, ['explore'])
  assert.equal(calls.ai.length, 4) // Initial + one JSON fallback + two missing-style refills.
})

test('combined JSON fallback, quality retry and missing-style refills cannot exceed six AI calls', async t => {
  const { response, calls, events } = await generate(t, f => {
    f.plans = f.plans.map(plan => {
      const stops = plan.stops.filter(stop => stop.type !== 'food')
      return { ...plan, stops, transportSegments: [{ fromStopId: stops[0].id, toStopId: stops[1].id,
        duration: f.routes[`${stops[0].placeId}>${stops[1].placeId}`], mode: 'scooter', label: '' }] }
    })
    return 'incomplete-json'
  }, (f, _ids, n) => n === 2 ? f.plans : f.plans.map(p => ({ ...p, type: undefined })), { failRoutes: true })
  assert.equal(response, undefined)
  assert.ok(events.some(e => e.event === 'error'))
  assert.equal(calls.ai.length, 6)
  assert.equal(calls.points, 0)
})

test('failed Routes for a necessary meal cannot produce a falsely valid missing style during refill', async t => {
  const { response, events, calls } = await generate(t, f => {
    f.plans = f.plans.map(plan => {
      const stops = plan.stops.filter(stop => stop.type !== 'food')
      return { ...plan, stops, transportSegments: [{ fromStopId: stops[0].id, toStopId: stops[1].id,
        duration: f.routes[`${stops[0].placeId}>${stops[1].placeId}`], mode: 'scooter', label: '' }] }
    })
    return [f.plans[2]]
  }, undefined, { failRoutes: true })
  assert.equal(response, undefined)
  assert.ok(events.some(e => e.event === 'error'))
  assert.ok(calls.ai.length <= 5)
  assert.equal(calls.points, 0)
})

test('SSE trailing buffer also canonicalizes identity before frontend partial delivery', async t => {
  const { response, events, calls } = await generate(t, f => f.plans.map(p => ({ ...p, id: `${p.type}-1` })),
    undefined, { streamTail: true })
  assert.ok(response, JSON.stringify(events))
  assertStyles(response.plans)
  assertStyles(events.filter(e => e.event === 'plan').map(e => e.plan))
  assert.equal(calls.ai.length, 1)
})

test('frontend receives canonical final identities and displays the surviving style, preserving legacy route IDs', async t => {
  const f = identityFixture()
  const partials = []
  const plans = [f.plans[1], f.plans[2]]
  t.mock.method(globalThis, 'fetch', async () => new Response(
    plans.map(plan => JSON.stringify({ event: 'plan', plan })).join('\n') + '\n' +
    JSON.stringify({ event: 'done', response: { plans } }) + '\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    }))
  const response = await new ProxyTripPlanner().generateTripPlans({ input: f.input, onPlan: p => partials.push(p) })
  assertStyles(response.plans, ['balanced', 'explore'])
  assert.deepEqual(partials, JSON.parse(JSON.stringify(plans)))
  assert.deepEqual(response.plans.map(p => getTripPlanStyleLabel(p.type)), ['平衡方案', '探索方案'])
  const legacy = [{ id: 'explore-1', type: 'explore' }, { id: 'legacy-balanced', type: 'balanced' }]
    .sort(compareTripPlanStyles)
  assert.deepEqual(legacy.map(p => p.id), ['legacy-balanced', 'explore-1'])
  assert.equal(getTripPlanStyleLabel('unknown'), null)
})
