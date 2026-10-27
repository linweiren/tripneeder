import test from 'node:test'
import { paidEventsFromLegacy } from './fixtures/paid-generation-regression-contract.mjs'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fixture, mockMatrix, FIXED_NOW } from './fixtures/supplement-quality.mjs'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const { assessCoverageV2, getCoverageTimeAccounting, recordAiDurations, traceDurationPlan,
  recordConfirmedActivityDuration, getDurationTrace, createRemedyTrace, recordCoverageSearch,
  getCoverageShadow, getRemedyTimelineSignature } = await import('../../api/_lib/trip-coverage-v2.ts')
const { createSupplementRouteContext, chooseSupplementalInsertion, resolveMealComparisonRoutes,
  SUPPLEMENT_ROUTE_BUDGET } = await import('../../api/_lib/trip-supplement-quality.ts')
const { applyCandidateGroundingToPlan, repairPlanForDelivery, repairAndValidatePlanForDelivery } =
  await import('../../api/generate-trip.ts')
const { getNearbyPlaceCandidates } = await import('../../api/_lib/google-places.ts')

// Every network boundary in this file is either blocked or served by a fixture.
test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  t.mock.method(https, 'request', () => { throw new Error('Unexpected external request') })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
})
function sample() {
  const f = fixture('city')
  f.plan.stops.forEach(s => { s.duration = 90 })
  f.plan.totalTime = 190
  recordCoverageSearch(f.candidates, [{ stage: 'initial', query: 'fixture', radiusMeters: 5000,
    status: 'succeeded', count: 4, placeIds: f.candidates.allCandidates.map(c => c.placeId) }])
  return f
}
function complete(f = sample()) {
  const trace = createRemedyTrace()
  trace.supplementPasses.push({ scope: 'fixture_bounded_pool', timelineSignature: getRemedyTimelineSignature(f.plan, f.input), pending: 0, eligible: 2, compared: 4,
    stopReason: 'bounded_scope_evaluated' })
  return trace
}
const validation = { issues: [], routesFailed: false }
const shadow = (f, trace = complete(f), check = validation) => assessCoverageV2(f.plan, f.input, f.candidates, trace, check)
function chooseOptions(f, context) {
  return { stops: f.plan.stops, segments: f.plan.transportSegments, input: f.input, capacity: 300,
    pool: f.extras, allCandidates: f.candidates.allCandidates,
    used: new Set(f.plan.stops.map(s => s.placeId)), crossPlanUsed: new Set(), mode: 'scooter',
    makeStop: c => ({ ...c }), context }
}

test('five hours / 190 actual / 225 minimum keeps 35 coverage and 110 unarranged separate', () => {
  const f = sample(), time = getCoverageTimeAccounting(f.plan, f.input)
  assert.equal(time.requestedMinutes, 300)
  assert.equal(time.actualMinutes, 190)
  assert.equal(time.coverageGapMinutes, 35)
  assert.equal(time.unarrangedMinutes, 110)
  assert.equal(time.tailBlankMinutes, 110)
  assert.equal(time.tailOnly, true)
  assert.equal(shadow(f).classification, 'C')
  assert.deepEqual(shadow(f, complete(), { ...validation, issues: ['行程時長不足（目前 190 分鐘，至少需要 225 分鐘）'] }).classification, 'C')
})

