// Internal shadow policy only. No delivery, Repair, Refill or API consumer reads
// this result. null is an unresolved assessment, not a fifth delivery outcome.
export const COVERAGE_DELIVERY_STATUSES = ['complete', 'conditional_partial', 'alternative', 'unavailable'] as const
export const COVERAGE_DELIVERY_REASONS = ['normal_coverage_reached', 'bounded_remedy_completed',
  'original_demand_not_met', 'core_requirement_unconfirmed', 'necessary_condition_failed_or_unverified',
  'coverage_window_unverified', 'candidate_source_failure', 'search_provenance_unavailable',
  'technical_failure', 'comparison_budget_exhausted', 'unevaluated_candidates_or_positions',
  'remedy_timeline_changed_or_unobserved', 'remedy_pool_changed_or_unobserved',
  'reasonable_remedy_not_established'] as const
type Status = typeof COVERAGE_DELIVERY_STATUSES[number]
type Reason = typeof COVERAGE_DELIVERY_REASONS[number]
type Evidence = {
  coreSatisfied: boolean; coreUnconfirmed: boolean; necessaryPassed: boolean
  coverageGapMinutes: number | null; timelineMatches: boolean; poolMatches: boolean
  sourceObserved: boolean; sourceFailed: boolean; technicalFailure: boolean; budgetExhausted: boolean
  pending: boolean; boundedRemedyCompleted: boolean
}

export function assessCoverageDelivery(evidence: Evidence) {
  const e = evidence
  const reasons: Reason[] = []
  let status: Status | null = null
  // Failure/unverified execution is distinct from exhausted discovery. This does
  // not assert that no feasible real-world itinerary exists.
  if (!e.necessaryPassed) {
    status = 'unavailable'
    reasons.push('necessary_condition_failed_or_unverified')
    if (e.technicalFailure) reasons.push('technical_failure')
  } else if (!e.coreSatisfied) {
    if (e.coreUnconfirmed) reasons.push('core_requirement_unconfirmed')
    else { status = 'alternative'; reasons.push('original_demand_not_met') }
  } else if (e.coverageGapMinutes === 0) {
    status = 'complete'
    reasons.push('normal_coverage_reached')
  } else {
    if (e.coverageGapMinutes === null || !Number.isFinite(e.coverageGapMinutes) || e.coverageGapMinutes < 0)
      reasons.push('coverage_window_unverified')
    if (!e.sourceObserved) reasons.push('search_provenance_unavailable')
    if (e.sourceFailed) reasons.push('candidate_source_failure')
    if (e.technicalFailure) reasons.push('technical_failure')
    if (e.budgetExhausted) reasons.push('comparison_budget_exhausted')
    if (e.pending) reasons.push('unevaluated_candidates_or_positions')
    if (!e.timelineMatches) reasons.push('remedy_timeline_changed_or_unobserved')
    if (!e.poolMatches) reasons.push('remedy_pool_changed_or_unobserved')
    if (!e.boundedRemedyCompleted) reasons.push('reasonable_remedy_not_established')
    if (!reasons.length) { status = 'conditional_partial'; reasons.push('bounded_remedy_completed') }
  }
  return { version: 1, internalOnly: true, status, resolved: status !== null,
    originalDemand: e.coreSatisfied ? 'confirmed' : e.coreUnconfirmed ? 'unconfirmed' : 'not_met',
    executable: e.necessaryPassed, conditionalEligible: status === 'conditional_partial', reasons,
    normalCoverageReached: e.coverageGapMinutes === 0,
    remedy: { complete: e.boundedRemedyCompleted && e.timelineMatches && e.poolMatches &&
      e.sourceObserved && !e.sourceFailed && !e.pending && !e.technicalFailure && !e.budgetExhausted,
      timelineMatches: e.timelineMatches, poolMatches: e.poolMatches,
      pending: e.pending, technicalFailure: e.technicalFailure, budgetExhausted: e.budgetExhausted },
    scope: 'existing_supplied_pool_only', nearbyOptionsAvailability: 'unknown' }
}
