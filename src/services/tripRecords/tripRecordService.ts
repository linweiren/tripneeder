import { supabase } from '../auth/supabaseClient'
import type { TripInput, TripPlan } from '../../types/trip'
import { buildFavoriteDeleteFilters } from './favoriteDeleteFilters'
import {
  createPlanFingerprint,
  GENERATED_PLAN_IDS,
  loadFavoriteTripRecords,
  loadRecentTripRecords,
  MAX_RECENT_RECORDS,
  removeFavoriteTrip,
  saveFavoriteTrip,
  saveFavoriteTripRecords,
  saveGeneratedPlans,
  updateFavoriteTripRecordById,
  updateFavoriteTripRecordPlan,
  updateRecentTripRecordById,
  updateRecentTripRecordPlan,
  type StoredTripRecord,
} from '../../utils/tripPlanStorage'

type TripRecordKind = 'favorite' | 'recent'

type TripRecordRow = {
  id: string
  kind: TripRecordKind
  plan: TripPlan
  input: TripInput | null
  plan_fingerprint: string
  created_at: string
}

const FAVORITES_CHANGED_EVENT = 'tripneeder:favoritesChanged'
const RECORD_CACHE_STORAGE_KEY = 'tripneeder.tripRecordCache'

// 使用變數延遲初始化快取容器
let tripRecordCache: Map<string, StoredTripRecord[]> | null = null
const tripRecordPreparationPromises = new Map<string, Promise<void>>()

function getCacheContainer() {
  if (!tripRecordCache) tripRecordCache = new Map()
  return tripRecordCache
}

/**
 * 準備使用者的行程紀錄（登入後調用）
 */
export async function prepareTripRecordsForUser(userId: string) {
  const currentPreparation = tripRecordPreparationPromises.get(userId)
  if (currentPreparation) return currentPreparation

  const nextPreparation = (async () => {
    // 注意：這裡不再呼叫 ensureUserProfile，交給 AuthContext 呼叫 pointsService
    await Promise.all([
      loadFavoriteRecords(userId),
      loadRecentRecords(userId)
    ])
  })()

  tripRecordPreparationPromises.set(userId, nextPreparation)
  try {
    await nextPreparation
  } finally {
    tripRecordPreparationPromises.delete(userId)
  }
}

export async function loadFavoriteRecords(userId: string) {
  if (!supabase) return loadFavoriteTripRecords(userId)
  try {
    const remoteRecords = await loadRemoteTripRecords('favorite', userId)
    setTripRecordCache('favorite', userId, remoteRecords)
    saveFavoriteTripRecords(remoteRecords, userId)
    return remoteRecords
  } catch (error) {
    console.error('loadFavoriteRecords error:', error)
    return loadFavoriteTripRecords(userId)
  }
}

export async function loadRecentRecords(userId: string) {
  if (!supabase) return loadRecentTripRecords(userId)
  try {
    const remoteRecords = await loadRemoteTripRecords('recent', userId)
    setTripRecordCache('recent', userId, remoteRecords)
    return remoteRecords
  } catch (error) {
    console.error('loadRecentRecords error:', error)
    return loadRecentTripRecords(userId)
  }
}

export function getCachedFavoriteRecords(userId: string) {
  return getTripRecordCache('favorite', userId) ?? loadFavoriteTripRecords(userId)
}

export function getCachedRecentRecords(userId: string) {
  return getTripRecordCache('recent', userId) ?? loadRecentTripRecords(userId)
}

export function hasCachedTripRecords(kind: TripRecordKind, userId: string) {
  return getCacheContainer().has(getTripRecordCacheKey(kind, userId))
}

export async function saveFavoriteRecord(plan: TripPlan, input: TripInput | null, userId: string) {
  const localRecord = saveFavoriteTrip(plan, input, userId)
  updateFavoriteCacheWithRecord(userId, localRecord)
  notifyFavoritesChanged()

  if (supabase) {
    try {
      const remoteRecord = await saveRemoteFavoriteRecord({
        plan,
        input,
        userId,
        planFingerprint: createPlanFingerprint(plan),
      })
      if (remoteRecord) {
        updateFavoriteCacheWithRecord(userId, remoteRecord)
        notifyFavoritesChanged()
        return remoteRecord
      }
    } catch (error) {
      console.error('saveFavoriteRecord sync error:', error)
    }
  }
  return localRecord
}

