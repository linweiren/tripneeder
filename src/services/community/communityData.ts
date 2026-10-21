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
  return value.filter((item): item is SharedTripFeedRow => {
    if (!item || typeof item !== 'object') return false
    const trip = item as Partial<SharedTripFeedRow>
    const plan = trip.plan as Partial<TripPlan> | undefined
    if (typeof trip.id !== 'string' || !trip.id || seen.has(trip.id) || !plan ||
      typeof plan.id !== 'string' || typeof plan.title !== 'string' ||
      typeof plan.budget !== 'number' || !Number.isFinite(plan.budget) ||
      !Array.isArray(plan.stops) || !plan.stops.every((stop) => stop && typeof stop === 'object') ||
      typeof trip.author_display_name !== 'string' || typeof trip.created_at !== 'string' ||
      !Number.isFinite(trip.like_count) || !Number.isFinite(trip.comment_count) ||
      !Number.isFinite(trip.view_count) || !Array.isArray(trip.tags) ||
      !trip.tags.every((tag) => typeof tag === 'string')) return false
    seen.add(trip.id)
    return true
  })
}

export function sanitizeSharedPlan(plan: TripPlan): TripPlan {
  const stripCoordinates = <T extends { lat?: number; lng?: number }>(item: T) => {
    const safe = { ...item }
    delete safe.lat
    delete safe.lng
    return safe
  }
  return {
    ...plan,
    stops: plan.stops.map(stripCoordinates),
    rainBackup: plan.rainBackup.map(stripCoordinates),
  }
}
