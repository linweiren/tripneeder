import { createHash } from 'node:crypto'
import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { assessCoverageDelivery } from './trip-coverage-delivery.js'
import { assessVisitRequirements, getForbiddenVisitIssues } from './trip-demand-compliance.js'
import { resolveCandidateRankingContext } from './candidate-ranking-context.js'
import { isCandidateOpenForVisit, type NearbyPlaceCandidates, type VerifiedPlaceCandidate } from './google-places.js'
import { getPlanActualDuration, getMinimumStopDuration } from './trip-plan-metrics.js'
import { getAllowedTripMinutes, getMinimumRequiredActualMinutes, getMealTimelineStartMinutes,
  getOpeningHoursSearchStartMinutes, parseTimeToMinutes, type TripWindowInput } from './trip-planning-rules.js'
import { getRequiredMealCoverageIssues } from './trip-quality-rules.js'

// Sidecars only: never serialized into TripPlan or used by delivery/selection gates.
export type DurationBasis = 'confirmed_activity' | 'type_reference' | 'ai_unverified' | 'coverage_padding' | 'unknown'
export type DurationReason = 'grounding' | 'meal_alignment' | 'capacity' | 'opening_alignment' |
  'coverage_existing' | 'coverage_target' | 'duration_bounds' | 'redistribution' | 'replacement' | 'unknown'
type DurationEvent = { reason: DurationReason; before: number | null; after: number; delta: number | null;
  beforePlaceId: string | null; afterPlaceId: string | null; identityChanged: boolean; basis: DurationBasis }
type ActivityEvidence = { source: 'operator_schedule' | 'verified_activity_record'; reference: string; minutes: number }
type DurationTrace = { aiOriginalMinutes: number | null; initialMinutes: number; origin: DurationBasis;
  activityEvidence: ActivityEvidence | null; events: DurationEvent[] }
const durationTraces = new WeakMap<Stop, DurationTrace>()
const shadows = new WeakMap<TripPlan, ReturnType<typeof assessCoverageV2>>()
export type SearchObservation = { stage: string; query: string; radiusMeters: number; status: 'succeeded' | 'failed' | 'unavailable'; count: number; placeIds?: string[] }
const searches = new WeakMap<NearbyPlaceCandidates, SearchObservation[]>()
export function recordCoverageSearch(pool: NearbyPlaceCandidates, observations: SearchObservation[]) {
  searches.set(pool, structuredClone(observations))
}
export function recordAiDurations(plan: TripPlan) {
  for (const stop of [...plan.stops, ...(plan.rainBackup ?? [])]) if (!durationTraces.has(stop)) {
    durationTraces.set(stop, { aiOriginalMinutes: Number.isFinite(stop.duration) ? stop.duration : null,
      initialMinutes: stop.duration, origin: 'ai_unverified', activityEvidence: null, events: [] })
  }
}
// No current Places/type/name/model path calls this. Confirmation requires an explicit
// non-model activity record, whose reference remains inspectable in the sidecar.
export function recordConfirmedActivityDuration(stop: Stop, evidence: ActivityEvidence) {
  if (!evidence.reference.trim() || !Number.isFinite(evidence.minutes) || evidence.minutes <= 0) return
  const trace = durationTraces.get(stop) ?? emptyTrace(stop)
  durationTraces.set(stop, { ...trace, activityEvidence: { ...evidence } })
}
function emptyTrace(stop: Stop): DurationTrace {
  return { aiOriginalMinutes: null, initialMinutes: stop.duration, origin: 'unknown', activityEvidence: null, events: [] }
}
export function traceDurationStops(before: readonly Stop[], after: readonly Stop[], reason: DurationReason) {
  for (const next of after) {
    // Specialized substeps already own this object; a later grouped transition must
    // not erase its lineage or count its coverage extension a second time.
    if (durationTraces.has(next)) continue
    const previous = before.find(stop => stop.id === next.id)
    const trace = previous ? durationTraces.get(previous) ?? emptyTrace(previous) : emptyTrace(next)
    const identityChanged = Boolean(previous && (previous.placeId !== next.placeId || previous.type !== next.type || previous.name !== next.name))
    const changed = !previous || identityChanged || previous.duration !== next.duration
    const basis: DurationBasis = reason.startsWith('coverage_') ? 'coverage_padding'
      : ['grounding', 'replacement', 'redistribution', 'duration_bounds'].includes(reason) ? 'type_reference' : 'unknown'
    durationTraces.set(next, { ...trace, activityEvidence: identityChanged ? null : trace.activityEvidence,
      events: changed ? [...trace.events, { reason, before: previous?.duration ?? null, after: next.duration,
        delta: previous ? next.duration - previous.duration : null,
        beforePlaceId: previous?.placeId ?? null, afterPlaceId: next.placeId ?? null, identityChanged, basis }] : [...trace.events] })
  }
}
export function traceDurationPlan<T extends TripPlan>(before: TripPlan, after: T, reason: DurationReason = 'unknown'): T {
  traceDurationStops(before.stops, after.stops, reason)
  traceDurationStops(before.rainBackup ?? [], after.rainBackup ?? [], reason)
  if (shadows.has(before) && !shadows.has(after) && before.stops === after.stops &&
    before.transportSegments === after.transportSegments && before.scheduleStartTime === after.scheduleStartTime) {
    shadows.set(after, shadows.get(before)!)
  }
  return after
}
export function getDurationTrace(stop: Stop) {
  const trace = durationTraces.get(stop) ?? emptyTrace(stop)
  const added = trace.events.filter(event => event.basis === 'coverage_padding' && (event.delta ?? 0) > 0)
    .reduce((sum, event) => sum + event.delta!, 0)
  const allocations: Array<{ basis: DurationBasis; minutes: number }> = [{ basis: trace.origin, minutes: trace.initialMinutes }]
  for (const event of trace.events) {
    if (event.identityChanged || event.before === null) {
      allocations.splice(0, allocations.length, { basis: event.basis, minutes: event.after })
    } else if (event.delta! > 0) allocations.push({ basis: event.basis, minutes: event.delta! })
    else {
      let remaining = -(event.delta ?? 0)
      for (let i = allocations.length - 1; i >= 0 && remaining > 0; i--) {
        const removed = Math.min(remaining, allocations[i].minutes)
        allocations[i].minutes -= removed
        remaining -= removed
      }
    }
  }
  const currentMinuteSources = allocations.filter(item => item.minutes > 0)
  return { ...structuredClone(trace), finalMinutes: stop.duration, currentMinuteSources,
    minuteAttributionBasis: 'accounting_last_added_first_removed_not_activity_verification',
    coverageRetainedMinutes: currentMinuteSources.filter(item => item.basis === 'coverage_padding')
      .reduce((sum, item) => sum + item.minutes, 0),
    confirmedActivityMinutes: Math.min(stop.duration, trace.activityEvidence?.minutes ?? 0),
    hasConfirmedActivityDuration: Boolean(trace.activityEvidence),
    coverageAddedMinutes: added, coverageAddedMinutesBasis: 'gross_history_not_net_remaining',
    finalBasis: trace.activityEvidence ? trace.activityEvidence.minutes >= stop.duration ? 'confirmed_activity' : 'mixed' : currentMinuteSources.length === 1 ? currentMinuteSources[0].basis : 'mixed' }
}