test('AI, verified activity, type references, coverage and unknown minutes remain separate through shrinking', () => {
  const f = sample(), before = f.plan
  recordAiDurations(before)
  const verified = before.stops[0], ai = before.stops[1]
  recordConfirmedActivityDuration(verified, { source: 'operator_schedule', reference: 'fixture/operator/session-90', minutes: 90 })
  assert.equal(getDurationTrace(verified).confirmedActivityMinutes, 90)
  assert.equal(getDurationTrace(ai).hasConfirmedActivityDuration, false)
  const padded = traceDurationPlan(before, { ...before, stops: before.stops.map(s => ({ ...s, duration: 120 })) }, 'coverage_target')
  const shrunk = traceDurationPlan(padded, { ...padded, stops: padded.stops.map(s => ({ ...s, duration: 100 })) }, 'capacity')
  const trace = getDurationTrace(shrunk.stops[0])
  assert.equal(trace.aiOriginalMinutes, 90)
  assert.equal(trace.coverageAddedMinutes, 30)
  assert.equal(trace.coverageRetainedMinutes, 10)
  assert.equal(trace.confirmedActivityMinutes, 90)
  assert.equal(trace.events[0].basis, 'coverage_padding')
  assert.equal(trace.events[1].reason, 'capacity')
  assert.deepEqual(trace.currentMinuteSources, [{ basis: 'ai_unverified', minutes: 90 }, { basis: 'coverage_padding', minutes: 10 }])
  const replacement = traceDurationPlan(shrunk, { ...shrunk, stops: shrunk.stops.map(s => ({ ...s, placeId: 'different' })) }, 'grounding')
  assert.equal(getDurationTrace(replacement.stops[0]).hasConfirmedActivityDuration, false)
  assert.equal(getDurationTrace(replacement.stops[0]).finalBasis, 'type_reference')
  assert.equal(getDurationTrace({ ...verified }).finalBasis, 'unknown')
})

test('types, name reference maxima and model activity prose never confirm activity duration', () => {
  const f = sample()
  Object.assign(f.plan.stops[0], { name: 'Museum 120 minute tour', googleTypes: ['museum'], description: 'Verified 120 minute activity' })
  const grounded = applyCandidateGroundingToPlan(f.plan, f.candidates)
  for (const stop of grounded.stops) {
    assert.equal(getDurationTrace(stop).hasConfirmedActivityDuration, false)
    assert.equal(getDurationTrace(stop).confirmedActivityMinutes, 0)
    assert.equal(getDurationTrace(stop).aiOriginalMinutes, 90)
  }
})

test('production repair extensions are policy padding, retain raw AI time and preserve input/schema', async t => {
  const f = sample()
  f.plan.stops.forEach(s => { s.name += '公園' })
  const snapshot = structuredClone(f.plan)
  const calls = mockMatrix(t, f)
  const grounded = applyCandidateGroundingToPlan(f.plan, f.candidates)
  const result = await repairPlanForDelivery(grounded, f.input, f.candidates)
  const traces = result.plan.stops.map(getDurationTrace)
  assert.equal(traces.reduce((n, s) => n + s.coverageAddedMinutes, 0), 35)
  assert.ok(traces.some(s => s.events.some(e => e.reason === 'coverage_existing')))
  assert.deepEqual(f.plan, snapshot)
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(result.plan).sort(), Object.keys({ ...f.plan, scheduleStartTime: '10:00' }).sort())
})

test('actual selected wrapper result has an internal shadow and no serialized coverage fields', async t => {
  const f = sample()
  mockMatrix(t, f)
  const result = await repairAndValidatePlanForDelivery(applyCandidateGroundingToPlan(f.plan, f.candidates),
    f.input, f.candidates, new Set(), 'coverage-v2-fixture')
  assert.ok(result.plan)
  assert.equal(getCoverageShadow(result.plan).classification, 'A')
  assert.equal(getCoverageShadow(result.plan).time.coverageGapMinutes, 0)
  assert.equal(JSON.stringify(result).includes('coverageV2'), false)
})

for (const kind of ['candidate', 'budget', 'api', 'unobserved', 'source']) test(`${kind} uncertainty never qualifies for C`, () => {
  const f = sample(), trace = complete()
  if (kind === 'candidate') trace.supplementPasses[0].pending = 1
  if (kind === 'budget') trace.budgetExhausted = true
  if (kind === 'api') trace.technicalFailure = true
  if (kind === 'unobserved') trace.supplementPasses = []
  if (kind === 'source') recordCoverageSearch(f.candidates, [{ stage: 'gap', query: 'failed fixture', radiusMeters: 5000, status: 'failed', count: 0 }])
  const result = shadow(f, trace)
  assert.equal(result.classification, 'B')
  assert.equal(result.nearbyOptionsAvailability, 'unknown')
})

