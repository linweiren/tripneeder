import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { resolveCandidateRankingContext } from './candidate-ranking-context.js'
import { getCachedOpeningHoursForDurationComparison, hasConfirmedCulturalPrimaryPurpose,
  isCandidateOpenForVisit, calculateDistance, FIRST_STOP_MAX_DISTANCE_KM,
  type NearbyPlaceCandidates, type VerifiedPlaceCandidate } from './google-places.js'
import { getActivityPurpose } from './trip-activity-purpose.js'
import { getMaximumStopDuration, getMinimumStopDuration, getPlanActualDuration } from './trip-plan-metrics.js'
import { getMinimumRequiredActualMinutes, getRequiredMealWindows, getScheduleCapacityMinutes,
  isStopAlignedWithMealWindow, parseTimeToMinutes } from './trip-planning-rules.js'
import { getRequiredMealCoverageIssues } from './trip-quality-rules.js'
import { getEstimatedPlanArrivalMinutes } from './trip-timeline.js'

export type CapacityDurationLoss = { before: number; minutes: number; purpose: string }
export function durationStopKey(stop: Stop) {
  return JSON.stringify([stop.id, stop.placeId, stop.type])
}

export function recordCapacityDurationLoss(before: TripPlan, after: TripPlan,
  losses: Map<string, CapacityDurationLoss>) {
  for (const stop of before.stops) {
    const next = after.stops.find(item => durationStopKey(item) === durationStopKey(stop))
    const key = durationStopKey(stop)
    if (next && next.duration < stop.duration) {
      const previous = losses.get(key)
      losses.set(key, { before: previous?.before ?? stop.duration,
        minutes: (previous?.minutes ?? 0) + stop.duration - next.duration, purpose: getActivityPurpose(stop) })
    }
  }
}

// Positive venue evidence only. A failed cultural classifier never makes a donor.
function isNaturalOpenSpace(stop: Stop, candidate: VerifiedPlaceCandidate) {
  return stop.type !== 'food' && candidate.role === 'open_space' &&
    candidate.types?.includes('natural_feature') && getActivityPurpose(stop) === 'open_space' &&
    getActivityPurpose({ ...stop, googleTypes: candidate.types, candidateRole: candidate.role }) === 'open_space'
}

export function proposeStopDurationRedistribution(plan: TripPlan, input: TripInput,
  candidates: NearbyPlaceCandidates, losses: Map<string, CapacityDurationLoss>) {
  const intent = resolveCandidateRankingContext(input)
  if (!intent.themes.includes('culture') || intent.themes.includes('outdoor')) return null
  const known = new Map(candidates.allCandidates.map(candidate => [candidate.placeId, candidate]))
  const receivers: Array<{ index: number; minutes: number }> = []
  const donors: Array<{ index: number; minutes: number }> = []
  for (const [index, stop] of plan.stops.entries()) {
    if (!Number.isSafeInteger(stop.duration) || stop.duration <= 0) return null
    const candidate = known.get(stop.placeId ?? '')
    if (!candidate || candidate.name !== stop.name) return null
    const loss = losses.get(durationStopKey(stop))
    if (stop.type !== 'food' && loss?.purpose === 'culture' && getActivityPurpose(stop) === 'culture' &&
      hasConfirmedCulturalPrimaryPurpose(candidate)) {
      const minutes = Math.min(loss.before, stop.duration + loss.minutes, getMaximumStopDuration(stop)) - stop.duration
      if (minutes > 0) receivers.push({ index, minutes })
    }
    // Only the excess above a soft reference can fund restoration. This says nothing
    // about the venue having no value; an unrecognised art venue is left untouched.
    if (isNaturalOpenSpace(stop, candidate)) {
      const minutes = stop.duration - getMaximumStopDuration(stop)
      if (minutes > 0) donors.push({ index, minutes })
    }
  }
  const restoredMinutes = receivers.reduce((sum, item) => sum + item.minutes, 0)
  if (!restoredMinutes || donors.reduce((sum, item) => sum + item.minutes, 0) < restoredMinutes) return null
  // One deterministic full-restoration comparison, no search, weights or quality score.
  const stops = plan.stops.map(stop => ({ ...stop }))
  receivers.forEach(item => { stops[item.index].duration += item.minutes })
  let remaining = restoredMinutes
  for (const donor of donors) {
    const transferred = Math.min(remaining, donor.minutes)
    stops[donor.index].duration -= transferred
    remaining -= transferred
  }
  return { plan: { ...plan, stops }, restoredMinutes, activitySupport: 'unknown' as const }
}

