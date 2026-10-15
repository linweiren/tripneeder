import type { TripInput, TripPlan, TransportSegment } from '../types/trip'

const LOOSE_TRIP_THRESHOLD = 0.8

export function getAllowedTripMinutes(input: TripInput | null) {
  if (!input) {
    return null
  }

  const start = parseTimeToMinutes(input.startTime)
  const end = parseTimeToMinutes(input.endTime)

  if (typeof start !== 'number' || typeof end !== 'number') {
    return null
  }

  return end >= start ? end - start : end + 24 * 60 - start
}

export function getPlanActualDuration(plan: TripPlan) {
  return getTimelineDuration(plan.stops ?? [], plan.transportSegments ?? [])
}

export function getTimelineDuration(
  stops: Array<{ duration: number }> = [],
  transportSegments: TransportSegment[] = [],
) {
  return (
    stops.reduce((total, stop) => total + stop.duration, 0) +
    transportSegments.reduce((total, segment) => total + segment.duration, 0)
  )
}

export function isLooseTripDuration(
  actualMinutes: number,
  allowedMinutes: number | null,
) {
  if (!allowedMinutes || allowedMinutes <= 0) {
    return false
  }

  return actualMinutes / allowedMinutes < LOOSE_TRIP_THRESHOLD
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return null
  }

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}
