import type { PlanType, TripPlan } from '../../types/trip.js'
import { isTripPlanType } from './tripPlanIdentity.js'

const highlights = ['戶外活動', '文化場館', '咖啡停留', '餐飲停留', '主要活動', '休息與轉場'] as const
export type GenerationPreview = { type: PlanType; stopCount: number; highlights: string[]; sampleVenueNames: string[] }

function readVenueName(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
    && !/[<>]/.test(value) && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? value.trim() : null
}

// One stable sample for the entire request, shared by all styles/revisions.
// Never rotate samples: accumulated progress must not disclose the whole route.
export function createGenerationPreviewProjector() {
  let sample: string | undefined
  return (plan: Pick<TripPlan, 'type' | 'stops'>): GenerationPreview => {
    if (!sample && plan.stops.length > 1) {
      sample = plan.stops.map(stop => readVenueName(stop.name)).filter((name): name is string => !!name).sort()[0]
    }
    return projectGenerationPreview(plan, sample)
  }
}

// No IDs, coordinates, route order, durations or model prose leave this boundary.
export function projectGenerationPreview(plan: Pick<TripPlan, 'type' | 'stops'>, sample?: string): GenerationPreview {
  const labels = plan.stops.map(stop => {
    if (stop.foodSubtype === 'cafe' || stop.googleTypes?.includes('cafe')) return '咖啡停留'
    if (stop.type === 'food') return '餐飲停留'
    if (stop.googleTypes?.some(type => ['museum', 'art_gallery'].includes(type))) return '文化場館'
    if (stop.candidateRole === 'open_space' || stop.googleTypes?.some(type => ['park', 'city_park', 'national_park', 'hiking_area'].includes(type))) return '戶外活動'
    return stop.type === 'ending_or_transition' ? '休息與轉場' : '主要活動'
  })
  return { type: plan.type, stopCount: Math.min(plan.stops.length, 40), highlights: [...new Set(labels)].slice(0, 3),
    sampleVenueNames: plan.stops.length > 1 && sample && readVenueName(sample)
      && plan.stops.some(stop => readVenueName(stop.name) === sample) ? [sample] : [] }
}

export function readGenerationPreview(value: unknown): GenerationPreview | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isTripPlanType(v.type) || !Number.isInteger(v.stopCount) || (v.stopCount as number) < 0
    || (v.stopCount as number) > 40 || !Array.isArray(v.highlights)) return null
  return { type: v.type, stopCount: v.stopCount as number,
    highlights: [...new Set(v.highlights.filter((label): label is string =>
      typeof label === 'string' && highlights.some(allowed => allowed === label)))].slice(0, 3),
    sampleVenueNames: (v.stopCount as number) > 1 && Array.isArray(v.sampleVenueNames)
      ? v.sampleVenueNames.map(readVenueName).filter((name): name is string => !!name).slice(0, 1) : [] }
}

export function upsertGenerationPreview(current: GenerationPreview[], next: GenerationPreview) {
  return [...current.filter(preview => preview.type !== next.type), next].slice(-3)
}