/** Local, fixed-start validation only; never changes the existing hard validation gates. */
export function getDurationRedistributionIssues(before: TripPlan, after: TripPlan, input: TripInput,
  candidates: NearbyPlaceCandidates) {
  const fail = (reason: string) => [reason]
  if (before.stops.length !== after.stops.length || before.scheduleStartTime !== after.scheduleStartTime ||
    before.transportSegments !== after.transportSegments || before.stops.some((stop, i) =>
      durationStopKey(stop) !== durationStopKey(after.stops[i]) || stop.name !== after.stops[i].name ||
      getActivityPurpose(stop) !== getActivityPurpose(after.stops[i]) ||
      (stop.type === 'food' && stop.duration !== after.stops[i].duration))) return fail('identity_order_purpose_or_routes_changed')
  const requestedStart = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)
  if (requestedStart === null || end === null || requestedStart === end) return fail('unknown_time_window')
  if (end < requestedStart) end += 1440
  const arrivals = getEstimatedPlanArrivalMinutes(after, input)
  const actual = getPlanActualDuration(after)
  const minimum = getMinimumRequiredActualMinutes(input), capacity = getScheduleCapacityMinutes(input)
  if (!arrivals.length || arrivals[0] < requestedStart || arrivals.at(-1)! + after.stops.at(-1)!.duration > end ||
    minimum === null || capacity === null || actual < minimum || actual > capacity ||
    actual !== getPlanActualDuration(before) || after.totalTime !== before.totalTime) return fail('time_window_or_coverage_changed')
  const known = new Map(candidates.allCandidates.map(candidate => [candidate.placeId, candidate]))
  const first = after.stops[0], firstCandidate = known.get(first?.placeId ?? '')
  const distance = Number.isFinite(firstCandidate?.distanceKm) ? firstCandidate!.distanceKm!
    : Number.isFinite(input.location.lat) && Number.isFinite(input.location.lng) &&
      Number.isFinite(first?.lat) && Number.isFinite(first?.lng)
      ? calculateDistance(input.location.lat!, input.location.lng!, first.lat!, first.lng!) : null
  if (distance === null || distance > FIRST_STOP_MAX_DISTANCE_KM) return fail('first_stop_distance_unverified')
  for (const [index, stop] of after.stops.entries()) {
    if (stop.duration < getMinimumStopDuration(stop)) return fail('minimum_stay')
    const candidate = known.get(stop.placeId ?? '')
    const hours = stop.placeId ? getCachedOpeningHoursForDurationComparison(stop.placeId) : null
    if (!candidate || !hours?.isKnown || !isCandidateOpenForVisit({ ...candidate, openingHours: hours },
      arrivals[index], stop.duration)) return fail('opening_hours_or_closing_buffer_unverified')
  }
  if (getRequiredMealCoverageIssues(before, input).length || getRequiredMealCoverageIssues(after, input).length) return fail('required_meal_window')
  // A different cafe cannot silently take over a required meal's former purpose.
  const previousArrivals = getEstimatedPlanArrivalMinutes(before, input)
  const windows = getRequiredMealWindows({ ...input, scheduleStartTime: before.scheduleStartTime })
  for (const [index, stop] of before.stops.entries()) {
    if (stop.type === 'food' && windows.some(window =>
      isStopAlignedWithMealWindow(previousArrivals[index], stop.duration, window) &&
      !isStopAlignedWithMealWindow(arrivals[index], after.stops[index].duration, window))) return fail('existing_meal_purpose_lost')
  }
  return []
}
