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
  saveFavoriteTripRecords,
  saveGeneratedPlans,
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

const MIGRATION_STORAGE_KEY = 'tripneeder.tripRecordsMigrated'
const LEGACY_MIGRATION_STORAGE_KEY = 'tripneeder.legacyTripRecordsMigrated'
const FAVORITES_CHANGED_EVENT = 'tripneeder:favoritesChanged'
const RECORD_CACHE_STORAGE_KEY = 'tripneeder.tripRecordCache'
const PENDING_FAVORITES_STORAGE_KEY = 'tripneeder.pendingFavoriteFingerprints'
const tripRecordCache = new Map<string, StoredTripRecord[]>()
const tripRecordPreparationPromises = new Map<string, Promise<void>>()

export async function prepareTripRecordsForUser(userId: string) {
  const currentPreparation = tripRecordPreparationPromises.get(userId)

  if (currentPreparation) {
    return currentPreparation
  }

  const nextPreparation = (async () => {
    await ensureUserProfile()
    await migrateLocalTripRecords(userId)
    await migrateLegacyTripRecords(userId)
  })()

  tripRecordPreparationPromises.set(userId, nextPreparation)

  try {
    await nextPreparation
  } finally {
    tripRecordPreparationPromises.delete(userId)
  }
}

export async function loadFavoriteRecords(userId: string) {
  if (!supabase) {
    return loadFavoriteTripRecords(userId)
  }

  const records = mergeRemoteFavoriteRecordsWithPendingLocalRecords(
    await loadRemoteTripRecords('favorite', userId),
    userId,
  )

  saveFavoriteTripRecords(records, userId)
  setTripRecordCache('favorite', userId, records)

  return records
}

export async function loadRecentRecords(userId: string) {
  if (!supabase) {
    return loadRecentTripRecords(userId)
  }

  const records = mergeRemoteRecentRecordsWithLocalFallback(
    await loadRemoteTripRecords('recent', userId),
    userId,
  )
  setTripRecordCache('recent', userId, records)

  return records
}

export function getCachedFavoriteRecords(userId: string) {
  return mergeRemoteFavoriteRecordsWithPendingLocalRecords(
    getTripRecordCache('favorite', userId) ?? loadFavoriteTripRecords(userId),
    userId,
  )
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

  const planFingerprint = createPlanFingerprint(plan)
  const localRecord = saveFavoriteTrip(plan, input, userId)
  markPendingFavoriteFingerprint(userId, planFingerprint)
  updateFavoriteCacheWithRecord(userId, localRecord)
  notifyFavoritesChanged()

  if (!supabase) {
    return localRecord
  }

  const remoteRecord = await saveRemoteFavoriteRecord({
    plan,
    input,
    userId,
    planFingerprint,
  })

  if (remoteRecord) {
    clearPendingFavoriteFingerprint(userId, planFingerprint)
    updateFavoriteCacheWithRecord(userId, remoteRecord)
    notifyFavoritesChanged()
  }

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
  if (planFingerprint) {
    clearPendingFavoriteFingerprint(userId, planFingerprint)
  }
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

  setTripRecordCache(
    'recent',
    userId,
    mergeRemoteRecentRecordsWithLocalFallback(
      await loadRemoteTripRecords('recent', userId),
      userId,
    ),
  )
}

export async function upgradeRecentGeneratedRecord(
  plan: TripPlan,
  input: TripInput | null,
  userId: string,
) {
  updateRecentTripRecordPlan(plan, input, userId)
  setTripRecordCache('recent', userId, loadRecentTripRecords(userId))

  if (!supabase) {
    return
  }

  const records = await loadRemoteTripRecords('recent', userId)
  const record = records.find(
    (currentRecord) =>
      currentRecord.plan.id === plan.id &&
      (!input || !currentRecord.input || isSameTripInput(currentRecord.input, input)),
  )

  if (!record) {
    return
  }

  const { error } = await supabase
    .from('trip_records')
    .update({
      plan,
      input,
      plan_fingerprint: createPlanFingerprint(plan),
    })
    .eq('id', record.id)
    .eq('user_id', userId)
    .eq('kind', 'recent')

  if (error) {
    throw new Error('最近生成升級同步失敗，已先保存在本機。')
  }

  setTripRecordCache(
    'recent',
    userId,
    mergeRemoteRecentRecordsWithLocalFallback(
      await loadRemoteTripRecords('recent', userId),
      userId,
    ),
  )
}

