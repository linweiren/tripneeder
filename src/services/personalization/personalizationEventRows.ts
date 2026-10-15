import type {
  PlanType,
  Stop,
  StopType,
  TripCategory,
  TripTag,
} from '../../types/trip'
import type {
  PreferenceProfileEvent,
  PreferenceProfileEventType,
} from './preferenceProfile'

export type PersonalizationEventSnapshot = {
  planTitle?: string
  stopCount?: number
  stops?: Array<{
    id: string
    name: string
    type: StopType
    placeId?: string
    googleTypes?: string[]
    candidateRole?: Stop['candidateRole']
    foodSubtype?: Stop['foodSubtype']
    lat?: number
    lng?: number
    duration?: number
  }>
}

export type PersonalizationEventRecordRow = {
  id: string
  userId: string
  eventType: PreferenceProfileEventType
  placeId: string | null
  placeName: string | null
  stopType: StopType | null
  googleTypes: string[] | null
  candidateRole: Stop['candidateRole'] | null
  foodSubtype: Stop['foodSubtype'] | null
  lat: number | null
  lng: number | null
  planId: string | null
  planType: PlanType | null
  inputCategory: TripCategory | null
  inputTags: TripTag[] | null
  eventSnapshot: PersonalizationEventSnapshot | null
  createdAt: string
}

export function mapPersonalizationEventRow(
  row: Record<string, unknown>,
): PersonalizationEventRecordRow {
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    eventType: row.event_type as PreferenceProfileEventType,
    placeId: nullableString(row.place_id),
    placeName: nullableString(row.place_name),
    stopType: row.stop_type as StopType | null,
    googleTypes: Array.isArray(row.google_types) ? row.google_types.map(String) : null,
    candidateRole: row.candidate_role as Stop['candidateRole'] | null,
    foodSubtype: row.food_subtype as Stop['foodSubtype'] | null,
    lat: typeof row.lat === 'number' ? row.lat : null,
    lng: typeof row.lng === 'number' ? row.lng : null,
    planId: nullableString(row.plan_id),
    planType: row.plan_type as PlanType | null,
    inputCategory: row.input_category as TripCategory | null,
    inputTags: Array.isArray(row.input_tags) ? row.input_tags.map(String) as TripTag[] : null,
    eventSnapshot: isRecord(row.event_snapshot)
      ? row.event_snapshot as PersonalizationEventSnapshot
      : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  }
}

export function mapPersonalizationEventRowToProfileEvent(
  row: Record<string, unknown>,
): PreferenceProfileEvent {
  const event = mapPersonalizationEventRow(row)

  return {
    eventType: event.eventType,
    placeId: event.placeId,
    placeName: event.placeName,
    stopType: event.stopType,
    googleTypes: event.googleTypes,
    candidateRole: event.candidateRole,
    foodSubtype: event.foodSubtype,
    planType: event.planType,
    inputCategory: event.inputCategory,
    inputTags: event.inputTags,
    eventSnapshot: event.eventSnapshot,
    createdAt: event.createdAt,
  }
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
