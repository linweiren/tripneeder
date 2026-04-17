import type { Stop, TransportSegment, TripInput, TripPlan } from '../types/trip'

const TRIP_PLANS_STORAGE_KEY = 'tripneeder.generatedPlans'
const TRIP_INPUT_STORAGE_KEY = 'tripneeder.lastInput'
const DETAIL_PLAN_STORAGE_KEY = 'tripneeder.detailPlan'
const DETAIL_INPUT_STORAGE_KEY = 'tripneeder.detailInput'
const RECENT_PLANS_STORAGE_KEY = 'tripneeder.recentPlans'
const FAVORITE_PLANS_STORAGE_KEY = 'tripneeder.favoritePlans'
export const MAX_RECENT_RECORDS = 12

export type StoredTripRecord = {
  id: string
  plan: TripPlan
  input: TripInput | null
  createdAt: string
}

export function saveGeneratedPlans(
  plans: TripPlan[],
  input?: TripInput,
  ownerId?: string,
) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(plans))

  if (input) {
    sessionStorage.setItem(TRIP_INPUT_STORAGE_KEY, JSON.stringify(input))
  }

  if (input) {
    saveRecentGeneratedPlans(plans, input, ownerId)
  }
}

export function loadGeneratedPlans() {
  const rawPlans = sessionStorage.getItem(TRIP_PLANS_STORAGE_KEY)

  if (!rawPlans) {
    return []
  }

  try {
    return JSON.parse(rawPlans) as TripPlan[]
  } catch {
    return []
  }
}

export function loadLastTripInput() {
  const rawInput = sessionStorage.getItem(TRIP_INPUT_STORAGE_KEY)

  if (!rawInput) {
    return null
  }

  try {
    return JSON.parse(rawInput) as TripInput
  } catch {
    return null
  }
}

export function clearGeneratedTripFlow() {
  sessionStorage.removeItem(TRIP_PLANS_STORAGE_KEY)
  sessionStorage.removeItem(TRIP_INPUT_STORAGE_KEY)
  sessionStorage.removeItem(DETAIL_PLAN_STORAGE_KEY)
  sessionStorage.removeItem(DETAIL_INPUT_STORAGE_KEY)
}

export function savePlanForDetail(plan: TripPlan, input: TripInput | null) {
  sessionStorage.setItem(DETAIL_PLAN_STORAGE_KEY, JSON.stringify(plan))

  if (input) {
    sessionStorage.setItem(DETAIL_INPUT_STORAGE_KEY, JSON.stringify(input))
  } else {
    sessionStorage.removeItem(DETAIL_INPUT_STORAGE_KEY)
  }
}

export function loadPlanForDetail(planId?: string) {
  const rawPlan = sessionStorage.getItem(DETAIL_PLAN_STORAGE_KEY)

  if (!rawPlan) {
    return null
  }

  try {
    const plan = JSON.parse(rawPlan) as TripPlan

    return !planId || plan.id === planId ? plan : null
  } catch {
    return null
  }
}

export function loadInputForDetail() {
  const rawInput = sessionStorage.getItem(DETAIL_INPUT_STORAGE_KEY)

  if (!rawInput) {
    return null
  }

  try {
    return JSON.parse(rawInput) as TripInput
  } catch {
    return null
  }
}

export function loadRecentTripRecords(ownerId?: string) {
  return loadStoredTripRecords(getOwnerStorageKey(RECENT_PLANS_STORAGE_KEY, ownerId))
}

export function loadFavoriteTripRecords(ownerId?: string) {
  return loadStoredTripRecords(
    getOwnerStorageKey(FAVORITE_PLANS_STORAGE_KEY, ownerId),
  )
}

export function saveFavoriteTripRecords(
  records: StoredTripRecord[],
  ownerId?: string,
) {
  localStorage.setItem(
    getOwnerStorageKey(FAVORITE_PLANS_STORAGE_KEY, ownerId),
    JSON.stringify(records),
  )
}