test('bounded empty pool is insufficient evidence of remedy completion or absence of worthwhile activities', () => {
  const f = sample(), trace = createRemedyTrace()
  trace.supplementPasses.push({ scope: 'fixture', timelineSignature: getRemedyTimelineSignature(f.plan, f.input), pending: 0, eligible: 0, compared: 0, stopReason: 'bounded_pool_insufficient' })
  assert.equal(shadow(f, trace).stopReason, 'bounded_pool_insufficient')
  assert.equal(shadow(f, trace).classification, 'B')
})

test('core missing and lawful related alternatives remain D, distinct from unexecutable failure', () => {
  const f = sample()
  Object.assign(f.input, { category: 'other', customCategory: '想去博物館' })
  f.candidates.allCandidates[0].types = ['art_gallery']
  f.plan.stops[0].googleTypes = ['art_gallery']
  f.plan.stops[0].name = '地方美術館'
  const result = shadow(f)
  assert.equal(result.classification, 'D')
  assert.equal(result.fulfillment, 'legal_alternative_original_unmet')
  assert.equal(result.coreSatisfied, false)
  assert.equal(shadow(f, complete(), { ...validation, issues: ['opening failure'] }).fulfillment, 'execution_failed_or_unverified')
})

test('unknown custom intent cannot vacuously satisfy core requirements', () => {
  const f = sample()
  Object.assign(f.input, { category: 'other', customCategory: '特殊的未知需求' })
  assert.equal(shadow(f).classification, 'D')
})

test('late start, stale/estimated routes and unrepresented interstop waits cannot qualify for C', () => {
  for (const mode of ['delay', 'missing', 'stale', 'estimate', 'extra-gap']) {
    const f = sample()
    if (mode === 'delay') f.plan.scheduleStartTime = '11:00'
    if (mode === 'missing') f.plan.transportSegments = []
    if (mode === 'stale') f.plan.transportSegments[0].toStopId = 'wrong'
    if (mode === 'estimate') f.plan.transportSegments[0].label = '(估算)'
    if (mode === 'extra-gap') f.plan.transportSegments.push({ ...f.plan.transportSegments[0], duration: 30 })
    assert.equal(shadow(f).classification, 'B', mode)
    assert.equal(shadow(f).time.tailOnly, false, mode)
  }
})

test('23:00–01:00 remains 120 minutes, separate from dawn tail and early-morning active-window exceptions', () => {
  const f = sample()
  Object.assign(f.input, { startTime: '23:00', endTime: '01:00' })
  f.plan.stops.forEach(s => { s.duration = 40 })
  const ordinary = getCoverageTimeAccounting(f.plan, f.input)
  assert.equal(ordinary.requestedMinutes, 120)
  assert.equal(ordinary.normalMinimumMinutes, 84)
  assert.equal(ordinary.earlyMorningExceptionMinutes, 0)
  assert.equal(ordinary.requestedEnd, 1500)
  Object.assign(f.input, { startTime: '23:00', endTime: '06:00' })
  assert.equal(getCoverageTimeAccounting(f.plan, f.input).earlyMorningExceptionMinutes, 0)
  assert.equal(getCoverageTimeAccounting(f.plan, f.input).normalMinimumMinutes, 315)
  Object.assign(f.input, { startTime: '03:00', endTime: '12:00' })
  f.plan.scheduleStartTime = '06:00'
  const early = getCoverageTimeAccounting(f.plan, f.input)
  assert.equal(early.requestedMinutes, 540)
  assert.equal(early.normalMinimumMinutes, 270)
  assert.equal(early.earlyMorningExceptionMinutes, 180)
  assert.equal(early.startDelayMinutes, 180)
  assert.equal(early.tailOnly, true)
  f.plan.scheduleStartTime = '07:00'
  assert.equal(getCoverageTimeAccounting(f.plan, f.input).tailOnly, false)
})

