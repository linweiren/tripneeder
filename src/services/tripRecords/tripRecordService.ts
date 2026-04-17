import { supabase } from '../auth/supabaseClient'
import { initializeUserProfile } from '../points/pointsService'
import type { TripInput, TripPlan } from '../../types/trip'
import {
  createPlanFingerprint,
  loadFavoriteTripRecords,
  loadRecentTripRecords,
  MAX_RECENT_RECORDS,
  removeFavoriteTrip,
  saveFavoriteTrip,
  saveGeneratedPlans,
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

const MIGRATION_STORAGE_KEY = 'tripneeder.tripRecordsMigrated'
const FAVORITES_CHANGED_EVENT = 'tripneeder:favoritesChanged'
const RECORD_CACHE_STORAGE_KEY = 'tripneeder.tripRecordCache'
const tripRecordCache = new Map<string, StoredTripRecord[]>()

export async function prepareTripRecordsForUser(userId: string) {
  await ensureUserProfile()
  await migrateLocalTripRecords(userId)
}

export async function loadFavoriteRecords(userId: string) {
  if (!supabase) {
    return loadFavoriteTripRecords(userId)
  }

  const records = await loadRemoteTripRecords('favorite', userId)
  setTripRecordCache('favorite', userId, records)

  return records
}

export async function loadRecentRecords(userId: string) {
  if (!supabase) {
    return loadRecentTripRecords(userId)
  }

  const records = await loadRemoteTripRecords('recent', userId)
  setTripRecordCache('recent', userId, records)

  return records
}

export function getCachedFavoriteRecords(userId: string) {
  return getTripRecordCache('favorite', userId) ?? loadFavoriteTripRecords(userId)
}

export function getCachedRecentRecords(userId: string) {
  return getTripRecordCache('recent', userId) ?? loadRecentTripRecords(userId)
}

export function hasCachedTripRecords(kind: TripRecordKind, userId: string) {
  return tripRecordCache.has(getTripRecordCacheKey(kind, userId))
}

export async function saveFavoriteRecord(
  plan: TripPlan,
  input: TripInput | null,
  userId: string,
) {
  await prepareTripRecordsForUser(userId)

  const localRecord = saveFavoriteTrip(plan, input, userId)
  setTripRecordCache('favorite', userId, loadFavoriteTripRecords(userId))
  notifyFavoritesChanged()

  if (!supabase) {
    return localRecord
  }

  const planFingerprint = createPlanFingerprint(plan)
  const remoteRecord = await saveRemoteFavoriteRecord({
    plan,
    input,
    userId,
    planFingerprint,
  })

  return remoteRecord ?? localRecord
}

export async function removeFavoriteRecord(
  recordId: string,
  userId: string,
  plan?: TripPlan,
) {
  const planFingerprint = plan ? createPlanFingerprint(plan) : ''

  if (!supabase) {
    removeLocalFavoriteRecord(recordId, userId, plan)
    notifyFavoritesChanged()
    return
  }

  const { error } = await supabase
    .from('trip_records')
    .delete()
      .eq('id', recordId)
      .eq('user_id', userId)
      .eq('kind', 'favorite')

  if (error) {
    throw new Error('移除收藏同步失敗，請稍後再試。')
  }

  if (planFingerprint) {
    const { error: fingerprintDeleteError } = await supabase
      .from('trip_records')
      .delete()
      .eq('user_id', userId)
      .eq('kind', 'favorite')
      .eq('plan_fingerprint', planFingerprint)

    if (fingerprintDeleteError) {
      throw new Error('移除收藏同步失敗，請稍後再試。')
    }
  }

  removeLocalFavoriteRecord(recordId, userId, plan)
  setTripRecordCache('favorite', userId, loadFavoriteTripRecords(userId))
  notifyFavoritesChanged()
}

export async function saveRecentGeneratedRecords(
  plans: TripPlan[],
  input: TripInput,
  userId: string,
) {
  saveGeneratedPlans(plans, input, userId)
  setTripRecordCache('recent', userId, loadRecentTripRecords(userId))

  if (!supabase) {
    return
  }

  await ensureUserProfile()

  const { error } = await supabase.from('trip_records').insert(
    plans.map((plan) => ({
      user_id: userId,
      kind: 'recent',
      plan,
      input,
      plan_fingerprint: createPlanFingerprint(plan),
    })),
  )

  if (error) {
    throw new Error('最近生成同步失敗，已先保存在本機。')
  }

  await trimRecentRecords(userId)
}

export async function isFavoriteRecord(plan: TripPlan, userId: string) {
  const planFingerprint = createPlanFingerprint(plan)

  if (supabase) {
    const { data, error } = await supabase
      .from('trip_records')
      .select('id')
      .eq('user_id', userId)
      .eq('kind', 'favorite')
      .eq('plan_fingerprint', planFingerprint)
      .maybeSingle()

    if (!error) {
      return Boolean(data)
    }
  }

  return loadFavoriteTripRecords(userId).some(
    (record) => createPlanFingerprint(record.plan) === planFingerprint,
  )
}

async function loadRemoteTripRecords(kind: TripRecordKind, userId: string) {
  const { data, error } = await supabase!
    .from('trip_records')
    .select('id,kind,plan,input,plan_fingerprint,created_at')
    .eq('user_id', userId)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
    .returns<TripRecordRow[]>()

  if (error) {
    throw new Error('同步失敗，請稍後再試。')
  }

  return data.map(mapTripRecordRow)
}

async function ensureUserProfile() {
  if (!supabase) {
    return
  }

  await initializeUserProfile()
}

async function migrateLocalTripRecords(userId: string) {
  if (!supabase || hasMigrated(userId)) {
    return
  }

  const favoriteRecords = loadFavoriteTripRecords(userId)
  const recentRecords = loadRecentTripRecords(userId)

  for (const record of favoriteRecords) {
    await saveRemoteFavoriteRecord({
      plan: record.plan,
      input: record.input,
      userId,
      planFingerprint: createPlanFingerprint(record.plan),
      createdAt: record.createdAt,
    })
  }

  if (recentRecords.length > 0) {
    const { error } = await supabase.from('trip_records').insert(
      recentRecords.map((record) => ({
        user_id: userId,
        kind: 'recent',
        plan: record.plan,
        input: record.input,
        plan_fingerprint: createPlanFingerprint(record.plan),
        created_at: record.createdAt,
      })),
    )

    if (error) {
      throw new Error('同步失敗，請稍後再試。')
    }

    await trimRecentRecords(userId)
  }

  localStorage.setItem(getMigrationStorageKey(userId), 'true')
}

async function saveRemoteFavoriteRecord({
  plan,
  input,
  userId,
  planFingerprint,
  createdAt,
}: {
  plan: TripPlan
  input: TripInput | null
  userId: string
  planFingerprint: string
  createdAt?: string
}) {
  if (!supabase) {
    return null
  }

  const { data: existing, error: existingError } = await supabase
    .from('trip_records')
    .select('id,kind,plan,input,plan_fingerprint,created_at')
    .eq('user_id', userId)
    .eq('kind', 'favorite')
    .eq('plan_fingerprint', planFingerprint)
    .maybeSingle<TripRecordRow>()

  if (existingError) {
    throw new Error('收藏同步失敗，請稍後再試。')
  }

  if (existing) {
    return mapTripRecordRow(existing)
  }

  const { data, error } = await supabase
    .from('trip_records')
    .insert({
      user_id: userId,
      kind: 'favorite',
      plan,
      input,
      plan_fingerprint: planFingerprint,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select('id,kind,plan,input,plan_fingerprint,created_at')
    .single<TripRecordRow>()

  if (error || !data) {
    throw new Error('收藏同步失敗，請稍後再試。')
  }

  return mapTripRecordRow(data)
}

async function trimRecentRecords(userId: string) {
  const { data, error } = await supabase!
    .from('trip_records')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'recent')
    .order('created_at', { ascending: false })
    .range(MAX_RECENT_RECORDS, 1000)
    .returns<Array<{ id: string }>>()

  if (error || data.length === 0) {
    return
  }

  await supabase!
    .from('trip_records')
    .delete()
    .eq('user_id', userId)
    .eq('kind', 'recent')
    .in(
      'id',
      data.map((record) => record.id),
    )
}

function mapTripRecordRow(row: TripRecordRow): StoredTripRecord {
  return {
    id: row.id,
    plan: row.plan,
    input: row.input,
    createdAt: row.created_at,
  }
}

function getTripRecordCache(kind: TripRecordKind, userId: string) {
  const cacheKey = getTripRecordCacheKey(kind, userId)
  const memoryCache = tripRecordCache.get(cacheKey)

  if (memoryCache) {
    return memoryCache
  }

  const sessionCache = loadSessionTripRecordCache(cacheKey)

  if (sessionCache) {
    tripRecordCache.set(cacheKey, sessionCache)
  }

  return sessionCache
}

function setTripRecordCache(
  kind: TripRecordKind,
  userId: string,
  records: StoredTripRecord[],
) {
  const cacheKey = getTripRecordCacheKey(kind, userId)

  tripRecordCache.set(cacheKey, records)
  saveSessionTripRecordCache(cacheKey, records)
}

function getTripRecordCacheKey(kind: TripRecordKind, userId: string) {
  return `${kind}:${userId}`
}

function loadSessionTripRecordCache(cacheKey: string) {
  const rawCache = sessionStorage.getItem(`${RECORD_CACHE_STORAGE_KEY}.${cacheKey}`)

  if (!rawCache) {
    return null
  }

  try {
    const records = JSON.parse(rawCache) as StoredTripRecord[]

    return Array.isArray(records) ? records : null
  } catch {
    return null
  }
}

function saveSessionTripRecordCache(
  cacheKey: string,
  records: StoredTripRecord[],
) {
  sessionStorage.setItem(
    `${RECORD_CACHE_STORAGE_KEY}.${cacheKey}`,
    JSON.stringify(records),
  )
}

function hasMigrated(userId: string) {
  return localStorage.getItem(getMigrationStorageKey(userId)) === 'true'
}

function getMigrationStorageKey(userId: string) {
  return `${MIGRATION_STORAGE_KEY}.${userId}`
}

function removeLocalFavoriteRecord(
  recordId: string,
  userId: string,
  plan?: TripPlan,
) {
  removeFavoriteTrip(recordId, userId)

  if (!plan) {
    return
  }

  const planFingerprint = createPlanFingerprint(plan)
  const records = loadFavoriteTripRecords(userId).filter(
    (record) => createPlanFingerprint(record.plan) !== planFingerprint,
  )

  localStorage.setItem(
    `tripneeder.favoritePlans.${userId}`,
    JSON.stringify(records),
  )
}

function notifyFavoritesChanged() {
  window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT))
}
