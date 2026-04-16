import type { TripInput, TripPlan } from '../types/trip'

const TRIP_PLANS_STORAGE_KEY = 'tripneeder.generatedPlans'
const TRIP_INPUT_STORAGE_KEY = 'tripneeder.lastInput'
const RECENT_PLANS_STORAGE_KEY = 'tripneeder.recentPlans'
const FAVORITE_PLANS_STORAGE_KEY = 'tripneeder.favoritePlans'
const MAX_RECENT_RECORDS = 12

export type StoredTripRecord = {
  id: string
  plan: TripPlan
  input: TripInput | null
  createdAt: string
}

export function saveGeneratedPlans(plans: TripPlan[], input?: TripInput) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(plans))

  if (input) {
    sessionStorage.setItem(TRIP_INPUT_STORAGE_KEY, JSON.stringify(input))
  }

  if (input) {
    saveRecentGeneratedPlans(plans, input)
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

export function savePlanForDetail(plan: TripPlan, input: TripInput | null) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify([plan]))

  if (input) {
    sessionStorage.setItem(TRIP_INPUT_STORAGE_KEY, JSON.stringify(input))
  }
}

export function loadRecentTripRecords() {
  return loadStoredTripRecords(RECENT_PLANS_STORAGE_KEY)
}

export function loadFavoriteTripRecords() {
  return loadStoredTripRecords(FAVORITE_PLANS_STORAGE_KEY)
}

export function saveFavoriteTrip(plan: TripPlan, input: TripInput | null) {
  const records = loadFavoriteTripRecords()
  const planFingerprint = createPlanFingerprint(plan)

  if (
    records.some((record) => createPlanFingerprint(record.plan) === planFingerprint)
  ) {
    return records.find(
      (record) => createPlanFingerprint(record.plan) === planFingerprint,
    )
  }

  const nextRecord = createStoredTripRecord(plan, input)

  localStorage.setItem(
    FAVORITE_PLANS_STORAGE_KEY,
    JSON.stringify([nextRecord, ...records]),
  )

  return nextRecord
}

export function isFavoriteTripPlan(plan: TripPlan) {
  const planFingerprint = createPlanFingerprint(plan)

  return loadFavoriteTripRecords().some(
    (record) => createPlanFingerprint(record.plan) === planFingerprint,
  )
}

export function removeFavoriteTrip(recordId: string) {
  const records = loadFavoriteTripRecords().filter(
    (record) => record.id !== recordId,
  )

  localStorage.setItem(FAVORITE_PLANS_STORAGE_KEY, JSON.stringify(records))
}

function createPlanFingerprint(plan: TripPlan) {
  return JSON.stringify({
    title: plan.title,
    subtitle: plan.subtitle,
    summary: plan.summary,
    budget: plan.budget,
    transportMode: plan.transportMode,
    stops: plan.stops,
    transportSegments: plan.transportSegments,
    rainBackup: plan.rainBackup,
    rainTransportSegments: plan.rainTransportSegments,
  })
}

function saveRecentGeneratedPlans(plans: TripPlan[], input: TripInput) {
  const records = loadRecentTripRecords()
  const nextRecords = plans.map((plan) => createStoredTripRecord(plan, input))

  localStorage.setItem(
    RECENT_PLANS_STORAGE_KEY,
    JSON.stringify([...nextRecords, ...records].slice(0, MAX_RECENT_RECORDS)),
  )
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