test('Routes budget exhaustion performs no request and leaves candidates unevaluated', async () => {
  const f = sample(), context = createSupplementRouteContext()
  context.calls = SUPPLEMENT_ROUTE_BUDGET.perPlan
  const result = await chooseSupplementalInsertion(chooseOptions(f, context))
  assert.equal(result.choice, undefined)
  assert.equal(context.totalCalls, 0)
  assert.equal(context.remedy.budgetExhausted, true)
  assert.ok(context.remedy.supplementPasses[0].pending > 0)
  assert.equal(shadow(f, context.remedy).classification, 'B')
  assert.equal(await resolveMealComparisonRoutes(context, [...f.plan.stops, f.extras[0]], 'scooter', context.calls), null)
})

test('failed candidate route responses remain technical failures even when delivery hides the failed trial', async t => {
  const f = sample(), context = createSupplementRouteContext()
  f.failRoutes = true
  const calls = mockMatrix(t, f)
  const result = await chooseSupplementalInsertion(chooseOptions(f, context))
  assert.equal(result.choice, undefined)
  assert.equal(result.routesFailed, true)
  assert.equal(context.remedy.technicalFailure, true)
  assert.ok(context.remedy.events.some(e => e.outcome === 'route_failure'))
  assert.ok(calls.length > 0)
  assert.equal(shadow(f, context.remedy).stopReason, 'technical_failure')
})

test('real route comparisons expose capacity rejection and never imply a world-wide absence', async t => {
  const f = sample(), context = createSupplementRouteContext()
  Object.assign(f.routes, { 'A>far': 200, 'far>B': 200, 'B>far': 200,
    'A>near': 200, 'near>B': 200, 'B>near': 200 })
  mockMatrix(t, f)
  const result = await chooseSupplementalInsertion(chooseOptions(f, context))
  assert.equal(result.choice, undefined)
  assert.ok(context.remedy.events.some(e => e.outcome === 'capacity_rejected' && e.routeComparisonCompleted))
  assert.equal(context.remedy.supplementPasses[0].stopReason, 'bounded_scope_evaluated')
  assert.equal(shadow(f, context.remedy).classification, 'C')
})

test('HTTP search failure and a successful empty search keep different provenance with unchanged empty pools', async t => {
  let status = 503
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const req = new EventEmitter()
    req.write = () => {}
    req.setTimeout = () => req
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      res.statusCode = status
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from('{}'))
      res.emit('end')
    })
    return req
  })
  for (const expected of ['failed', 'succeeded']) {
    const f = sample()
    const pool = await getNearbyPlaceCandidates({ input: f.input })
    assert.deepEqual(pool.allCandidates, [])
    const result = assessCoverageV2(f.plan, f.input, pool, complete(), validation)
    assert.ok(result.search.length > 0)
    assert.ok(result.search.every(s => s.status === expected))
    assert.equal(result.nearbyOptionsAvailability, 'unknown')
    status = 200
  }
})


test('rejected coverage result records the repaired plan rather than the raw AI input', async t => {
  const f = sample()
  f.plan.stops.forEach(s => { s.duration = 80 })
  f.candidates.allCandidates = f.candidates.firstStopCandidates = f.candidates.otherCandidates = f.plan.stops
  const { TripCandidateDebugSession } = await import('../../api/_lib/trip-candidate-debug.ts')
  const debug = new TripCandidateDebugSession(f.input)
  mockMatrix(t, f)
  const result = await repairAndValidatePlanForDelivery(applyCandidateGroundingToPlan(f.plan, f.candidates),
    f.input, f.candidates, new Set(), 'rejected-fixture', new Set(), debug)
  assert.equal(result.plan, null)
  const attempt = debug.buildReport([]).coverageV2.attempts.at(-1).shadow
  assert.equal(attempt.time.actualMinutes, 190)
  assert.equal(attempt.time.coverageGapMinutes, 35)
  assert.equal(attempt.classification, 'B')
  assert.equal(attempt.stopReason, 'bounded_pool_insufficient')
  assert.equal(attempt.stops.reduce((n, s) => n + s.coverageAddedMinutes, 0), 20)
})