export function saveFavoriteTrip(
  plan: TripPlan,
  input: TripInput | null,
  ownerId?: string,
) {
  const storageKey = getOwnerStorageKey(FAVORITE_PLANS_STORAGE_KEY, ownerId)
  const records = loadFavoriteTripRecords(ownerId)
  const planFingerprint = createPlanFingerprint(plan)
  const existingRecord = records.find(
    (record) => createPlanFingerprint(record.plan) === planFingerprint,
  )

  if (existingRecord) {
    return existingRecord
  }

  const nextRecord = createStoredTripRecord(plan, input)

  localStorage.setItem(storageKey, JSON.stringify([nextRecord, ...records]))

  return nextRecord
}

export function isFavoriteTripPlan(plan: TripPlan, ownerId?: string) {
  const planFingerprint = createPlanFingerprint(plan)

  return loadFavoriteTripRecords(ownerId).some(
    (record) => createPlanFingerprint(record.plan) === planFingerprint,
  )
}

export function removeFavoriteTrip(recordId: string, ownerId?: string) {
  const records = loadFavoriteTripRecords(ownerId).filter(
    (record) => record.id !== recordId,
  )

  saveFavoriteTripRecords(records, ownerId)
}

export function createPlanFingerprint(plan: TripPlan) {
  return JSON.stringify({
    title: plan.title,
    subtitle: plan.subtitle,
    summary: plan.summary,
    budget: plan.budget,
    transportMode: plan.transportMode,
    stops: plan.stops.map(normalizeStopForFingerprint),
    transportSegments: plan.transportSegments.map(normalizeSegmentForFingerprint),
    rainBackup: plan.rainBackup.map(normalizeStopForFingerprint),
    rainTransportSegments: plan.rainTransportSegments.map(
      normalizeSegmentForFingerprint,
    ),
  })
}

function normalizeStopForFingerprint(stop: Stop) {
  return {
    id: stop.id,
    name: stop.name,
    type: stop.type,
    description: stop.description,
    address: stop.address,
    duration: stop.duration,
    googleMapsUrl: stop.googleMapsUrl,
  }
}

function normalizeSegmentForFingerprint(segment: TransportSegment) {
  return {
    fromStopId: segment.fromStopId,
    toStopId: segment.toStopId,
    mode: segment.mode,
    publicTransitType: segment.publicTransitType,
    duration: segment.duration,
  }
}

function saveRecentGeneratedPlans(
  plans: TripPlan[],
  input: TripInput,
  ownerId?: string,
) {
  const storageKey = getOwnerStorageKey(RECENT_PLANS_STORAGE_KEY, ownerId)
  const records = loadRecentTripRecords(ownerId)
  const nextRecords = plans.map((plan) => createStoredTripRecord(plan, input))

  localStorage.setItem(
    storageKey,
    JSON.stringify([...nextRecords, ...records].slice(0, MAX_RECENT_RECORDS)),
  )
}

function getOwnerStorageKey(storageKey: string, ownerId?: string) {
  return ownerId ? `${storageKey}.${ownerId}` : storageKey
}

function loadStoredTripRecords(storageKey: string) {
  const rawRecords = localStorage.getItem(storageKey)

  if (!rawRecords) {
    return []
  }

  try {
    const records = JSON.parse(rawRecords) as StoredTripRecord[]

    return Array.isArray(records)
      ? records
          .filter(isStoredTripRecord)
          .sort(
            (left, right) =>
              new Date(right.createdAt).getTime() -
              new Date(left.createdAt).getTime(),
          )
      : []
  } catch {
    return []
  }
}

function createStoredTripRecord(
  plan: TripPlan,
  input: TripInput | null,
): StoredTripRecord {
  const createdAt = new Date().toISOString()
  const randomId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return {
    id: `${createdAt}-${plan.id}-${randomId}`,
    plan,
    input,
    createdAt,
  }
}

function isStoredTripRecord(value: unknown): value is StoredTripRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    isRecord(value.plan) &&
    (value.input === null || isRecord(value.input)) &&
    typeof value.createdAt === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
