import type {
  CandidateRole,
  FoodSubtype,
  PlanType,
  StopType,
  TripCategory,
  TripTag,
} from '../../types/trip'

export type PreferenceProfileEventType = 'open_maps' | 'start_navigation' | 'favorite_plan'

export type PreferenceScoreMap = Record<string, number>

export type PreferredPlace = {
  placeId: string
  placeName?: string
  score: number
  count: number
}

export type PreferenceProfile = {
  sampleCount: number
  updatedAt: string | null
  categoryScores: PreferenceScoreMap
  tagScores: PreferenceScoreMap
  stopTypeScores: PreferenceScoreMap
  googleTypeScores: PreferenceScoreMap
  candidateRoleScores: PreferenceScoreMap
  foodSubtypeScores: PreferenceScoreMap
  preferredPlaces: PreferredPlace[]
}

export type PreferenceProfileEvent = {
  eventType: PreferenceProfileEventType
  placeId?: string | null
  placeName?: string | null
  stopType?: StopType | null
  googleTypes?: string[] | null
  candidateRole?: CandidateRole | null
  foodSubtype?: FoodSubtype | null
  planType?: PlanType | null
  inputCategory?: TripCategory | null
  inputTags?: TripTag[] | null
  eventSnapshot?: unknown
  createdAt?: string | null
}

type FavoriteSnapshotStop = {
  id?: string
  name?: string
  placeName?: string
  stopType?: StopType
  type?: StopType
  placeId?: string
  googleTypes?: string[]
  candidateRole?: CandidateRole
  foodSubtype?: FoodSubtype
}

export type BuildPreferenceProfileOptions = {
  referenceTime?: Date | string
}

const EVENT_WEIGHTS: Record<PreferenceProfileEventType, number> = {
  open_maps: 1,
  start_navigation: 2,
  favorite_plan: 3,
}

const TIME_DECAY_HALF_LIFE_DAYS = 30
const MIN_EVENT_DECAY = 0.15
const MAX_GOOGLE_TYPES_PER_EVENT = 6
const MAX_PREFERRED_PLACES = 5
const SCORE_DECIMALS = 4
const MS_PER_DAY = 24 * 60 * 60 * 1000

export function buildPreferenceProfile(
  events: readonly PreferenceProfileEvent[],
  options: BuildPreferenceProfileOptions = {},
): PreferenceProfile {
  const referenceTimeMs = resolveReferenceTimeMs(events, options.referenceTime)
  const profile: PreferenceProfile = {
    sampleCount: events.length,
    updatedAt: getLatestCreatedAt(events),
    categoryScores: {},
    tagScores: {},
    stopTypeScores: {},
    googleTypeScores: {},
    candidateRoleScores: {},
    foodSubtypeScores: {},
    preferredPlaces: [],
  }
  const placeScores = new Map<string, PreferredPlace>()

  for (const event of events) {
    const baseWeight = EVENT_WEIGHTS[event.eventType] ?? 0
    if (baseWeight <= 0) continue

    const eventWeight = baseWeight * getTimeDecay(event.createdAt, referenceTimeMs)
    addProfileContextScores(profile, event, eventWeight)

    if (event.eventType === 'favorite_plan') {
      addFavoritePlanSignals(profile, placeScores, event, eventWeight)
      continue
    }

    addStopSignals(profile, placeScores, {
      placeId: event.placeId ?? undefined,
      placeName: event.placeName ?? undefined,
      stopType: event.stopType ?? undefined,
      googleTypes: event.googleTypes ?? undefined,
      candidateRole: event.candidateRole ?? undefined,
      foodSubtype: event.foodSubtype ?? undefined,
    }, eventWeight)
  }

  profile.preferredPlaces = getPreferredPlaces(placeScores)
  roundProfileScores(profile)
  return profile
}

function addProfileContextScores(
  profile: PreferenceProfile,
  event: PreferenceProfileEvent,
  weight: number,
) {
  if (event.inputCategory) {
    addScore(profile.categoryScores, event.inputCategory, weight)
  }

  const tags = uniqueStrings(event.inputTags)
  for (const tag of tags) {
    addScore(profile.tagScores, tag, weight / tags.length)
  }
}

function addFavoritePlanSignals(
  profile: PreferenceProfile,
  placeScores: Map<string, PreferredPlace>,
  event: PreferenceProfileEvent,
  eventWeight: number,
) {
  const stops = getFavoriteSnapshotStops(event.eventSnapshot)
  if (stops.length === 0) return

  const stopWeight = eventWeight / stops.length
  for (const stop of stops) {
    addStopSignals(profile, placeScores, stop, stopWeight)
  }
}