export async function removeFavoriteRecord(recordId: string, userId: string, plan?: TripPlan) {
  const fingerprint = plan ? createPlanFingerprint(plan) : ''
  removeLocalFavoriteRecord(recordId, userId, plan)
  setTripRecordCache('favorite', userId, loadFavoriteTripRecords(userId))
  notifyFavoritesChanged()

  if (supabase) {
    const deleteFilters = buildFavoriteDeleteFilters(recordId, userId, fingerprint)

    for (const filters of deleteFilters) {
      let query = supabase.from('trip_records').delete()
      for (const [column, value] of filters) {
        query = query.eq(column, value)
      }

      const { error } = await query
      if (error) throw error
    }
  }
}

export async function saveRecentGeneratedRecords(plans: TripPlan[], input: TripInput, userId: string) {
  if (plans.length === 0) return

  saveGeneratedPlans(plans, input, userId)
  setTripRecordCache('recent', userId, loadRecentTripRecords(userId))

  if (supabase) {
    const planIds = Array.from(new Set([...GENERATED_PLAN_IDS, ...plans.map((plan) => plan.id)]))
    if (planIds.length > 0) {
      await supabase.from('trip_records').delete()
        .eq('user_id', userId)
        .eq('kind', 'recent')
        .in('plan->>id', planIds)
    }

    const { error } = await supabase.from('trip_records').insert(
      plans.map(plan => ({
        user_id: userId,
        kind: 'recent',
        plan,
        input,
        plan_fingerprint: createPlanFingerprint(plan),
      }))
    )
    if (!error) {
      await trimRecentRecords(userId)
      await loadRecentRecords(userId)
    }
  }
}

export async function upgradeRecentGeneratedRecord(plan: TripPlan, input: TripInput | null, userId: string) {
  updateRecentTripRecordPlan(plan, input, userId)
  setTripRecordCache('recent', userId, loadRecentTripRecords(userId))

  if (supabase) {
    const records = await loadRemoteTripRecords('recent', userId)
    const record = records.find(r => r.plan.id === plan.id)
    if (record) {
      await supabase.from('trip_records').update({
        plan,
        input,
        plan_fingerprint: createPlanFingerprint(plan),
      }).eq('id', record.id).eq('user_id', userId)
    }
  }
}

export async function updateStoredTripRecordById(
  kind: TripRecordKind,
  recordId: string,
  plan: TripPlan,
  input: TripInput | null,
  userId: string,
) {
  if (kind === 'recent') {
    updateRecentTripRecordById(recordId, plan, input, userId)
  } else {
    updateFavoriteTripRecordById(recordId, plan, input, userId)
    notifyFavoritesChanged()
  }

  setTripRecordCache(
    kind,
    userId,
    kind === 'recent'
      ? loadRecentTripRecords(userId)
      : loadFavoriteTripRecords(userId),
  )

  if (supabase) {
    await supabase.from('trip_records').update({
      plan,
      input,
      plan_fingerprint: createPlanFingerprint(plan),
    }).eq('id', recordId).eq('kind', kind).eq('user_id', userId)
  }
}

export async function syncUpdatedTripRecordPlan(prev: TripPlan, next: TripPlan, input: TripInput | null, userId: string) {
  updateRecentTripRecordPlan(next, input, userId)
  updateFavoriteTripRecordPlan(next, input, userId, prev)
  setTripRecordCache('recent', userId, loadRecentTripRecords(userId))
  setTripRecordCache('favorite', userId, loadFavoriteTripRecords(userId))
  notifyFavoritesChanged()

  if (supabase) {
    await Promise.all([
      updateRemoteRecentRecords(prev, next, input, userId),
      updateRemoteFavoriteRecords(prev, next, input, userId),
    ])
  }
}

export async function isFavoriteRecord(plan: TripPlan, userId: string) {
  const fingerprint = createPlanFingerprint(plan)
  const cached = getTripRecordCache('favorite', userId)
  if (cached?.some(r => createPlanFingerprint(r.plan) === fingerprint)) return true
  if (supabase) {
    const { data } = await supabase.from('trip_records').select('id')
      .eq('user_id', userId).eq('kind', 'favorite').eq('plan_fingerprint', fingerprint).maybeSingle()
    return !!data
  }
  return false
}

async function loadRemoteTripRecords(kind: TripRecordKind, userId: string) {
  const { data, error } = await supabase!.from('trip_records')
    .select('id,kind,plan,input,plan_fingerprint,created_at')
    .eq('user_id', userId).eq('kind', kind)
    .order('created_at', { ascending: false }).returns<TripRecordRow[]>()
  if (error) throw error
  return data.map(mapTripRecordRow)
}

