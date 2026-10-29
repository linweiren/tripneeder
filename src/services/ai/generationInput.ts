import type { TripInput } from '../../types/trip'

// Only effective trip preferences belong in the durable generation identity.
export function normalizeGenerationInput(value: unknown): TripInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as TripInput
  if (!v.location || typeof v.location.name !== 'string' || !Array.isArray(v.tags)
    || !v.tags.every(tag => typeof tag === 'string')
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.startTime)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.endTime)) return null
  const input = JSON.parse(JSON.stringify({ category: v.category, customCategory: v.customCategory,
    startTime: v.startTime, endTime: v.endTime, transportMode: v.transportMode, budget: v.budget,
    people: v.people, tags: v.tags, location: { name: v.location.name, lat: v.location.lat, lng: v.location.lng } })) as TripInput
  return JSON.stringify(input).length <= 16000 ? input : null
}

export function sameGenerationInput(a: unknown, b: unknown) {
  const left = normalizeGenerationInput(a), right = normalizeGenerationInput(b)
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right)
}
