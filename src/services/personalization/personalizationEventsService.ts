import { supabase } from '../auth/supabaseClient'
import type { PlanType, Stop, StopType, TripCategory, TripPlan, TripTag } from '../../types/trip'
import {
  buildPreferenceProfile,
  type PreferenceProfileEventType,
  type PreferenceProfile,
} from './preferenceProfile'
import {
  mapPersonalizationEventRow,
  type PersonalizationEventSnapshot,
} from './personalizationEventRows'

export type PersonalizationEventType = PreferenceProfileEventType
export type { PersonalizationEventSnapshot }

export type PersonalizationEventInput = {
  userId: string
  eventType: PersonalizationEventType
  placeId?: string | null
  placeName?: string | null
  stopType?: StopType | null
  googleTypes?: string[] | null
  candidateRole?: Stop['candidateRole'] | null
  foodSubtype?: Stop['foodSubtype'] | null
  lat?: number | null
  lng?: number | null
  planId?: string | null
  planType?: PlanType | null
  inputCategory?: TripCategory | null
  inputTags?: TripTag[] | null
  eventSnapshot?: PersonalizationEventSnapshot | null
}

export type PersonalizationEventRecord = PersonalizationEventInput & {
  id: string
  createdAt: string
}

const MAX_PERSONALIZATION_EVENTS = 30
const DEDUPE_WINDOW_MS = 1500

let lastEventKey = ''
let lastEventAt = 0

export async function recordPersonalizationEvent(input: PersonalizationEventInput) {
  if (!supabase || !input.userId) return
  if (isDuplicateRecentEvent(input)) return

  try {
    const { error } = await supabase.from('personalization_events').insert(toEventRow(input))
    if (error) throw error
    await trimPersonalizationEvents(input.userId)
  } catch (error) {
    console.error('recordPersonalizationEvent error:', error)
  }
}

export async function loadRecentPersonalizationEvents(userId: string, limit = MAX_PERSONALIZATION_EVENTS) {
  if (!supabase || !userId) return []

  const boundedLimit = Math.min(Math.max(1, limit), MAX_PERSONALIZATION_EVENTS)
  const { data, error } = await supabase
    .from('personalization_events')
    .select(
      'id,user_id,event_type,place_id,place_name,stop_type,google_types,candidate_role,food_subtype,lat,lng,plan_id,plan_type,input_category,input_tags,event_snapshot,created_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(boundedLimit)

  if (error || !data) {
    if (error) console.error('loadRecentPersonalizationEvents error:', error)
    return []
  }

  return data.map(mapEventRow)
}

export async function loadPreferenceProfile(userId: string): Promise<PreferenceProfile> {
  const events = await loadRecentPersonalizationEvents(userId, MAX_PERSONALIZATION_EVENTS)
  return buildPreferenceProfile(events)
}

export function buildStopPersonalizationEvent({
  userId,
  eventType,
  stop,
  plan,
  inputCategory,
  inputTags,
}: {
  userId: string
  eventType: Extract<PersonalizationEventType, 'open_maps' | 'start_navigation'>
  stop: Stop
  plan: TripPlan
  inputCategory?: TripCategory | null
  inputTags?: TripTag[] | null
}): PersonalizationEventInput {
  return {
    userId,
    eventType,
    placeId: stop.placeId ?? null,
    placeName: stop.name || null,
    stopType: stop.type,
    googleTypes: stop.googleTypes ?? null,
    candidateRole: stop.candidateRole ?? null,
    foodSubtype: stop.foodSubtype ?? null,
    lat: normalizeCoordinate(stop.lat),
    lng: normalizeCoordinate(stop.lng),
    planId: plan.id,
    planType: plan.type,
    inputCategory: inputCategory ?? null,
    inputTags: inputTags ?? null,
  }
}

export function buildFavoritePlanPersonalizationEvent({
  userId,
  plan,
  inputCategory,
  inputTags,
}: {
  userId: string
  plan: TripPlan
  inputCategory?: TripCategory | null
  inputTags?: TripTag[] | null
}): PersonalizationEventInput {
  return {
    userId,
    eventType: 'favorite_plan',
    planId: plan.id,
    planType: plan.type,
    inputCategory: inputCategory ?? null,
    inputTags: inputTags ?? null,
    eventSnapshot: {
      planTitle: plan.title,
      stopCount: plan.stops.length,
      stops: plan.stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        type: stop.type,
        placeId: stop.placeId,
        googleTypes: stop.googleTypes,
        candidateRole: stop.candidateRole,
        foodSubtype: stop.foodSubtype,
        lat: stop.lat,
        lng: stop.lng,
        duration: stop.duration,
      })),
    },
  }
}

async function trimPersonalizationEvents(userId: string) {
  const { data, error } = await supabase!
    .from('personalization_events')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(MAX_PERSONALIZATION_EVENTS, 1000)

  if (error) throw error
  if (!data || data.length === 0) return

  const { error: deleteError } = await supabase!
    .from('personalization_events')
    .delete()
    .in('id', data.map((row) => row.id))

  if (deleteError) throw deleteError
}

function toEventRow(input: PersonalizationEventInput) {
  return {
    user_id: input.userId,
    event_type: input.eventType,
    place_id: input.placeId ?? null,
    place_name: input.placeName ?? null,
    stop_type: input.stopType ?? null,
    google_types: normalizeStringArray(input.googleTypes),
    candidate_role: input.candidateRole ?? null,
    food_subtype: input.foodSubtype ?? null,
    lat: normalizeCoordinate(input.lat),
    lng: normalizeCoordinate(input.lng),
    plan_id: input.planId ?? null,
    plan_type: input.planType ?? null,
    input_category: input.inputCategory ?? null,
    input_tags: normalizeStringArray(input.inputTags),
    event_snapshot: input.eventSnapshot ?? null,
  }
}

function mapEventRow(row: Record<string, unknown>): PersonalizationEventRecord {
  return mapPersonalizationEventRow(row)
}

function isDuplicateRecentEvent(input: PersonalizationEventInput) {
  const now = Date.now()
  const key = getDedupeKey(input)
  const isDuplicate = key === lastEventKey && now - lastEventAt < DEDUPE_WINDOW_MS
  lastEventKey = key
  lastEventAt = now
  return isDuplicate
}

function getDedupeKey(input: PersonalizationEventInput) {
  return [
    input.userId,
    input.eventType,
    input.placeId ?? '',
    input.placeName ?? '',
    input.stopType ?? '',
    input.planId ?? '',
    input.planType ?? '',
    input.inputCategory ?? '',
    (input.inputTags ?? []).join(','),
  ].join('|')
}

function normalizeStringArray(value: readonly string[] | null | undefined) {
  if (!value || value.length === 0) return null
  return value.filter((item) => item.trim().length > 0)
}

function normalizeCoordinate(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
