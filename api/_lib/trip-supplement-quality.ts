import { createRemedyTrace, getRemedyTimelineSignature, type RemedyTrace } from './trip-coverage-v2.js'
import type { Stop, TransportMode, TransportSegment } from '../../src/types/trip.js'
import { recordEvidenceCache } from './trip-acceptance-evidence.js'
import { isCandidateOpenForVisit, type VerifiedPlaceCandidate } from './google-places.js'
import { buildTransportLabel, estimateSegmentDuration, getRouteInfo } from './google-routes.js'
import { getMaximumStopDuration, getMinimumStopDuration } from './trip-plan-metrics.js'
import { getEstimatedArrivalMinutesForStop } from './trip-timeline.js'
import { getRequiredMealWindows, isStopAlignedWithMealWindow, type TripWindowInput } from './trip-planning-rules.js'

// Request budgets, not travel thresholds. Each repair attempt has one expansion pass.
export const SUPPLEMENT_ROUTE_BUDGET = { perRound: 8, perPlan: 24, candidates: 3, positions: 2 } as const
// Reuse the existing soft-diversity score tolerance; score already includes personalization.
export const SUPPLEMENT_SIMILAR_SCORE_TOLERANCE = 6

type Route = { duration: number; label: string; distanceMeters?: number }
// Distinguish actual successful Routes responses from caller-seeded timing hints.
const computedRoutes = new WeakSet<Route>()
export type SupplementRouteContext = { calls: number; totalCalls: number; cacheHits: number;
  memo: Map<string, Promise<Route | null>>; remedy: RemedyTrace }
export function createSupplementRouteContext(): SupplementRouteContext {
  return { calls: 0, totalCalls: 0, cacheHits: 0, memo: new Map(), remedy: createRemedyTrace() }
}

// Scoped to one plan's repair, including its conservative pass and optional quality fallback.
// Never seed this cache from the AI's unverified transport segments.
function resolveRoute(context: SupplementRouteContext, from: Stop, to: Stop,
  mode: TransportMode, comparison = false) {
  const key = routeKey(from, to, mode)
  if (!context.memo.has(key)) {
    context.totalCalls++
    if (comparison) context.calls++
    context.memo.set(key, getRouteInfo(from, to, mode).then(({ routeInfo, apiFailed }) => {
      const duration = routeInfo?.durationMinutes
      if (apiFailed || !Number.isFinite(duration) || duration! <= 0) {
        context.remedy.technicalFailure = true
        context.remedy.events.push({ kind: 'route', outcome: 'api_or_invalid_route_failure' })
        return null
      }
      const route = { duration: duration!, distanceMeters: routeInfo?.distanceMeters,
        label: buildTransportLabel(mode, undefined, routeInfo?.distanceMeters, false) }
      computedRoutes.add(route)
      return route
    }))
  } else { context.cacheHits++; recordEvidenceCache('routes') }
  return context.memo.get(key)!
}

export async function hasReusableStaticRouteTimings(context: SupplementRouteContext, plan: { stops: Stop[];
  transportSegments: TransportSegment[] }) {
  if (plan.transportSegments.length !== plan.stops.length - 1) return false
  for (let i = 0; i < plan.transportSegments.length; i++) {
    const segment = plan.transportSegments[i], from = plan.stops[i], to = plan.stops[i + 1]
    // google-routes uses computeRoutes without departureTime/routingPreference.
    // DRIVE/TWO_WHEELER default to TRAFFIC_UNAWARE (time-independent averages).
    // TRANSIT is time-dependent and cannot be revalidated from this memo.
    // https://developers.google.com/maps/documentation/routes/reference/rest/v2/RoutingPreference
    if (!['car', 'scooter'].includes(segment.mode) || !hasCoordinates(from) || !hasCoordinates(to) ||
      segment.fromStopId !== from.id || segment.toStopId !== to.id || !Number.isFinite(segment.duration) ||
      segment.duration <= 0) return false
    const pending = context.memo.get(routeKey(from, to, segment.mode))
    if (!pending) return false // Never resolve/fetch a missing edge.
    const route = await pending
    if (!route || !computedRoutes.has(route) || route.duration !== segment.duration) return false
  }
  return true
}

