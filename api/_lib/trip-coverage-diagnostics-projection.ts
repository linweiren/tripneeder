import { createHash } from 'node:crypto'

// Persistence boundary only. Never feed projected or truncated evidence into Repair.
const LIMIT = { final: 3, attempts: 12, stops: 40, durationEvents: 16, remedyEvents: 64,
  passes: 16, search: 32, codes: 16, reference: 65536, rowBytes: 64 * 1024, bytes: 256 * 1024 } as const
const BASIS = ['confirmed_activity', 'type_reference', 'ai_unverified', 'coverage_padding', 'unknown', 'mixed']
const REASONS = ['grounding', 'meal_alignment', 'capacity', 'opening_alignment', 'coverage_existing',
  'coverage_target', 'duration_bounds', 'redistribution', 'replacement', 'unknown']
const STOP_REASONS = ['core_requirement_unmet_or_unconfirmed', 'necessary_condition_failed', 'technical_failure',
  'comparison_budget_exhausted', 'normal_coverage_reached', 'candidates_remain_unevaluated',
  'bounded_scope_evaluated', 'bounded_pool_insufficient', 'remedy_incomplete_or_unobserved',
  'selected', 'route_failure', 'candidates_or_positions_unprocessed', 'missing_route_coordinates']
const BLOCKERS = ['core_requirement_not_confirmed', 'timeline_not_continuous_tail_only', 'opening_hours_unverified',
  'first_stop_distance_unverified', 'search_provenance_unavailable', 'candidate_source_failure',
  'comparison_budget_exhausted', 'technical_failure', 'unevaluated_candidates_or_positions',
  'remedy_timeline_changed_or_unobserved', 'reasonable_remedy_not_established']
const OUTCOMES = ['attempt_started', 'activity_loss_rejected', 'gap_observed', 'candidates_unprocessed',
  'first_stop_distance_rejected', 'core_activity_loss_rejected', 'comparison_budget_exhausted', 'route_failure',
  'route_comparison_completed', 'travel_rejected', 'activity_rhythm_rejected', 'opening_or_capacity_rejected',
  'delivery_conditions_rejected', 'selected', 'considered', 'existing_route_reused', 'capacity_or_first_distance_rejected',
  'meal_rejected', 'opening_rejected', 'feasible', 'unknown_coverage_window', 'route_timings_unverified',
  'existing_pool_observed', 'api_or_invalid_route_failure', 'missing_route_coordinates', 'already_used',
  'opening_hours_unknown', 'never_open', 'coordinates_unknown', 'route_timing_hint_only', 'capacity_rejected',
  'feasible_not_selected_score_travel_activity_reuse', 'pass_finished']
const TIME_NUMBERS = ['requestedMinutes', 'actualMinutes', 'normalMinimumMinutes', 'coverageGapMinutes',
  'unarrangedMinutes', 'startDelayMinutes', 'earlyMorningExceptionMinutes', 'tailBlankMinutes', 'timelineEnd', 'requestedEnd']
const STOP_NUMBERS = ['aiOriginalMinutes', 'initialMinutes', 'finalMinutes', 'coverageAddedMinutes',
  'coverageRetainedMinutes', 'confirmedActivityMinutes']
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}