export type RemedyEvent = { kind: 'supplement' | 'meal' | 'demand' | 'route' | 'repair';
  outcome: string; placeId?: string; position?: number; routeComparisonCompleted?: boolean;
  demandGap?: string; details?: string }
export type RemedyTrace = { events: RemedyEvent[]; budgetExhausted: boolean; technicalFailure: boolean;
  // Completeness is local to a specific bounded pass, never a nearby-world claim.
  supplementPasses: Array<{ scope: string; timelineSignature: string; poolSignature?: string; unprocessedPoolCandidates?: number;
    pending: number; eligible: number; compared: number; stopReason: string }> }
export function createRemedyTrace(): RemedyTrace {
  return { events: [], budgetExhausted: false, technicalFailure: false, supplementPasses: [] }
}

// Match the existing merged supplemental pool, not just its shortlist. Metadata
// changes invalidate a completed pass. Only the digest crosses persistence.
export function getRemedyPoolSignature(...pools: VerifiedPlaceCandidate[][]) {
  const candidates = new Map<string, VerifiedPlaceCandidate>()
  for (const pool of pools) for (const candidate of pool)
    if (candidate.placeId && !candidates.has(candidate.placeId)) candidates.set(candidate.placeId, candidate)
  return createHash('sha256').update(JSON.stringify([...candidates].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, c]) => [id, c.name, c.lat, c.lng, c.distanceKm, c.types, c.role, c.foodSubtype, c.score, c.openingHours]))).digest('hex')
}

export function getRemedyTimelineSignature(plan: Pick<TripPlan, 'stops' | 'transportSegments' | 'scheduleStartTime'>,
  input: TripWindowInput) {
  return JSON.stringify([input.startTime, input.endTime,
    getMealTimelineStartMinutes({ ...input, scheduleStartTime: plan.scheduleStartTime }),
    plan.stops.map(stop => [stop.id, stop.placeId, stop.name, stop.type, stop.duration, stop.lat, stop.lng]),
    plan.transportSegments.map(leg => [leg.fromStopId, leg.toStopId, leg.mode, leg.duration, leg.label])])
}

