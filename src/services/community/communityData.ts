import type { TripPlan } from '../../types/trip'

export type SharedTripFeedRow = {
  id: string
  plan: TripPlan
  input: null
  tags: string[]
  author_display_name: string
  created_at: string
  like_count: number
  comment_count: number
  view_count: number
  liked_by_me: boolean
  reward_awarded: boolean
  is_owner: boolean
}

export function deduplicateAndValidateSharedTrips(value: unknown): SharedTripFeedRow[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const safeRows: SharedTripFeedRow[] = []
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue
    const trip = item as Partial<SharedTripFeedRow>
    const plan = trip.plan as Partial<TripPlan> | undefined
    if (typeof trip.id !== 'string' || !trip.id || trip.id.length > 100 || seen.has(trip.id) || !plan ||
      typeof plan.id !== 'string' || plan.id.length > 100 || typeof plan.title !== 'string' || plan.title.length > 120 ||
      typeof plan.budget !== 'number' || !Number.isFinite(plan.budget) || plan.budget < 0 ||
      !Array.isArray(plan.stops) || plan.stops.length > 30 || !plan.stops.every(isSafeFeedStop) ||
      !Array.isArray(plan.rainBackup) || plan.rainBackup.length > 20 || !plan.rainBackup.every(isSafeFeedStop) ||
      !Array.isArray(plan.transportSegments) || !Array.isArray(plan.rainTransportSegments) ||
      typeof trip.author_display_name !== 'string' || trip.author_display_name.length > 80 || typeof trip.created_at !== 'string' || Number.isNaN(Date.parse(trip.created_at)) ||
      !isSafeCount(trip.like_count) || !isSafeCount(trip.comment_count) ||
      !isSafeCount(trip.view_count) || !Array.isArray(trip.tags) || trip.tags.length > 2 ||
      !trip.tags.every((tag) => typeof tag === 'string' && tag.length <= 20)) continue
    seen.add(trip.id)
    safeRows.push({
      ...(trip as SharedTripFeedRow),
      plan: sanitizeSharedPlan(plan as TripPlan),
      input: null,
      tags: trip.tags,
      liked_by_me: trip.liked_by_me === true,
      reward_awarded: false,
      is_owner: trip.is_owner === true,
    })
  }
  return safeRows
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000
}

function isSafeFeedStop(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const stop = value as Record<string, unknown>
  return typeof stop.id === 'string' && stop.id.length <= 100 && typeof stop.name === 'string' && stop.name.length <= 200 &&
    typeof stop.duration === 'number' && Number.isFinite(stop.duration) && stop.duration >= 0 && stop.duration <= 1440
}

export function sanitizeSharedPlan(plan: TripPlan): TripPlan {
  const sanitizeStop = (stop: TripPlan['stops'][number], prefix: 'main' | 'rain', index: number) => ({
    id: `shared-${prefix}-${index + 1}`,
    name: (typeof stop.name === 'string' ? stop.name : '景點').slice(0, 120),
    type: ['main_activity', 'food', 'ending_or_transition'].includes(stop.type) ? stop.type : 'main_activity',
    description: '',
    address: '',
    duration: Math.max(0, Math.min(1440, Math.round(Number.isFinite(stop.duration) ? stop.duration : 0))),
    transport: undefined,
    googleTypes: stop.googleTypes?.filter((type) => typeof type === 'string' && /^[a-z0-9_]{1,50}$/i.test(type)).slice(0, 12),
    candidateRole: ['food', 'main_activity', 'open_space', 'shopping', 'short_visit'].includes(stop.candidateRole ?? '') ? stop.candidateRole : undefined,
    foodSubtype: ['cafe', 'dessert', 'restaurant', 'snack'].includes(stop.foodSubtype ?? '') ? stop.foodSubtype : undefined,
  })
  const safeSegments = (segments: TripPlan['transportSegments'], stops: TripPlan['stops'], prefix: 'main' | 'rain') =>
    segments.slice(0, 30).flatMap((segment) => {
      if (!segment || !['scooter', 'car', 'public_transit'].includes(segment.mode) || !Number.isFinite(segment.duration)) return []
      const from = stops.findIndex((stop) => stop.id === segment.fromStopId)
      const to = stops.findIndex((stop) => stop.id === segment.toStopId)
      if (from < 0 || to < 0) return []
      return [{
        fromStopId: `shared-${prefix}-${from + 1}`,
        toStopId: `shared-${prefix}-${to + 1}`,
        mode: segment.mode,
        publicTransitType: ['bus', 'metro', 'train', 'walk', 'mixed'].includes(segment.publicTransitType ?? '') ? segment.publicTransitType : undefined,
        duration: Math.max(0, Math.min(1440, Math.round(segment.duration))),
        label: segment.mode === 'public_transit' ? '大眾運輸' : segment.mode === 'car' ? '開車' : '騎乘機車',
      }]
    })
  return {
    id: plan.id.slice(0, 80),
    type: plan.type,
    title: plan.title.slice(0, 120),
    subtitle: '',
    summary: '',
    totalTime: Math.max(0, Math.min(10080, Math.round(plan.totalTime))),
    budget: Math.max(0, Math.min(100_000_000, Math.round(plan.budget))),
    transportMode: plan.transportMode,
    stops: plan.stops.slice(0, 30).map((stop, index) => sanitizeStop(stop, 'main', index)),
    transportSegments: safeSegments(plan.transportSegments, plan.stops.slice(0, 30), 'main'),
    rainBackup: plan.rainBackup.slice(0, 20).map((stop, index) => sanitizeStop(stop, 'rain', index)),
    rainTransportSegments: safeSegments(plan.rainTransportSegments, plan.rainBackup.slice(0, 20), 'rain'),
    scheduleStartTime: plan.scheduleStartTime,
    isDetailComplete: plan.isDetailComplete,
  }
}

export function getSharedPlanSignature(plan: TripPlan): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      )
    }
    return value
  }
  return JSON.stringify(normalize(sanitizeSharedPlan(plan)))
}
