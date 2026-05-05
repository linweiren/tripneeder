import type { Stop, TripPlan } from '../../src/types/trip.js'
import {
  clamp,
  getAllowedTripMinutes,
  getOpeningHoursSearchStartMinutes,
  getScheduleCapacityMinutes,
  parseTimeToMinutes,
  type TripWindowInput,
} from './trip-planning-rules.js'
import {
  estimateTransportTotal,
  getMinimumStopDuration,
  getReasonablePlanDuration,
} from './trip-plan-metrics.js'

export function getEstimatedArrivalMinutesForStop(
  stops: Stop[],
  index: number,
  input: TripWindowInput,
  transportSegments?: TripPlan['transportSegments'],
) {
  const startMinutes = parseTimeToMinutes(input.startTime)
  let endMinutes = parseTimeToMinutes(input.endTime)
  const offsetMinutes = estimateOffsetBeforeStop(stops, index, transportSegments)

  if (startMinutes === null || endMinutes === null) {
    return offsetMinutes
  }
  if (endMinutes <= startMinutes) endMinutes += 24 * 60

  return getOpeningHoursSearchStartMinutes(startMinutes, endMinutes) + offsetMinutes
}

export function getRequiredAvailabilitySlotForStop(
  stops: Stop[],
  index: number,
  input: TripWindowInput,
  transportSegments?: TripPlan['transportSegments'],
) {
  const capacityMinutes =
    getScheduleCapacityMinutes(input) ??
    getAllowedTripMinutes(input) ??
    Math.max(getReasonablePlanDuration(stops) + estimateTransportTotal(stops), 1)
  const slotLength = Math.max(1, capacityMinutes / 3)
  const offsetMinutes = estimateOffsetBeforeStop(stops, index, transportSegments)

  if (offsetMinutes < slotLength) return 'early'
  if (offsetMinutes < slotLength * 2) return 'middle'
  return 'late'
}

export function findMealWindowInsertionIndex(
  nonFoodStops: Stop[],
  input: TripWindowInput,
  mealWindowStartMinutes: number,
) {
  const startMinutes = parseTimeToMinutes(input.startTime)
  let endMinutes = parseTimeToMinutes(input.endTime)

  if (startMinutes === null || endMinutes === null || nonFoodStops.length <= 1) {
    return clamp(Math.ceil(nonFoodStops.length * 0.65), 0, nonFoodStops.length)
  }

  if (endMinutes <= startMinutes) endMinutes += 24 * 60
  const scheduleStartMinutes = getOpeningHoursSearchStartMinutes(startMinutes, endMinutes)
  const targetOffsetMinutes = Math.max(0, mealWindowStartMinutes - scheduleStartMinutes)
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY

  for (let insertionIndex = 0; insertionIndex <= nonFoodStops.length; insertionIndex += 1) {
    const offsetMinutes = estimateOffsetBeforeInsertion(nonFoodStops, insertionIndex)
    const distance = Math.abs(offsetMinutes - targetOffsetMinutes)

    if (distance < bestDistance) {
      bestIndex = insertionIndex
      bestDistance = distance
    }
  }

  return bestIndex
}

export function estimateOffsetBeforeInsertion(stops: Stop[], insertionIndex: number) {
  let offsetMinutes = 0

  for (let index = 0; index < insertionIndex; index += 1) {
    offsetMinutes += Math.max(getMinimumStopDuration(stops[index]), Number(stops[index].duration) || 0)
    if (index < insertionIndex - 1) offsetMinutes += 18
  }

  if (insertionIndex > 0) offsetMinutes += 18
  return offsetMinutes
}

export function estimateOffsetBeforeStop(
  stops: Stop[],
  stopIndex: number,
  transportSegments?: TripPlan['transportSegments'],
) {
  let offsetMinutes = 0

  for (let index = 0; index < stopIndex; index += 1) {
    offsetMinutes += Math.max(getMinimumStopDuration(stops[index]), Number(stops[index].duration) || 0)
    offsetMinutes += transportSegments?.[index]?.duration ?? 18
  }

  return offsetMinutes
}

export function getEstimatedPlanArrivalMinutes(
  plan: TripPlan,
  input: TripWindowInput,
) {
  const startMinutes = parseTimeToMinutes(input.startTime)
  let endMinutes = parseTimeToMinutes(input.endTime)

  if (startMinutes === null || endMinutes === null) return []
  if (endMinutes <= startMinutes) endMinutes += 24 * 60

  const timelineStartMinutes = getOpeningHoursSearchStartMinutes(startMinutes, endMinutes)

  return plan.stops.map(
    (_stop, index) =>
      timelineStartMinutes +
      estimateOffsetBeforeStop(plan.stops, index, plan.transportSegments),
  )
}