export function getCoverageTimeAccounting(plan: TripPlan, input: TripInput) {
  const requestedMinutes = getAllowedTripMinutes(input)
  const actualMinutes = getPlanActualDuration(plan)
  const normalMinimumMinutes = getMinimumRequiredActualMinutes(input)
  const start = parseTimeToMinutes(input.startTime), rawEnd = parseTimeToMinutes(input.endTime)
  const end = start === null || rawEnd === null ? null : rawEnd < start ? rawEnd + 1440 : rawEnd
  const effectiveStart = getMealTimelineStartMinutes({ ...input, scheduleStartTime: plan.scheduleStartTime })
  const permittedStart = start === null || end === null ? null : getOpeningHoursSearchStartMinutes(start, end)
  const continuous = plan.stops.length > 0 && plan.transportSegments.length === plan.stops.length - 1 &&
    plan.stops.every(stop => Number.isFinite(stop.duration) && stop.duration > 0) &&
    plan.transportSegments.every((leg, index) => leg.fromStopId === plan.stops[index].id &&
      leg.toStopId === plan.stops[index + 1].id && Number.isFinite(leg.duration) && leg.duration > 0 &&
      !leg.label?.includes('(估算)'))
  const timelineEnd = continuous && effectiveStart !== null ? effectiveStart + actualMinutes : null
  return { requestedMinutes, actualMinutes, normalMinimumMinutes,
    coverageGapMinutes: normalMinimumMinutes === null ? null : Math.max(0, normalMinimumMinutes - actualMinutes),
    unarrangedMinutes: requestedMinutes === null ? null : Math.max(0, requestedMinutes - actualMinutes),
    startDelayMinutes: effectiveStart === null || start === null ? null : effectiveStart - start,
    earlyMorningExceptionMinutes: permittedStart === null || start === null ? null : permittedStart - start,
    tailBlankMinutes: timelineEnd === null || end === null ? null : Math.max(0, end - timelineEnd),
    continuous, timelineEnd, requestedEnd: end,
    tailOnly: continuous && effectiveStart !== null && effectiveStart === permittedStart &&
      timelineEnd !== null && end !== null && timelineEnd <= end,
    timelineBasis: 'continuous_stays_plus_existing_routes_no_interstop_wait_representation' }
}