function addStopSignals(
  profile: PreferenceProfile,
  placeScores: Map<string, PreferredPlace>,
  stop: FavoriteSnapshotStop,
  weight: number,
) {
  if (stop.stopType ?? stop.type) {
    addScore(profile.stopTypeScores, (stop.stopType ?? stop.type)!, weight)
  }

  if (stop.candidateRole) {
    addScore(profile.candidateRoleScores, stop.candidateRole, weight)
  }

  if (stop.foodSubtype) {
    addScore(profile.foodSubtypeScores, stop.foodSubtype, weight)
  }

  const googleTypes = uniqueStrings(stop.googleTypes).slice(0, MAX_GOOGLE_TYPES_PER_EVENT)
  for (const googleType of googleTypes) {
    addScore(profile.googleTypeScores, googleType, weight / googleTypes.length)
  }

  if (stop.placeId) {
    addPlaceScore(placeScores, stop.placeId, stop.name ?? stop.placeName, weight)
  }
}

function getTimeDecay(createdAt: string | null | undefined, referenceTimeMs: number) {
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(referenceTimeMs)) return 1

  const ageDays = Math.max(0, (referenceTimeMs - createdAtMs) / MS_PER_DAY)
  return Math.max(MIN_EVENT_DECAY, Math.pow(0.5, ageDays / TIME_DECAY_HALF_LIFE_DAYS))
}

function resolveReferenceTimeMs(
  events: readonly PreferenceProfileEvent[],
  referenceTime?: Date | string,
) {
  if (referenceTime instanceof Date) return referenceTime.getTime()
  if (typeof referenceTime === 'string') return Date.parse(referenceTime)

  const latestMs = events.reduce((latest, event) => {
    const createdAtMs = event.createdAt ? Date.parse(event.createdAt) : Number.NaN
    return Number.isFinite(createdAtMs) ? Math.max(latest, createdAtMs) : latest
  }, Number.NEGATIVE_INFINITY)

  return Number.isFinite(latestMs) ? latestMs : Date.now()
}

function getLatestCreatedAt(events: readonly PreferenceProfileEvent[]) {
  const latest = events.reduce<{ value: string | null; ms: number }>(
    (current, event) => {
      const createdAtMs = event.createdAt ? Date.parse(event.createdAt) : Number.NaN
      if (!Number.isFinite(createdAtMs) || createdAtMs <= current.ms) return current
      return { value: event.createdAt ?? null, ms: createdAtMs }
    },
    { value: null, ms: Number.NEGATIVE_INFINITY },
  )

  return latest.value
}

function getFavoriteSnapshotStops(snapshot: unknown): FavoriteSnapshotStop[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.stops)) return []

  return snapshot.stops
    .filter(isRecord)
    .map((stop) => ({
      id: nullableString(stop.id),
      name: nullableString(stop.name),
      type: nullableStopType(stop.type),
      placeId: nullableString(stop.placeId),
      googleTypes: Array.isArray(stop.googleTypes) ? stop.googleTypes.map(String) : undefined,
      candidateRole: nullableCandidateRole(stop.candidateRole),
      foodSubtype: nullableFoodSubtype(stop.foodSubtype),
    }))
}

function getPreferredPlaces(placeScores: Map<string, PreferredPlace>) {
  return [...placeScores.values()]
    .map((place) => ({ ...place, score: roundScore(place.score) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.placeId.localeCompare(b.placeId))
    .slice(0, MAX_PREFERRED_PLACES)
}

function addPlaceScore(
  placeScores: Map<string, PreferredPlace>,
  placeId: string,
  placeName: string | undefined,
  weight: number,
) {
  const existing = placeScores.get(placeId)
  if (existing) {
    existing.score += weight
    existing.count += 1
    existing.placeName ||= placeName
    return
  }

  placeScores.set(placeId, {
    placeId,
    placeName,
    score: weight,
    count: 1,
  })
}

function addScore(scores: PreferenceScoreMap, key: string, value: number) {
  if (!key || !Number.isFinite(value) || value <= 0) return
  scores[key] = (scores[key] ?? 0) + value
}

function uniqueStrings(values: readonly string[] | null | undefined) {
  if (!values) return []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function roundProfileScores(profile: PreferenceProfile) {
  for (const scoreMap of [
    profile.categoryScores,
    profile.tagScores,
    profile.stopTypeScores,
    profile.googleTypeScores,
    profile.candidateRoleScores,
    profile.foodSubtypeScores,
  ]) {
    for (const key of Object.keys(scoreMap)) {
      scoreMap[key] = roundScore(scoreMap[key])
    }
  }
}

function roundScore(score: number) {
  return Number(score.toFixed(SCORE_DECIMALS))
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function nullableStopType(value: unknown): StopType | undefined {
  return value === 'main_activity' || value === 'food' || value === 'ending_or_transition'
    ? value
    : undefined
}

function nullableCandidateRole(value: unknown): CandidateRole | undefined {
  return value === 'food'
    || value === 'main_activity'
    || value === 'open_space'
    || value === 'shopping'
    || value === 'short_visit'
    ? value
    : undefined
}

function nullableFoodSubtype(value: unknown): FoodSubtype | undefined {
  return value === 'cafe' || value === 'dessert' || value === 'restaurant' || value === 'snack'
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
