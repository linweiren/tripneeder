export const PLAN_IDS = ['safe', 'balanced', 'explore'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const EARLY_MORNING_ACTIVE_START_MINUTES = 6 * 60
export const MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES = 40 * 2 + 18
export const TIMELINE_START_GRANULARITY_MINUTES = 10
export const POST_TIMING_ALIGNMENT_MAX_PASSES = 3
export const MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES = 1
export const PLAN_DIVERSITY_ROTATION_STEP = 3

export type TripWindowInput = {
  startTime?: string
  endTime?: string
  tags: string[]
}

export type RequiredMealWindow = {
  id: 'lunch' | 'dinner'
  label: string
  start: number
  end: number
  preferredSlot: 'middle' | 'late'
}

export function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null

  const [hour, minute] = value.split(':').map(Number)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  return hour * 60 + minute
}

export function formatMinutesAsTime(totalMinutes: number) {
  const minutesInDay = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60)
  const hour = Math.floor(minutesInDay / 60)
  const minute = minutesInDay % 60

  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
}

export function getAllowedTripMinutes(input: TripWindowInput) {
  const start = parseTimeToMinutes(input.startTime)
  const end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null

  return end >= start ? end - start : end + 24 * 60 - start
}

export function getCoverageBasisMinutes(input: TripWindowInput) {
  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null
  if (end <= start) end += 24 * 60

  if (shouldUseEarlyMorningActiveWindow(start, end)) {
    return end - EARLY_MORNING_ACTIVE_START_MINUTES
  }

  return end - start
}

export function getScheduleCapacityMinutes(input: TripWindowInput) {
  return getCoverageBasisMinutes(input)
}

export function getMinimumRequiredActualMinutes(input: TripWindowInput) {
  const coverageBasisMinutes = getCoverageBasisMinutes(input)
  if (!coverageBasisMinutes) return null

  return Math.ceil(coverageBasisMinutes * getRequiredCoverageRatio(coverageBasisMinutes))
}

export function getOpeningHoursSearchStartMinutes(start: number, end: number) {
  if (shouldUseEarlyMorningActiveWindow(start, end)) {
    return EARLY_MORNING_ACTIVE_START_MINUTES
  }

  return start
}

export function shouldUseEarlyMorningActiveWindow(start: number, end: number) {
  return (
    start < EARLY_MORNING_ACTIVE_START_MINUTES &&
    end > EARLY_MORNING_ACTIVE_START_MINUTES &&
    end - EARLY_MORNING_ACTIVE_START_MINUTES >= MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES
  )
}

export function tripOverlapsMealWindow(
  input: TripWindowInput,
  windowStartMinutes: number,
  windowEndMinutes: number,
) {
  return getTripWindowOverlapMinutes(input, windowStartMinutes, windowEndMinutes) > 0
}

export function getTripWindowOverlapMinutes(
  input: TripWindowInput,
  windowStartMinutes: number,
  windowEndMinutes: number,
) {
  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return 0
  if (end <= start) end += 24 * 60

  return [0, 24 * 60].reduce((maxOverlap, dayOffset) => {
    const windowStart = windowStartMinutes + dayOffset
    const windowEnd = windowEndMinutes + dayOffset
    const overlap = Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart))

    return Math.max(maxOverlap, overlap)
  }, 0)
}

export function getRequiredCoverageRatio(allowedMinutes: number) {
  if (allowedMinutes <= 4 * 60) return 0.7
  if (allowedMinutes <= 8 * 60) return 0.75
  if (allowedMinutes <= 12 * 60) return 0.8

  return 0.7
}

export function getTargetCoverageRatio(allowedMinutes: number) {
  if (allowedMinutes <= 4 * 60) return 0.9
  if (allowedMinutes <= 8 * 60) return 0.88
  if (allowedMinutes <= 12 * 60) return 0.85

  return 0.8
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function getRequiredMealWindows(input: TripWindowInput): RequiredMealWindow[] {
  if (input.tags.includes('no_full_meals')) return []

  const mealWindows: RequiredMealWindow[] = [
    {
      id: 'lunch',
      label: '午餐',
      start: 11 * 60,
      end: 13 * 60,
      preferredSlot: 'middle',
    },
    {
      id: 'dinner',
      label: '晚餐',
      start: 17 * 60,
      end: 19 * 60,
      preferredSlot: 'late',
    },
  ]

  const tripWindow = getNormalizedTripWindow(input)
  if (!tripWindow) return []

  return mealWindows
    .flatMap((mealWindow) =>
      [0, 24 * 60]
        .map((dayOffset) => ({
          ...mealWindow,
          start: mealWindow.start + dayOffset,
          end: mealWindow.end + dayOffset,
        }))
        .filter(
          (window) =>
            Math.min(tripWindow.end, window.end) - Math.max(tripWindow.start, window.start) > 0,
        ),
    )
    .sort((left, right) => left.start - right.start)
}

function getNormalizedTripWindow(input: TripWindowInput) {
  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null
  if (end <= start) end += 24 * 60

  return { start, end }
}

export function getMealInsertionTargetMinutes(mealWindow: RequiredMealWindow) {
  return Math.floor((mealWindow.start + mealWindow.end) / 2)
}

export function isStopAlignedWithMealWindow(
  arrivalMinutes: number | undefined,
  durationMinutes: number,
  mealWindow: RequiredMealWindow,
) {
  if (typeof arrivalMinutes !== 'number') return false

  return (
    getVisitMealWindowOverlapMinutes(arrivalMinutes, durationMinutes, mealWindow) >=
    MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES
  )
}

export function getVisitMealWindowOverlapMinutes(
  arrivalMinutes: number,
  durationMinutes: number,
  mealWindow: RequiredMealWindow,
) {
  const leaveMinutes = arrivalMinutes + Math.max(0, durationMinutes)

  return Math.max(
    0,
    Math.min(leaveMinutes, mealWindow.end) - Math.max(arrivalMinutes, mealWindow.start),
  )
}
