// Phase 2C-1 isolated replay; copied harness, existing Repair/Validation only.
import { mock } from 'node:test'
import https from 'node:https'
import { loadCoverageExperiment } from './coverage-experiment-loader.mjs'

const [mode, kind, style = 'explore', layer = 'repair', evidenceMode = 'default', instrumentation = 'none'] = process.argv.slice(2)
Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only',
  OPENAI_API_KEY: 'unit-test-only', SUPABASE_URL: 'https://unit-test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only', ENABLE_LOCAL_FALLBACK_REFILL: 'false', TRIP_CANDIDATE_DEBUG: 'false' })
const { experimentFixture } = await import('./coverage-experiment-cases.mjs')
const { mockDurationQuality } = await import('./stop-duration-quality.mjs')
const { mockGeneration, runHandler } = await import('./plan-identity.mjs')
const { TripCandidateDebugSession } = await import('../../../api/_lib/trip-candidate-debug.ts')
const { getDurationTrace, recordConfirmedActivityDuration, recordCoverageSearch, getCoverageTimeAccounting,
  getCoverageShadow } = await import('../../../api/_lib/trip-coverage-v2.ts')
const { getRequiredMealCoverageIssues, getPlanRhythmIssues } = await import('../../../api/_lib/trip-quality-rules.ts')
const { getScheduleCapacityMinutes, getMinimumRequiredActualMinutes } = await import('../../../api/_lib/trip-planning-rules.ts')
const { assessVisitRequirements } = await import('../../../api/_lib/trip-demand-compliance.ts')
const { validatePlanOpeningHours } = await import('../../../api/_lib/google-places.ts')
const { compareOriginalActivities } = await import('../../../api/_lib/trip-activity-purpose.ts')
const api = await loadCoverageExperiment(mode, { trace: instrumentation === 'trace' })
const f = experimentFixture(kind, style)
if (evidenceMode === 'unverified') f.evidence = []
if (evidenceMode === 'capacity-pressure') { f.input.endTime = '13:00'; f.plan.scheduleStartTime = f.input.startTime }
if (evidenceMode === 'opening-pressure') {
  const tail = f.plan.stops.at(-1)
  f.placeOverrides[tail.placeId].regularOpeningHours = { periods: Array.from({length:7}, (_,day) => ({
    open: {day,hour:0,minute:0}, close: {day,hour:13,minute:0} })) }
}

