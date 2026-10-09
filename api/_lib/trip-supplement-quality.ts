import type { Stop, TransportMode, TransportSegment } from '../../src/types/trip.js'
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
export type SupplementRouteContext = { calls: number; totalCalls: number; cacheHits: number;
  memo: Map<string, Promise<Route | null>> }
export function createSupplementRouteContext(): SupplementRouteContext {
  return { calls: 0, totalCalls: 0, cacheHits: 0, memo: new Map() }
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
      if (apiFailed || !Number.isFinite(duration) || duration! <= 0) return null
      return { duration: duration!, distanceMeters: routeInfo?.distanceMeters,
        label: buildTransportLabel(mode, undefined, routeInfo?.distanceMeters, false) }
    }))
  } else context.cacheHits++
  return context.memo.get(key)!
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
    context.calls - roundStart + required > SUPPLEMENT_ROUTE_BUDGET.perRound) return null
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
  if (stops.length === 0 || !stops.every(hasCoordinates)) {
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
          context.calls - roundStart + required > SUPPLEMENT_ROUTE_BUDGET.perRound) continue
        const routeResults = Promise.all(edges.map(edge => {
          return resolveRoute(context, edge.from, edge.to, mode, true)
        }))
        pending.push(routeResults.then(routes => {
          if (routes.some(route => !route)) { failed = true; return }
          const deltaTravel = routes.reduce((n, route) => n + route!.duration, 0) -
            (index < stops.length ? segments[index - 1].duration : 0)
          // Charge capacity to the newcomer, never shorten or delete an original stop to fit it.
          const activityMinutes = Math.min(proposal.stop.duration, getMaximumStopDuration(proposal.stop),
            capacity - originalMinutes - deltaTravel)
          if (activityMinutes < getMinimumStopDuration(proposal.stop)) return
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
          if (!open || !originalMealCoverage.every(window => trialStops.some((stop, i) =>
            stop.type === 'food' && isStopAlignedWithMealWindow(
              getEstimatedArrivalMinutesForStop(trialStops, i, input, trialSegments), stop.duration, window)))) return
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
  return { choice, routesFailed: !choice && failed, calls: context.calls - roundStart }
}