test('shortlisted candidates do not erase still unprocessed candidates in the supplied pool', async t => {
  const f = fixture('explore-seventh'), context = createSupplementRouteContext()
  mockMatrix(t, f)
  await chooseSupplementalInsertion(chooseOptions(f, context))
  assert.ok(context.remedy.supplementPasses[0].pending > 0)
  assert.equal(context.remedy.supplementPasses[0].eligible, 7)
  assert.ok(context.remedy.events.some(e => e.placeId === 'rank-7' && e.outcome === 'considered'))
  assert.equal(shadow(f, context.remedy).classification, 'B')
})

test('opening failures are recorded after actual route comparison', async t => {
  const f = sample(), context = createSupplementRouteContext()
  f.extras.forEach(c => { c.openingHours = { ...c.openingHours, windows: [{
    openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 600 * 60000) }] } })
  mockMatrix(t, f)
  await chooseSupplementalInsertion(chooseOptions(f, context))
  assert.ok(context.remedy.events.some(e => e.outcome === 'opening_rejected' && e.routeComparisonCompleted))
  assert.equal(context.remedy.technicalFailure, false)
})

for (const scenario of ['positioning', 'missing-balanced', 'tail']) test(`12d11cd full mocked generation stays identical: ${scenario}`, t => {
  const [baseline, off, on] = ['baseline', 'off', 'on'].map(mode => JSON.parse(execFileSync(process.execPath,
    ['--import', './tests/unit/register-ts-js-extension-loader.mjs', './tests/unit/fixtures/coverage-v2-replay.mjs', mode, scenario],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })))
  for (const result of [off, on]) {
    assert.deepEqual(result.response, baseline.response)
    assert.deepEqual(result.events, paidEventsFromLegacy(baseline.events))
    assert.deepEqual(result.calls, baseline.calls)
  }
  assert.equal(on.coverageFinal.length, 3)
  assert.ok(on.coverageFinal.every(item => item.shadow !== null))
  assert.ok(on.coverageFinal.every(item => item.shadow.search.length > 0))
  assert.equal(on.persistedCoverageV2.final.length, 3)
  assert.equal(on.persistedCoverageV2.projection.incomplete, false,
    JSON.stringify(on.persistedCoverageV2.projection.reasons))
  for (const [index, memory] of on.coverageFinal.entries()) {
    const persisted = on.persistedCoverageV2.final[index]
    assert.equal(persisted.planId, memory.planId)
    assert.equal(persisted.shadow.classification, memory.shadow.classification)
    assert.equal(persisted.shadow.stopReason, memory.shadow.stopReason)
    assert.equal(persisted.shadow.time.actualMinutes, memory.shadow.time.actualMinutes)
    assert.equal(persisted.shadow.time.coverageGapMinutes, memory.shadow.time.coverageGapMinutes)
    assert.equal(persisted.shadow.time.unarrangedMinutes, memory.shadow.time.unarrangedMinutes)
    assert.deepEqual(persisted.shadow.stops.map(s => [s.finalMinutes, s.coverageAddedMinutes, s.coverageRetainedMinutes]),
      memory.shadow.stops.map(s => [s.finalMinutes, s.coverageAddedMinutes, s.coverageRetainedMinutes]))
  }
  assert.equal(off.reports, 0)
  assert.equal(on.reports, 1)
  t.diagnostic(JSON.stringify({ scenario, calls: on.calls,
    finalShadows: on.coverageFinal.map(item => item.shadow.classification) }))
})


test('completed comparisons on an earlier route or duration cannot qualify a changed plan for C', () => {
  const f = sample(), trace = complete(f)
  f.plan.stops[0] = { ...f.plan.stops[0], duration: 95 }
  const result = shadow(f, trace)
  assert.equal(result.classification, 'B')
  assert.equal(result.remedyTimelineMatches, false)
  assert.ok(result.blockers.includes('remedy_timeline_changed_or_unobserved'))
})