let output
if (layer === 'handler') {
  for (const key of ['info', 'warn', 'debug', 'error']) mock.method(console, key, () => {})
  f.plans = ['safe', 'balanced', 'explore'].map(type => ({ ...structuredClone(f.plan), id: type, type,
    title: `固定${type}草稿`, subtitle: '隔離免費實驗', summary: '相同候選與草稿，重跑既有生成流程' }))
  const initial = structuredClone(f.plans)
  const refillDrafts = []
  const fingerprint = plan => JSON.stringify({ stops: plan.stops.map(s => [s.id,s.placeId,s.duration]),
    segments: plan.transportSegments.map(s => [s.fromStopId,s.toStopId,s.duration]) })
  const calls = mockGeneration({ mock }, f, initial, ids => {
    const plans = f.plans.filter(plan => ids.includes(plan.type))
    refillDrafts.push({ stage: api.__experiment?.aiStages.at(-1), targets: ids,
      returned: plans.map(plan => ({ style: plan.type, sameAsInitial: fingerprint(plan) === fingerprint(initial.find(p=>p.type===plan.type)) })) })
    return plans
  })
  let places = 0
  const externalLedger = []
  const request = https.request
  mock.method(https, 'request', function(url, ...args) {
    const target = new URL(url)
    if (target.hostname === 'places.googleapis.com') places++
    if (instrumentation === 'trace') externalLedger.push({
      service: target.hostname === 'places.googleapis.com' ? target.pathname.endsWith(':searchText') ? 'places_search' : 'places_details'
        : target.hostname === 'routes.googleapis.com' ? 'routes' : 'supabase',
      stage: api.__experiment?.aiStages.at(-1) ?? 'search_before_ai',
      phase: api.__experiment?.currentWrapper?.phase ?? null, style: api.__experiment?.currentWrapper?.style ?? null })
    return request.call(this, url, ...args)
  })
  const result = await runHandler(api.default, f)
  const aiKinds = calls.ai.map(body => body.stream ? 'initial'
    : body.response_format?.json_schema?.name?.includes('refill') ? 'refill' : /只需產生|需重產的方案 ID/.test(body.messages[0].content) ? 'retry' : 'other')
  output = { mode, kind, layer, evidenceClass: f.evidenceClass, response: result.response ?? null,
    events: result.events, delivered: result.response?.plans.map(p => p.type) ?? [],
    aiCalls: calls.ai.length, aiRequestKinds: api.__experiment?.aiStages ?? aiKinds,
    retry: api.__experiment?.aiStages.filter(stage => stage === 'retry').length ?? null,
    refill: api.__experiment?.aiStages.filter(stage => stage === 'refill').length ?? null,
    aiRequests: calls.ai.map(body => ({ stream: Boolean(body.stream), schema: body.response_format?.json_schema?.name,
      targetIds: /需重產的方案 ID：([^\n]*)/.exec(body.messages[0].content)?.[1] ?? null })),
    routes: calls.routes.length, places, repairCalls: api.__experiment?.repairCalls ?? null,
    expansionPasses: api.__experiment?.expansionPasses ?? null, validationCalls: api.__experiment?.validationCalls ?? null,
    ...(instrumentation === 'trace' ? { executionTrace: { locations: api.__experiment.locations,
      branches: api.__experiment.branches, b2Bounds: api.__experiment.b2Bounds,
      wrapperResults: api.__experiment.wrapperResults, validationResults: api.__experiment.validationResults,
      refillRequests: api.__experiment.refillRequests, refillPoolDispatch: api.__experiment.refillPoolDispatch, refillPrechecks: api.__experiment.refillPrechecks, refillDrafts, externalLedger } } : {}) }
} else {
  const { counts } = mockDurationQuality({ mock }, f)
  const raw = structuredClone(f.plan)
  const grounded = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
  for (const evidence of f.evidence ?? []) {
    const stop = grounded.stops.find(s => s.placeId === evidence.placeId)
    recordConfirmedActivityDuration(stop, { source: 'operator_schedule', reference: `fixture-booking/${kind}`, minutes: evidence.minutes })
  }
  recordCoverageSearch(f.candidates, [{ stage: 'initial', query: 'controlled_fixture_pool', radiusMeters: 5000,
    status: 'succeeded', count: f.candidates.allCandidates.length }])
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordCandidateSets(f.candidates)
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates, new Set(),
    'phase2a-isolated', f.crossPlanUsed, debug)
  const audit = debug.buildReport(result.plan ? [result.plan] : [])
  const shadow = result.plan ? getCoverageShadow(result.plan) : audit.coverageV2.attempts.at(-1)?.shadow
  const lastStage = audit.qualityDiagnostics.stages.at(-1)
  const selected = result.plan ?? api.__experiment?.lastPlan
  if (!selected) throw Error('No last checked plan available')
  const pipelineCalls = { ...counts }
  const opening = await validatePlanOpeningHours(selected, { ...f.input, startTime: selected.scheduleStartTime ?? f.input.startTime })
  const meal = getRequiredMealCoverageIssues(selected, f.input)
  const time = getCoverageTimeAccounting(selected, f.input)
  const requirements = assessVisitRequirements(selected, f.input, f.candidates)
  const coreSatisfied = requirements.every(r => r.status === 'satisfied')
  const routeEndpoints = selected.transportSegments.length === Math.max(0, selected.stops.length - 1) &&
    selected.transportSegments.every((leg, i) => leg.fromStopId === selected.stops[i].id && leg.toStopId === selected.stops[i + 1].id && !leg.label.includes('(估算)'))
  const capacityPassed = time.actualMinutes <= getScheduleCapacityMinutes(f.input)
  const necessaryPassed = !meal.length && !opening.length && capacityPassed && routeEndpoints && !result.routesFailed && time.tailOnly
  const traceStops = result.plan ? selected.stops.map(s => ({ stopId: s.id, placeId: s.placeId, name: s.name, ...getDurationTrace(s) }))
    : shadow.stops.map(s => ({ ...s, name: selected.stops.find(p => p.id === s.stopId)?.name }))
  const supportedCoverageAdded = traceStops.reduce((sum, stop) => sum + stop.events.filter(e => e.basis === 'coverage_padding' && e.delta > 0)
    .reduce((n,e) => n + Math.min(e.delta, Math.max(0, (stop.activityEvidence?.minutes ?? 0) - e.before)), 0), 0)
  output = { mode, kind, style, layer, evidenceClass: f.evidenceClass,
    input: { startTime: f.input.startTime, endTime: f.input.endTime, tags: f.input.tags, customCategory: f.input.customCategory },
    originalStops: raw.stops.map(s => ({ id: s.id, placeId: s.placeId, name: s.name, duration: s.duration })),
    groundedStops: grounded.stops.map(s => ({ id: s.id, placeId: s.placeId, duration: s.duration, trace: getDurationTrace(s) })),
    finalStops: traceStops, originalStay: raw.stops.reduce((n,s) => n+s.duration,0),
    finalStay: selected.stops.reduce((n,s) => n+s.duration,0), travel: selected.transportSegments.reduce((n,s)=>n+s.duration,0),
    coverageAdded: traceStops.reduce((n,s)=>n+s.coverageAddedMinutes,0),
    supportedCoverageAdded,
    unsupportedCoverageAdded: traceStops.reduce((n,s)=>n+s.coverageAddedMinutes,0) - supportedCoverageAdded,
    coverageRetained: traceStops.reduce((n,s)=>n+s.coverageRetainedMinutes,0), time,
    coveragePassed: time.actualMinutes >= getMinimumRequiredActualMinutes(f.input),
    delivered: Boolean(result.plan), issues: result.issues, necessaryPassed, mealIssues: meal,
    openingIssues: opening.map(issue => ({ reason: issue.reason, stopId: issue.stopId })), capacityPassed,
    routesPassed: routeEndpoints && !result.routesFailed, requirements, coreSatisfied,
    activityImpact: compareOriginalActivities(grounded.stops, selected.stops),
    originalIdsRetained: raw.stops.every(s=>selected.stops.some(p=>p.placeId===s.placeId)),
    rhythmIssues: getPlanRhythmIssues(selected,f.input),
    pipelineCalls, auditExtraCalls: { places: counts.places-pipelineCalls.places, routes: counts.routes-pipelineCalls.routes },
    retry: null, refill: null, retryRefillBasis: 'not_executed_in_repair_entry_see_handler_pairs',
    repairCalls: api.__experiment?.repairCalls ?? audit.qualityDiagnostics.stages.filter(s=>s.phase.endsWith(':input')).length,
    expansionPasses: api.__experiment?.expansionPasses ?? null,
    validationCalls: api.__experiment?.validationCalls ?? null,
    candidateComparisons: shadow.remedy.events.filter(e=>e.outcome==='route_comparison_completed').length,
    deliveryDecision: shadow.deliveryDecision, routesFailed: result.routesFailed, stopReason: shadow.stopReason, shadowClassification: shadow.classification, blockers: shadow.blockers,
    budgetExhausted: shadow.remedy.budgetExhausted, technicalFailure: shadow.remedy.technicalFailure,
    sourceSha256: api.__experiment?.sourceSha256 ?? null,
    pendingPositions: shadow.remedy.supplementPasses.reduce((n,p)=>n+p.pending,0),
    remedy: shadow.remedy, transitions: audit.qualityDiagnostics.transitions.map(t=>({phase:t.phase,reason:t.context.reason})),
    futureTailPotential: !time.coverageGapMinutes ? false : coreSatisfied && necessaryPassed && !shadow.remedy.budgetExhausted && !shadow.remedy.technicalFailure,
    lastObservedPhase: lastStage?.phase,
    ...(instrumentation === 'trace' ? { executionTrace: { locations: api.__experiment.locations,
      branches: api.__experiment.branches, b2Bounds: api.__experiment.b2Bounds,
      wrapperResults: api.__experiment.wrapperResults, validationResults: api.__experiment.validationResults,
      rawExecutionAudit: api.__experiment.shadowResults.at(-1)?.execution } } : {}) }
}
mock.restoreAll(); mock.timers.reset()
process.stdout.write(JSON.stringify(output))