export function assessCoverageV2(plan: TripPlan, input: TripInput, candidates: NearbyPlaceCandidates,
  remedy: RemedyTrace, validation: { issues: string[]; routesFailed: boolean }) {
  const time = getCoverageTimeAccounting(plan, input)
  const requirements = assessVisitRequirements(plan, input, candidates)
  const intentKnown = resolveCandidateRankingContext(input).customStatus !== 'unknown'
  const coreSatisfied = intentKnown && requirements.every(item => item.status === 'satisfied')
  const hardIssues = [...validation.issues.filter(issue => !/^行程時長不足（目前 \d+ 分鐘，至少需要 \d+ 分鐘）$/.test(issue)), ...getRequiredMealCoverageIssues(plan, input),
    ...getForbiddenVisitIssues(plan, input, candidates)]
  const known = new Map(candidates.allCandidates.map(candidate => [candidate.placeId, candidate]))
  let arrival = getMealTimelineStartMinutes({ ...input, scheduleStartTime: plan.scheduleStartTime })
  let hoursConfirmed = arrival !== null
  for (const [index, stop] of plan.stops.entries()) {
    const candidate = known.get(stop.placeId ?? '')
    if (!candidate?.openingHours?.isKnown || arrival === null) hoursConfirmed = false
    else if (!isCandidateOpenForVisit(candidate, arrival, stop.duration)) hardIssues.push('opening_hours')
    if (stop.duration < getMinimumStopDuration(stop)) hardIssues.push('minimum_stay')
    if (arrival !== null) arrival += stop.duration + (plan.transportSegments[index]?.duration ?? 0)
  }
  const first = known.get(plan.stops[0]?.placeId ?? '')
  const firstDistanceConfirmed = Number.isFinite(first?.distanceKm) && first!.distanceKm! <= 2
  if (Number.isFinite(first?.distanceKm) && first!.distanceKm! > 2) hardIssues.push('first_stop_distance')
  const source = searches.get(candidates)
  const sourceFailed = source?.some(item => item.status !== 'succeeded') ?? false
  const pending = remedy.supplementPasses.some(pass => pass.pending > 0) || remedy.events.some(event => event.outcome === 'candidates_unprocessed')
  const timelineMatches = remedy.supplementPasses.at(-1)?.timelineSignature === getRemedyTimelineSignature(plan, input)
  const localComplete = timelineMatches && remedy.supplementPasses.length > 0 && !pending &&
    remedy.supplementPasses.at(-1)!.stopReason === 'bounded_scope_evaluated' &&
    remedy.supplementPasses.at(-1)!.compared > 0
  const blockers = [
    ...(!coreSatisfied ? ['core_requirement_not_confirmed'] : []),
    ...(!time.tailOnly ? ['timeline_not_continuous_tail_only'] : []),
    ...(!hoursConfirmed ? ['opening_hours_unverified'] : []),
    ...(!firstDistanceConfirmed ? ['first_stop_distance_unverified'] : []),
    ...(!source?.length ? ['search_provenance_unavailable'] : []),
    ...(sourceFailed ? ['candidate_source_failure'] : []),
    ...(remedy.budgetExhausted ? ['comparison_budget_exhausted'] : []),
    ...(remedy.technicalFailure || validation.routesFailed ? ['technical_failure'] : []),
    ...(pending ? ['unevaluated_candidates_or_positions'] : []),
    ...(!timelineMatches ? ['remedy_timeline_changed_or_unobserved'] : []),
    ...(!localComplete ? ['reasonable_remedy_not_established'] : []),
  ]
  const necessaryPassed = hardIssues.length === 0 && firstDistanceConfirmed && hoursConfirmed && time.tailOnly && !validation.routesFailed
  const classification = !coreSatisfied || hardIssues.length > 0 || validation.routesFailed ||
    time.timelineEnd !== null && time.requestedEnd !== null && time.timelineEnd > time.requestedEnd ? 'D'
    : time.coverageGapMinutes === 0 && necessaryPassed ? 'A'
    : time.coverageGapMinutes !== null && time.coverageGapMinutes > 0 && necessaryPassed && !blockers.length ? 'C' : 'B'
  const stopReason = !coreSatisfied ? 'core_requirement_unmet_or_unconfirmed' : hardIssues.length ? 'necessary_condition_failed' : validation.routesFailed || remedy.technicalFailure || sourceFailed ? 'technical_failure'
    : remedy.budgetExhausted ? 'comparison_budget_exhausted'
    : time.coverageGapMinutes === 0 ? 'normal_coverage_reached'
    : pending ? 'candidates_remain_unevaluated' : localComplete ? 'bounded_scope_evaluated'
    : remedy.supplementPasses.some(pass => pass.eligible === 0) ? 'bounded_pool_insufficient' : 'remedy_incomplete_or_unobserved'
  const lastPass = remedy.supplementPasses.at(-1)
  const poolMatches = lastPass?.poolSignature === getRemedyPoolSignature(
    candidates.otherCandidates, candidates.firstStopCandidates, candidates.allCandidates)
  const boundedRemedyCompleted = Boolean(lastPass && lastPass.pending === 0 && lastPass.unprocessedPoolCandidates === 0 &&
    lastPass.scope === 'supplied_pool_up_to_three_candidates_two_positions' &&
    ((lastPass.stopReason === 'bounded_scope_evaluated' && lastPass.eligible > 0 && lastPass.compared > 0) ||
      (lastPass.stopReason === 'bounded_pool_insufficient' && lastPass.eligible === 0 && lastPass.compared === 0)))
  const deliveryDecision = assessCoverageDelivery({ coreSatisfied,
    coreUnconfirmed: !intentKnown || requirements.some(item => item.status === 'unknown'),
    necessaryPassed, coverageGapMinutes: time.coverageGapMinutes,
    timelineMatches, poolMatches, sourceObserved: Boolean(source?.length), sourceFailed,
    technicalFailure: remedy.technicalFailure || validation.routesFailed,
    budgetExhausted: remedy.budgetExhausted,
    pending: pending || (lastPass?.unprocessedPoolCandidates ?? 0) > 0, boundedRemedyCompleted })
  return { version: 1, classification, internalOnly: true, deliveryDecision, time, requirements, coreSatisfied,
    fulfillment: coreSatisfied ? 'original_requirements_satisfied' : requirements.some(item => item.status === 'alternative') && necessaryPassed
      ? 'legal_alternative_original_unmet' : necessaryPassed ? 'executable_original_unconfirmed' : 'execution_failed_or_unverified',
    necessaryConditions: { passed: necessaryPassed, hoursConfirmed, hardIssues }, blockers,
    stopReason, remedyTimelineMatches: timelineMatches, nearbyOptionsAvailability: 'unknown', search: source ?? [], remedy: structuredClone(remedy),
    stops: plan.stops.map(stop => ({ stopId: stop.id, placeId: stop.placeId ?? null, ...getDurationTrace(stop) })) }
}
export function recordCoverageShadow(plan: TripPlan, input: TripInput, pool: NearbyPlaceCandidates,
  remedy: RemedyTrace, validation: { issues: string[]; routesFailed: boolean }) {
  const result = assessCoverageV2(plan, input, pool, remedy, validation)
  shadows.set(plan, result)
  return result
}
export function getCoverageShadow(plan: TripPlan) { return shadows.get(plan) ?? null }