async function updateRemoteRecentRecords(prev: TripPlan, next: TripPlan, input: TripInput | null, userId: string) {
  const records = await loadRemoteTripRecords('recent', userId)
  const matching = records.filter(r => r.plan.id === prev.id)
  for (const r of matching) {
    await supabase!.from('trip_records').update({
      plan: next, input: input ?? r.input, plan_fingerprint: createPlanFingerprint(next)
    }).eq('id', r.id)
  }
}

async function updateRemoteFavoriteRecords(prev: TripPlan, next: TripPlan, input: TripInput | null, userId: string) {
  const prevFingerprint = createPlanFingerprint(prev)
  const records = await loadRemoteTripRecords('favorite', userId)
  const matching = records.filter(r => createPlanFingerprint(r.plan) === prevFingerprint)
  for (const r of matching) {
    await supabase!.from('trip_records').update({
      plan: next, input: input ?? r.input, plan_fingerprint: createPlanFingerprint(next)
    }).eq('id', r.id)
  }
}

async function saveRemoteFavoriteRecord({
  plan,
  input,
  userId,
  planFingerprint,
}: {
  plan: TripPlan
  input: TripInput | null
  userId: string
  planFingerprint: string
}) {
  const { data: existing } = await supabase!.from('trip_records').select('id,kind,plan,input,plan_fingerprint,created_at')
    .eq('user_id', userId).eq('kind', 'favorite').eq('plan_fingerprint', planFingerprint).maybeSingle<TripRecordRow>()
  if (existing) return mapTripRecordRow(existing)
  const { data, error } = await supabase!.from('trip_records').insert({
    user_id: userId, kind: 'favorite', plan, input, plan_fingerprint: planFingerprint,
  }).select('id,kind,plan,input,plan_fingerprint,created_at').single<TripRecordRow>()
  return error ? null : mapTripRecordRow(data)
}

async function trimRecentRecords(userId: string) {
  const { data } = await supabase!.from('trip_records').select('id').eq('user_id', userId).eq('kind', 'recent')
    .order('created_at', { ascending: false }).range(MAX_RECENT_RECORDS, 1000)
  if (data && data.length > 0) {
    await supabase!.from('trip_records').delete().in('id', data.map(r => r.id))
  }
}

function mapTripRecordRow(row: TripRecordRow): StoredTripRecord {
  return { id: row.id, plan: row.plan, input: row.input, createdAt: row.created_at }
}

function getTripRecordCache(kind: TripRecordKind, userId: string): StoredTripRecord[] | null {
  const cacheKey = getTripRecordCacheKey(kind, userId)
  const memoryCache = getCacheContainer().get(cacheKey)
  if (memoryCache) return memoryCache
  const sessionCache = loadSessionTripRecordCache(cacheKey)
  if (sessionCache) getCacheContainer().set(cacheKey, sessionCache)
  return sessionCache
}

function setTripRecordCache(kind: TripRecordKind, userId: string, records: StoredTripRecord[]) {
  const cacheKey = getTripRecordCacheKey(kind, userId)
  getCacheContainer().set(cacheKey, records)
  saveSessionTripRecordCache(cacheKey, records)
}

function getTripRecordCacheKey(kind: TripRecordKind, userId: string) {
  return `${kind}:${userId}`
}

function loadSessionTripRecordCache(cacheKey: string): StoredTripRecord[] | null {
  const rawCache = sessionStorage.getItem(`${RECORD_CACHE_STORAGE_KEY}.${cacheKey}`)
  try { return rawCache ? JSON.parse(rawCache) : null } catch { return null }
}

function saveSessionTripRecordCache(cacheKey: string, records: StoredTripRecord[]) {
  sessionStorage.setItem(`${RECORD_CACHE_STORAGE_KEY}.${cacheKey}`, JSON.stringify(records))
}

function updateFavoriteCacheWithRecord(userId: string, record: StoredTripRecord) {
  const current = getTripRecordCache('favorite', userId) ?? loadFavoriteTripRecords(userId)
  const fingerprint = createPlanFingerprint(record.plan)
  const next = [record, ...current.filter(r => createPlanFingerprint(r.plan) !== fingerprint)]
  setTripRecordCache('favorite', userId, next)
}

function removeLocalFavoriteRecord(recordId: string, userId: string, plan?: TripPlan) {
  removeFavoriteTrip(recordId, userId)
  if (!plan) return
  const fingerprint = createPlanFingerprint(plan)
  const records = loadFavoriteTripRecords(userId).filter(r => createPlanFingerprint(r.plan) !== fingerprint)
  saveFavoriteTripRecords(records, userId)
}

function notifyFavoritesChanged() {
  window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT))
}