export function createRepairRouteResolver(context: SupplementRouteContext) {
  return async (segments: TransportSegment[], stops: Stop[], fallbackMode: TransportMode) => {
    let routesFailed = false
    const next = await Promise.all(stops.slice(1).map(async (to, i) => {
      const from = stops[i]
      const mode = segments[i]?.mode ?? fallbackMode
      const route = await resolveRoute(context, from, to, mode)
      if (!route) routesFailed = true
      return { fromStopId: from.id, toStopId: to.id, mode,
        publicTransitType: segments[i]?.publicTransitType,
        duration: route?.duration ?? estimateSegmentDuration(from, to, mode),
        label: buildTransportLabel(mode, segments[i]?.publicTransitType, route?.distanceMeters, !route) }
    }))
    return { segments: next, routesFailed }
  }
}

// Meal comparisons share the existing per-plan budget and trusted route memo.
// Mandatory final routing still uses the ordinary resolver and never bypasses validation.
export async function resolveMealComparisonRoutes(context: SupplementRouteContext,
  stops: Stop[], mode: TransportMode, roundStart: number) {
  const required = stops.slice(1).filter((to, i) => !context.memo.has(routeKey(stops[i], to, mode))).length
  if (context.calls + required > SUPPLEMENT_ROUTE_BUDGET.perPlan ||
    context.calls - roundStart + required > SUPPLEMENT_ROUTE_BUDGET.perRound) {
    context.remedy.budgetExhausted = true
    context.remedy.events.push({ kind: 'route', outcome: 'comparison_budget_exhausted' })
    return null
  }
  const routes = await Promise.all(stops.slice(1).map((to, i) =>
    resolveRoute(context, stops[i], to, mode, true)))
  if (routes.some(route => !route)) return { segments: [], routesFailed: true }
  return { routesFailed: false, segments: routes.map((route, i) => ({
    fromStopId: stops[i].id, toStopId: stops[i + 1].id, mode,
    duration: route!.duration, label: route!.label,
  })) }
}

type Choice = { candidate: VerifiedPlaceCandidate; index: number; stops: Stop[];
  segments: TransportSegment[]; deltaTravel: number; activityMinutes: number; repeated: boolean }
type Options = {
  stops: Stop[]; segments: TransportSegment[]; input: TripWindowInput; capacity: number;
  pool: VerifiedPlaceCandidate[]; allCandidates: VerifiedPlaceCandidate[];
  used: Set<string>; crossPlanUsed: Set<string>; mode: TransportMode;
  makeStop: (candidate: VerifiedPlaceCandidate) => Stop; context: SupplementRouteContext;
}

function hasCoordinates(stop: Stop) {
  return Number.isFinite(stop.lat) && Number.isFinite(stop.lng)
}
function routeKey(from: Stop, to: Stop, mode: TransportMode) {
  return `${from.lat},${from.lng}>${to.lat},${to.lng}:${mode}`
}
function score(candidate: VerifiedPlaceCandidate) {
  return Number.isFinite(candidate.score) ? candidate.score! : 0
}

