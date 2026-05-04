import type { Stop, TransportSegment, TripInput, TripPlan } from '../types/trip'

// Session Storage Keys (當前分析流程)
const TRIP_PLANS_STORAGE_KEY = 'tripneeder.generatedPlans'
const TRIP_INPUT_STORAGE_KEY = 'tripneeder.lastInput'
const DETAIL_PLAN_STORAGE_KEY = 'tripneeder.detailPlan'
const DETAIL_INPUT_STORAGE_KEY = 'tripneeder.detailInput'

// Local Storage Keys (持久化快取，需帶 userId)
const RECENT_PLANS_STORAGE_KEY = 'tripneeder.recentPlans'
const FAVORITE_PLANS_STORAGE_KEY = 'tripneeder.favoritePlans'

export const MAX_RECENT_RECORDS = 12

export type StoredTripRecord = {
  id: string
  plan: TripPlan
  input: TripInput | null
  createdAt: string
}

// --- 當前生成流程管理 ---

export function saveGeneratedPlans(plans: TripPlan[], input?: TripInput, ownerId?: string) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(plans))
  if (input) sessionStorage.setItem(TRIP_INPUT_STORAGE_KEY, JSON.stringify(input))
  if (input) saveRecentGeneratedPlans(plans, input, ownerId!)
}

export function updateGeneratedPlan(nextPlan: TripPlan) {
  const plans = loadGeneratedPlans()
  const nextPlans = plans.map(p => p.id === nextPlan.id ? nextPlan : p)
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(nextPlans))
}

export function loadGeneratedPlans(): TripPlan[] {
  const raw = sessionStorage.getItem(TRIP_PLANS_STORAGE_KEY)
  try { return raw ? JSON.parse(raw) : [] } catch { return [] }
}

export function loadLastTripInput(): TripInput | null {
  const raw = sessionStorage.getItem(TRIP_INPUT_STORAGE_KEY)
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

export function clearGeneratedTripFlow() {
  [TRIP_PLANS_STORAGE_KEY, TRIP_INPUT_STORAGE_KEY, DETAIL_PLAN_STORAGE_KEY, DETAIL_INPUT_STORAGE_KEY]
    .forEach(key => sessionStorage.removeItem(key))
}

export function savePlanForDetail(plan: TripPlan, input: TripInput | null) {
  sessionStorage.setItem(DETAIL_PLAN_STORAGE_KEY, JSON.stringify(plan))
  if (input) sessionStorage.setItem(DETAIL_INPUT_STORAGE_KEY, JSON.stringify(input))
}

export function updateDetailPlan(nextPlan: TripPlan) {
  sessionStorage.setItem(DETAIL_PLAN_STORAGE_KEY, JSON.stringify(nextPlan))
}

export function loadPlanForDetail(planId?: string): TripPlan | null {
  const raw = sessionStorage.getItem(DETAIL_PLAN_STORAGE_KEY)
  try {
    const plan = raw ? JSON.parse(raw) as TripPlan : null
    return !planId || plan?.id === planId ? plan : null
  } catch { return null }
}

export function loadInputForDetail(): TripInput | null {
  const raw = sessionStorage.getItem(DETAIL_INPUT_STORAGE_KEY)
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

// --- 持久化紀錄管理 (本地快取) ---

export function loadRecentTripRecords(userId: string) {
  return loadStoredTripRecords(`${RECENT_PLANS_STORAGE_KEY}.${userId}`)
}

export function loadFavoriteTripRecords(userId: string) {
  return loadStoredTripRecords(`${FAVORITE_PLANS_STORAGE_KEY}.${userId}`)
}

export function saveFavoriteTripRecords(records: StoredTripRecord[], userId: string) {
  localStorage.setItem(`${FAVORITE_PLANS_STORAGE_KEY}.${userId}`, JSON.stringify(records))
}

export function saveFavoriteTrip(plan: TripPlan, input: TripInput | null, userId: string) {
  const key = `${FAVORITE_PLANS_STORAGE_KEY}.${userId}`
  const records = loadFavoriteTripRecords(userId)
  const fingerprint = createPlanFingerprint(plan)
  
  const existing = records.find(r => createPlanFingerprint(r.plan) === fingerprint)
  if (existing) return existing

  const next = createStoredTripRecord(plan, input)
  localStorage.setItem(key, JSON.stringify([next, ...records]))
  return next
}

export function removeFavoriteTrip(recordId: string, userId: string) {
  const key = `${FAVORITE_PLANS_STORAGE_KEY}.${userId}`
  const next = loadFavoriteTripRecords(userId).filter(r => r.id !== recordId)
  localStorage.setItem(key, JSON.stringify(next))
}

export function updateRecentTripRecordPlan(nextPlan: TripPlan, input: TripInput | null, userId: string) {
  const key = `${RECENT_PLANS_STORAGE_KEY}.${userId}`
  const next = loadRecentTripRecords(userId).map(r => 
    r.plan.id === nextPlan.id ? { ...r, plan: nextPlan, input: input ?? r.input } : r
  )
  localStorage.setItem(key, JSON.stringify(next))
}

export function updateFavoriteTripRecordPlan(nextPlan: TripPlan, input: TripInput | null, userId: string, previousPlan?: TripPlan) {
  const key = `${FAVORITE_PLANS_STORAGE_KEY}.${userId}`
  const prevFingerprint = previousPlan ? createPlanFingerprint(previousPlan) : null
  const nextFingerprint = createPlanFingerprint(nextPlan)

  const next = loadFavoriteTripRecords(userId).map(r => {
    const rFingerprint = createPlanFingerprint(r.plan)
    if (r.plan.id === previousPlan?.id || rFingerprint === prevFingerprint || rFingerprint === nextFingerprint) {
      return { ...r, plan: nextPlan, input: input ?? r.input }
    }
    return r
  })
  localStorage.setItem(key, JSON.stringify(next))
}

// --- 工具函數 ---

export function createPlanFingerprint(plan: TripPlan) {
  return JSON.stringify({
    title: plan.title,
    subtitle: plan.subtitle,
    summary: plan.summary,
    budget: plan.budget,
    transportMode: plan.transportMode,
    stops: (plan.stops || []).map(s => ({ name: s.name, type: s.type, address: s.address })),
    transportSegments: (plan.transportSegments || []).map(ts => ({ mode: ts.mode, duration: ts.duration })),
  })
}

function saveRecentGeneratedPlans(plans: TripPlan[], input: TripInput, userId: string) {
  const key = `${RECENT_PLANS_STORAGE_KEY}.${userId}`
  const prev = loadRecentTripRecords(userId)
  const next = plans.map(p => createStoredTripRecord(p, input))
  localStorage.setItem(key, JSON.stringify([...next, ...prev].slice(0, MAX_RECENT_RECORDS)))
}

function loadStoredTripRecords(key: string): StoredTripRecord[] {
  const raw = localStorage.getItem(key)
  try {
    const records = raw ? JSON.parse(raw) as StoredTripRecord[] : []
    return Array.isArray(records) ? records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : []
  } catch { return [] }
}

function createStoredTripRecord(plan: TripPlan, input: TripInput | null): StoredTripRecord {
  const createdAt = new Date().toISOString()
  return {
    id: `${createdAt}-${plan.id}-${Math.random().toString(16).slice(2)}`,
    plan,
    input,
    createdAt,
  }
}