export async function isFavoriteRecord(plan: TripPlan, userId: string) {
  const planFingerprint = createPlanFingerprint(plan)
  const cachedFavoriteRecords = getTripRecordCache('favorite', userId)

  if (hasPendingFavoriteFingerprint(userId, planFingerprint)) {
    return true
  }

  if (
    cachedFavoriteRecords?.some(
      (record) => createPlanFingerprint(record.plan) === planFingerprint,
    )
  ) {
    return true
  }

  if (supabase) {
    const { data, error } = await supabase
      .from('trip_records')
      .select('id')
      .eq('user_id', userId)
      .eq('kind', 'favorite')
      .eq('plan_fingerprint', planFingerprint)
      .maybeSingle()

    if (!error) {
      if (data) {
        return true
      }

      return (await loadFavoriteRecords(userId)).some(
        (record) => createPlanFingerprint(record.plan) === planFingerprint,
      )
    }
  }

  return !supabase && loadFavoriteTripRecords(userId).some(
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

async function migrateLegacyTripRecords(userId: string) {
  if (!supabase || hasMigratedLegacyRecords(userId)) {
    return
  }

  const legacyFavoriteRecords = loadFavoriteTripRecords()
  const legacyRecentRecords = loadRecentTripRecords()

  for (const record of legacyFavoriteRecords) {
    await saveRemoteFavoriteRecord({
      plan: record.plan,
      input: record.input,
      userId,
      planFingerprint: createPlanFingerprint(record.plan),
      createdAt: record.createdAt,
    })
  }

  await saveLegacyRecentRecords(userId, legacyRecentRecords)
  localStorage.setItem(getLegacyMigrationStorageKey(userId), 'true')
}

async function saveLegacyRecentRecords(
  userId: string,
  legacyRecentRecords: StoredTripRecord[],
) {
  if (legacyRecentRecords.length === 0) {
    return
  }

  const remoteRecentRecords = await loadRemoteTripRecords('recent', userId)
  const remoteFingerprints = new Set(
    remoteRecentRecords.map((record) => createPlanFingerprint(record.plan)),
  )
  const recordsToInsert = legacyRecentRecords.filter(
    (record) => !remoteFingerprints.has(createPlanFingerprint(record.plan)),
  )

  if (recordsToInsert.length === 0) {
    return
  }

  const { error } = await supabase!.from('trip_records').insert(
    recordsToInsert.map((record) => ({
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

  const canonicalExisting = await loadRemoteFavoriteRecordByCanonicalFingerprint(
    userId,
    planFingerprint,
  )

  if (canonicalExisting) {
    return canonicalExisting
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

  if (isDuplicateFavoriteError(error)) {
    return loadExistingRemoteFavoriteRecord(userId, planFingerprint)
  }

  if (error || !data) {
    throw new Error('收藏同步失敗，請稍後再試。')
  }

  return mapTripRecordRow(data)
}

async function loadRemoteFavoriteRecordByCanonicalFingerprint(
  userId: string,
  planFingerprint: string,
) {
  const records = await loadRemoteTripRecords('favorite', userId)

  return (
    records.find(
      (record) => createPlanFingerprint(record.plan) === planFingerprint,
    ) ?? null
  )
}

async function loadExistingRemoteFavoriteRecord(
  userId: string,
  planFingerprint: string,
) {
  const { data, error } = await supabase!
    .from('trip_records')
    .select('id,kind,plan,input,plan_fingerprint,created_at')
    .eq('user_id', userId)
    .eq('kind', 'favorite')
    .eq('plan_fingerprint', planFingerprint)
    .maybeSingle<TripRecordRow>()

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

function updateFavoriteCacheWithRecord(
  userId: string,
  record: StoredTripRecord,
) {
  const records = mergeTripRecordsByFingerprint(
    [record],
    getTripRecordCache('favorite', userId) ?? loadFavoriteTripRecords(userId),
  )

  saveFavoriteTripRecords(records, userId)
  setTripRecordCache('favorite', userId, records)
}

function mergeRemoteFavoriteRecordsWithPendingLocalRecords(
  remoteRecords: StoredTripRecord[],
  userId: string,
) {
  const pendingFingerprints = getPendingFavoriteFingerprints(userId)

  if (pendingFingerprints.size === 0) {
    return remoteRecords
  }

  const pendingRecords = loadFavoriteTripRecords(userId).filter((record) =>
    pendingFingerprints.has(createPlanFingerprint(record.plan)),
  )

  return mergeTripRecordsByFingerprint(remoteRecords, pendingRecords)
}

function mergeRemoteRecentRecordsWithLocalFallback(
  remoteRecords: StoredTripRecord[],
  userId: string,
) {
  return mergeTripRecordsByFingerprint(
    remoteRecords,
    loadRecentTripRecords(userId),
  ).slice(0, MAX_RECENT_RECORDS)
}

function mergeTripRecordsByFingerprint(
  primaryRecords: StoredTripRecord[],
  fallbackRecords: StoredTripRecord[],
) {
  const recordByFingerprint = new Map<string, StoredTripRecord>()

  for (const record of fallbackRecords) {
    recordByFingerprint.set(createPlanFingerprint(record.plan), record)
  }

  for (const record of primaryRecords) {
    recordByFingerprint.set(createPlanFingerprint(record.plan), record)
  }

  return Array.from(recordByFingerprint.values()).sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )
}

function markPendingFavoriteFingerprint(userId: string, planFingerprint: string) {
  const fingerprints = getPendingFavoriteFingerprints(userId)
  fingerprints.add(planFingerprint)
  savePendingFavoriteFingerprints(userId, fingerprints)
}

function clearPendingFavoriteFingerprint(userId: string, planFingerprint: string) {
  const fingerprints = getPendingFavoriteFingerprints(userId)
  fingerprints.delete(planFingerprint)
  savePendingFavoriteFingerprints(userId, fingerprints)
}

function hasPendingFavoriteFingerprint(userId: string, planFingerprint: string) {
  return getPendingFavoriteFingerprints(userId).has(planFingerprint)
}

function getPendingFavoriteFingerprints(userId: string) {
  const rawFingerprints = sessionStorage.getItem(
    `${PENDING_FAVORITES_STORAGE_KEY}.${userId}`,
  )

  if (!rawFingerprints) {
    return new Set<string>()
  }

  try {
    const fingerprints = JSON.parse(rawFingerprints) as string[]

    return new Set(Array.isArray(fingerprints) ? fingerprints : [])
  } catch {
    return new Set<string>()
  }
}

function savePendingFavoriteFingerprints(
  userId: string,
  fingerprints: Set<string>,
) {
  const storageKey = `${PENDING_FAVORITES_STORAGE_KEY}.${userId}`
  const nextFingerprints = Array.from(fingerprints)

  if (nextFingerprints.length === 0) {
    sessionStorage.removeItem(storageKey)
    return
  }

  sessionStorage.setItem(storageKey, JSON.stringify(nextFingerprints))
}

function isDuplicateFavoriteError(error: unknown) {
  return (
    isRecord(error) &&
    typeof error.code === 'string' &&
    error.code === '23505'
  )
}

function hasMigrated(userId: string) {
  return localStorage.getItem(getMigrationStorageKey(userId)) === 'true'
}

function getMigrationStorageKey(userId: string) {
  return `${MIGRATION_STORAGE_KEY}.${userId}`
}

function hasMigratedLegacyRecords(userId: string) {
  return localStorage.getItem(getLegacyMigrationStorageKey(userId)) === 'true'
}

function getLegacyMigrationStorageKey(userId: string) {
  return `${LEGACY_MIGRATION_STORAGE_KEY}.${userId}`
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

  saveFavoriteTripRecords(records, userId)
}

function notifyFavoritesChanged() {
  window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT))
}

function isSameTripInput(left: TripInput, right: TripInput) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