export async function chooseSupplementalInsertion(options: Options) {
  const { stops, segments, input, capacity, context, makeStop } = options
  const roundStart = context.calls
  let failed = false
  const trace = context.remedy
  const timelineSignature = getRemedyTimelineSignature({ stops, transportSegments: segments,
    scheduleStartTime: input.scheduleStartTime }, input)
  const attempts = new Set<string>()
  const compared = new Set<string>()
  const event = (outcome: string, placeId?: string, position?: number, routeComparisonCompleted = false) => {
    trace.events.push({ kind: 'supplement', outcome, placeId, position, routeComparisonCompleted,
      demandGap: 'coverage_below_normal_minimum' })
  }
  if (stops.length === 0 || !stops.every(hasCoordinates)) {
    event('missing_route_coordinates')
    trace.supplementPasses.push({ scope: 'existing_supplied_pool', timelineSignature, eligible: 0, pending: options.pool.length,
      compared: 0, stopReason: 'missing_route_coordinates' })
    return { choice: undefined, routesFailed: false, calls: 0 }
  }
  const originalMinutes = stops.reduce((n, stop) => n + stop.duration, 0) +
    segments.reduce((n, segment) => n + segment.duration, 0)
  const known = new Map(options.allCandidates.map(candidate => [candidate.placeId, candidate]))
  const originalMealCoverage = getRequiredMealWindows(input).filter(window => stops.some((stop, i) =>
    stop.type === 'food' && isStopAlignedWithMealWindow(
      getEstimatedArrivalMinutesForStop(stops, i, input, segments), stop.duration, window)))

  // Seed only route timings checked by the caller against current stop endpoints.
  segments.forEach((segment, i) => {
    const key = routeKey(stops[i], stops[i + 1], segment.mode)
    if (!context.memo.has(key)) context.memo.set(key, Promise.resolve({ duration: segment.duration, label: segment.label }))
  })

  for (const candidate of options.pool) {
    if (options.used.has(candidate.placeId)) event('already_used', candidate.placeId)
    else if (!candidate.openingHours?.isKnown) event('opening_hours_unknown', candidate.placeId)
    else if (candidate.openingHours.isNeverOpen) event('never_open', candidate.placeId)
    else if (!hasCoordinates(makeStop(candidate))) event('coordinates_unknown', candidate.placeId)
    else event('considered', candidate.placeId)
  }
  const ranked = options.pool.filter(candidate => !options.used.has(candidate.placeId) &&
    candidate.openingHours?.isKnown && !candidate.openingHours.isNeverOpen && hasCoordinates(makeStop(candidate)))
    .sort((a, b) => score(b) - score(a) || a.placeId.localeCompare(b.placeId))

  const proposals = ranked.map(candidate => {
    const stop = makeStop(candidate)
    // Keep the verified first stop. Local geometry orders proposals, never establishes validity.
    const orderedPositions = stops.map((_previous, i) => {
      const index = i + 1
      const mode = segments[index - 1]?.mode ?? options.mode
      const removed = segments[index - 1]?.duration ?? 0
      const delta = estimateSegmentDuration(stops[index - 1], stop, mode) +
        (index < stops.length ? estimateSegmentDuration(stop, stops[index], mode) - removed : 0)
      return { index, mode, delta }
    }).sort((a, b) => a.delta - b.delta || a.index - b.index)
    // Also compare appending: it preserves every downstream opening/meal time.
    const tail = orderedPositions.find(position => position.index === stops.length)!
    const positions = [orderedPositions[0], orderedPositions[0] === tail ? orderedPositions[1] : tail]
      .filter((position): position is NonNullable<typeof position> => Boolean(position))
    return { candidate, stop, positions }
  })
  const shortlist: typeof proposals = []
  const add = (proposal: typeof proposals[number] | undefined) => {
    if (proposal && !shortlist.includes(proposal)) shortlist.push(proposal)
  }
  add(proposals[0]) // Always give the highest-quality candidate a chance, including distant places.
  add([...proposals].sort((a, b) => a.positions[0].delta - b.positions[0].delta ||
    score(b.candidate) - score(a.candidate))[0])
  add(proposals.find(p => !options.crossPlanUsed.has(p.candidate.placeId) &&
    score(p.candidate) >= score(proposals[0].candidate) - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE))
  for (const proposal of proposals) {
    if (shortlist.length >= SUPPLEMENT_ROUTE_BUDGET.candidates) break
    add(proposal)
  }

  const choices: Choice[] = []
  const highestScore = shortlist.length ? score(shortlist[0].candidate) : 0
  // Query the comparable quality band first. Clearly weaker candidates are fallback only.
  for (const group of [
    shortlist.filter(p => score(p.candidate) >= highestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE),
    shortlist.filter(p => score(p.candidate) < highestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE),
  ]) {
    const pending: Promise<void>[] = []
    // Round-robin: compare candidates before spending the remaining budget on second positions.
    for (let positionRank = 0; positionRank < SUPPLEMENT_ROUTE_BUDGET.positions; positionRank++) {
      for (const proposal of group) {
        const position = proposal.positions[positionRank]
        if (!position) continue
        const { index, mode } = position
        const edges = [{ from: stops[index - 1], to: proposal.stop },
          ...(index < stops.length ? [{ from: proposal.stop, to: stops[index] }] : [])]
        const required = edges.filter(edge => !context.memo.has(routeKey(edge.from, edge.to, mode))).length
        if (context.calls + required > SUPPLEMENT_ROUTE_BUDGET.perPlan ||
          context.calls - roundStart + required > SUPPLEMENT_ROUTE_BUDGET.perRound) {
          trace.budgetExhausted = true
          event('comparison_budget_exhausted', proposal.candidate.placeId, index)
          continue
        }
        attempts.add(`${proposal.candidate.placeId}:${index}`)
        const routeResults = Promise.all(edges.map(edge => {
          return resolveRoute(context, edge.from, edge.to, mode, true)
        }))
        pending.push(routeResults.then(routes => {
          if (routes.some(route => !route)) { failed = true; event('route_failure', proposal.candidate.placeId, index); return }
          const actualRoutes = routes.every(route => computedRoutes.has(route!))
          if (actualRoutes) compared.add(`${proposal.candidate.placeId}:${index}`)
          event(actualRoutes ? 'route_comparison_completed' : 'route_timing_hint_only', proposal.candidate.placeId, index, actualRoutes)
          const deltaTravel = routes.reduce((n, route) => n + route!.duration, 0) -
            (index < stops.length ? segments[index - 1].duration : 0)
          // Charge capacity to the newcomer, never shorten or delete an original stop to fit it.
          const activityMinutes = Math.min(proposal.stop.duration, getMaximumStopDuration(proposal.stop),
            capacity - originalMinutes - deltaTravel)
          if (activityMinutes < getMinimumStopDuration(proposal.stop)) { event('capacity_rejected', proposal.candidate.placeId, index, actualRoutes); return }
          const trialStops = [...stops]
          trialStops.splice(index, 0, { ...proposal.stop, duration: activityMinutes })
          const trialSegments = [...segments]
          trialSegments.splice(index - 1, index < stops.length ? 1 : 0, ...routes.map((route, i) => ({
            fromStopId: trialStops[index - 1 + i].id, toStopId: trialStops[index + i].id,
            mode, duration: route!.duration, label: route!.label,
          })))
          const open = trialStops.every((stop, i) => {
            const candidate = i === index ? proposal.candidate : known.get(stop.placeId ?? '')
            return candidate && isCandidateOpenForVisit(candidate,
              getEstimatedArrivalMinutesForStop(trialStops, i, input, trialSegments), stop.duration)
          })
          const mealsPreserved = originalMealCoverage.every(window => trialStops.some((stop, i) =>
            stop.type === 'food' && isStopAlignedWithMealWindow(
              getEstimatedArrivalMinutesForStop(trialStops, i, input, trialSegments), stop.duration, window)))
          if (!open || !mealsPreserved) {
            event(!open ? 'opening_rejected' : 'meal_rejected', proposal.candidate.placeId, index, actualRoutes)
            return
          }
          event('feasible', proposal.candidate.placeId, index, actualRoutes)
          choices.push({ candidate: proposal.candidate, index, stops: trialStops, segments: trialSegments,
            deltaTravel, activityMinutes, repeated: options.crossPlanUsed.has(proposal.candidate.placeId) })
        }))
      }
    }
    await Promise.all(pending)
    if (choices.length > 0) break
  }

  // Pareto elimination includes reuse as a soft dimension so comparable unseen places survive.
  const frontier = choices.filter(choice => !choices.some(other => other !== choice &&
    score(other.candidate) >= score(choice.candidate) && other.deltaTravel <= choice.deltaTravel &&
    other.activityMinutes >= choice.activityMinutes && Number(other.repeated) <= Number(choice.repeated) &&
    (score(other.candidate) > score(choice.candidate) || other.deltaTravel < choice.deltaTravel ||
      other.activityMinutes > choice.activityMinutes || Number(other.repeated) < Number(choice.repeated))))
  const bestScore = Math.max(...frontier.map(choice => score(choice.candidate)))
  const choice = frontier.filter(c => score(c.candidate) >= bestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE)
    .sort((a, b) => a.deltaTravel - b.deltaTravel || b.activityMinutes - a.activityMinutes ||
      Number(a.repeated) - Number(b.repeated) || score(b.candidate) - score(a.candidate) ||
      a.candidate.placeId.localeCompare(b.candidate.placeId) || a.index - b.index)[0]
  if (choice) event('selected', choice.candidate.placeId, choice.index, compared.has(`${choice.candidate.placeId}:${choice.index}`))
  for (const feasible of choices) if (feasible !== choice) event('feasible_not_selected_score_travel_activity_reuse',
    feasible.candidate.placeId, feasible.index, compared.has(`${feasible.candidate.placeId}:${feasible.index}`))
  const positionsPending = proposals.reduce((sum, proposal) => sum + proposal.positions.filter(position =>
    !compared.has(`${proposal.candidate.placeId}:${position.index}`)).length, 0)
  const unknownPending = options.pool.filter(candidate => !options.used.has(candidate.placeId) &&
    (!candidate.openingHours?.isKnown || !hasCoordinates(makeStop(candidate)))).length
  const pending = positionsPending + unknownPending
  trace.supplementPasses.push({ scope: 'supplied_pool_up_to_three_candidates_two_positions', timelineSignature,
    pending, eligible: ranked.length, compared: compared.size,
    stopReason: choice ? 'selected' : trace.budgetExhausted ? 'comparison_budget_exhausted'
      : failed ? 'route_failure' : pending ? 'candidates_or_positions_unprocessed'
      : ranked.length ? 'bounded_scope_evaluated' : 'bounded_pool_insufficient' })
  event('pass_finished', undefined, undefined, attempts.size > 0 && compared.size === attempts.size)
  return { choice, routesFailed: !choice && failed, calls: context.calls - roundStart }
}