export function projectCoverageDiagnostics(value: unknown) {
  const incomplete = new Set<string>()
  const mark = (reason: string) => { incomplete.add(reason) }
  const list = (value: unknown, limit: number): unknown[] => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) { mark('invalid_value'); return [] }
    if (value.length > limit) mark('array_truncated')
    return value.slice(0, limit)
  }
  const code = (value: unknown, allowed: readonly string[]) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'string' && allowed.includes(value)) return value
    mark('unknown_code'); return null
  }
  const numeric = (value: unknown) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9) return value
    mark('invalid_value'); return null
  }
  const bool = (value: unknown) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value
    mark('invalid_value'); return null
  }
  const numbers = (value: Record<string, unknown>, fields: readonly string[]) =>
    Object.fromEntries(fields.map(key => [key, numeric(value[key])]))
  const digest = (value: unknown) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || value.length > LIMIT.reference) { mark('reference_omitted'); return null }
    return createHash('sha256').update(value).digest('hex')
  }
  const codes = (value: unknown, allowed: readonly string[]) => list(value, LIMIT.codes).map(item => code(item, allowed))
  const hardIssue = (value: unknown) => {
    if (typeof value !== 'string') { mark('invalid_value'); return 'validation_issue' }
    // Do not retain stop names or external error text embedded in validation strings.
    if (/opening_hours|營業|關門/.test(value)) return 'opening_validation'
    if (/minimum_stay|時間|時長|停留/.test(value)) return 'duration_validation'
    if (/first_stop_distance|公里|km/.test(value)) return 'distance_validation'
    if (/餐|meal/.test(value)) return 'meal_validation'
    return 'validation_issue'
  }
  const stops = (value: unknown) => list(value, LIMIT.stops).map(item => {
    const stop = obj(item), evidence = obj(stop.activityEvidence)
    return { stopIdSha256: digest(stop.stopId), placeIdSha256: digest(stop.placeId),
      ...numbers(stop, STOP_NUMBERS), origin: code(stop.origin, BASIS), finalBasis: code(stop.finalBasis, BASIS),
      hasConfirmedActivityDuration: bool(stop.hasConfirmedActivityDuration),
      minuteAttributionBasis: code(stop.minuteAttributionBasis, ['accounting_last_added_first_removed_not_activity_verification']),
      coverageAddedMinutesBasis: code(stop.coverageAddedMinutesBasis, ['gross_history_not_net_remaining']),
      activityEvidence: stop.activityEvidence == null ? null : {
        source: code(evidence.source, ['operator_schedule', 'verified_activity_record']),
        referenceSha256: digest(evidence.reference), minutes: numeric(evidence.minutes) },
      currentMinuteSources: list(stop.currentMinuteSources, LIMIT.durationEvents).map(item => {
        const source = obj(item)
        return { basis: code(source.basis, BASIS), minutes: numeric(source.minutes) }
      }),
      events: list(stop.events, LIMIT.durationEvents).map(item => {
        const event = obj(item)
        return { reason: code(event.reason, REASONS), basis: code(event.basis, BASIS),
          ...numbers(event, ['before', 'after', 'delta']), identityChanged: bool(event.identityChanged),
          beforePlaceIdSha256: digest(event.beforePlaceId), afterPlaceIdSha256: digest(event.afterPlaceId) }
      }) }
  })
  const shadow = (value: unknown) => {
    if (value === null || value === undefined) return null
    const raw = obj(value), time = obj(raw.time), necessary = obj(raw.necessaryConditions), remedy = obj(raw.remedy)
    return { version: numeric(raw.version), internalOnly: bool(raw.internalOnly),
      classification: code(raw.classification, ['A', 'B', 'C', 'D']), coreSatisfied: bool(raw.coreSatisfied),
      fulfillment: code(raw.fulfillment, ['original_requirements_satisfied', 'legal_alternative_original_unmet',
        'executable_original_unconfirmed', 'execution_failed_or_unverified']),
      stopReason: code(raw.stopReason, STOP_REASONS), blockers: codes(raw.blockers, BLOCKERS),
      remedyTimelineMatches: bool(raw.remedyTimelineMatches), nearbyOptionsAvailability: code(raw.nearbyOptionsAvailability, ['unknown']),
      time: { ...numbers(time, TIME_NUMBERS), continuous: bool(time.continuous), tailOnly: bool(time.tailOnly),
        timelineBasis: code(time.timelineBasis, ['continuous_stays_plus_existing_routes_no_interstop_wait_representation']) },
      necessaryConditions: { passed: bool(necessary.passed), hoursConfirmed: bool(necessary.hoursConfirmed),
        hardIssues: list(necessary.hardIssues, LIMIT.codes).map(hardIssue) },
      requirements: list(raw.requirements, LIMIT.codes).map(item => {
        const requirement = obj(item)
        return { theme: code(requirement.theme, ['culture', 'coffee', 'outdoor']),
          cultureTypes: codes(requirement.cultureTypes, ['museum', 'art_gallery']),
          status: code(requirement.status, ['satisfied', 'alternative', 'unknown', 'unmet']),
          fulfillment: code(requirement.fulfillment, ['satisfied', 'alternative', 'not_confirmed']),
          otherOptionsAvailability: code(requirement.otherOptionsAvailability, ['unknown']) }
      }),
      // Query text, coordinates, raw responses and complete candidate pools are deliberately omitted.
      search: list(raw.search, LIMIT.search).map(item => {
        const search = obj(item)
        return { stage: code(search.stage, ['initial', 'gap', 'firstStop', 'supplement']),
          status: code(search.status, ['succeeded', 'failed', 'unavailable']), count: numeric(search.count) }
      }),
      remedy: { budgetExhausted: bool(remedy.budgetExhausted), technicalFailure: bool(remedy.technicalFailure),
        events: list(remedy.events, LIMIT.remedyEvents).map(item => {
          const event = obj(item)
          return { kind: code(event.kind, ['supplement', 'meal', 'demand', 'route', 'repair']),
            outcome: code(event.outcome, OUTCOMES), placeIdSha256: digest(event.placeId), position: numeric(event.position),
            routeComparisonCompleted: bool(event.routeComparisonCompleted),
            demandGap: code(event.demandGap, ['coverage_below_normal_minimum', 'lunch', 'dinner', '文化活動',
              '博物館', '美術展覽', '咖啡廳', '戶外景點']) }
        }),
        supplementPasses: list(remedy.supplementPasses, LIMIT.passes).map(item => {
          const pass = obj(item)
          return { scope: code(pass.scope, ['existing_supplied_pool', 'supplied_pool_up_to_three_candidates_two_positions']),
            timelineSignatureSha256: digest(pass.timelineSignature), ...numbers(pass, ['pending', 'eligible', 'compared']),
            stopReason: code(pass.stopReason, STOP_REASONS) }
        }) },
      stops: stops(raw.stops) }
  }
  // Final plans get the detail budget first. Oversized rows retain their decision,
  // time accounting and uncertainty flags; omitted detail is never silently complete.
  let remaining = LIMIT.bytes - 4096
  const row = (value: unknown) => {
    const raw = obj(value)
    let projected = { planId: code(raw.planId, ['safe', 'balanced', 'explore']), shadow: shadow(raw.shadow), stops: stops(raw.stops) }
    const bytes = () => Buffer.byteLength(JSON.stringify(projected))
    if (bytes() > LIMIT.rowBytes || bytes() > remaining) {
      mark('byte_limit')
      if (projected.shadow) projected = { ...projected, stops: [], shadow: { ...projected.shadow, stops: [], search: [],
        remedy: { ...projected.shadow.remedy, events: [], supplementPasses: [] } } }
      else projected.stops = []
    }
    remaining -= bytes()
    return projected
  }
  const raw = obj(value)
  const final = list(raw.final, LIMIT.final).map(row)
  const attempts = list(raw.attempts, LIMIT.attempts).map(row)
  // A global final guard also covers many individually small rows accumulating.
  if (Buffer.byteLength(JSON.stringify({ final, attempts })) > LIMIT.bytes - 4096) {
    mark('byte_limit')
    for (const item of [...final, ...attempts]) {
      item.stops = []
      if (item.shadow) {
        item.shadow.stops = []; item.shadow.search = []
        item.shadow.remedy.events = []; item.shadow.remedy.supplementPasses = []
      }
    }
  }
  return { final, attempts, projection: { version: 1, incomplete: incomplete.size > 0,
    reasons: [...incomplete], limits: LIMIT } }
}
