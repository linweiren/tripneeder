import { supabase } from '../auth/supabaseClient'

export type UserProfile = {
  id: string
  email: string
  display_name: string | null
  points_balance: number
  has_received_initial_points: boolean
  persona_companion: string | null
  persona_budget: string | null
  persona_stamina: string | null
  persona_diet: string | null
  persona_transport_mode: 'scooter' | 'car' | 'public_transit' | null
  persona_people: number
  created_at: string
  updated_at: string
}

export type PointTransaction = {
  id: string
  user_id: string
  type: PointTransactionType
  amount: number
  balance_after: number
  reason: string | null
  created_by: string | null
  created_at: string
}

export type PointTransactionType = 'initial' | 'consume' | 'admin_adjust' | 'refund'

export type PointsSnapshot = {
  profile: UserProfile
  transactions: PointTransaction[]
}

const MAX_POINT_TRANSACTIONS = 30
const PROFILE_CACHE_KEY = 'tripneeder.profileCache'
const TRANSACTIONS_CACHE_KEY = 'tripneeder.transactionsCache'

// 記憶體快取
let profileCache: UserProfile | null = null
let transactionsCache: PointTransaction[] | null = null

/**
 * 獲取本地快取的使用者資料（用於極速顯示）
 */
export function getCachedUserProfile(): UserProfile | null {
  if (profileCache) return profileCache
  const saved = sessionStorage.getItem(PROFILE_CACHE_KEY)
  if (saved) {
    try {
      profileCache = JSON.parse(saved)
      return profileCache
    } catch { return null }
  }
  return null
}

/**
 * 獲取點數與紀錄的快取快照
 */
export function getCachedPointsSnapshot(): PointsSnapshot | null {
  const profile = getCachedUserProfile()
  if (!profile) return null

  if (!transactionsCache) {
    const saved = sessionStorage.getItem(TRANSACTIONS_CACHE_KEY)
    if (saved) {
      try { transactionsCache = JSON.parse(saved) } catch { return null }
    }
  }

  return {
    profile,
    transactions: transactionsCache ?? []
  }
}

/**
 * 初始化或獲取使用者資料（會更新快取）
 */
export async function initializeUserProfile(): Promise<UserProfile> {
  if (!supabase) throw new Error('尚未設定 Supabase')

  const { data: profile, error } = await supabase.rpc('initialize_user_profile').single<UserProfile>()
  if (error || !profile) throw new Error(error?.message || '無法讀取使用者資料')

  profileCache = profile
  sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile))
  
  return profile
}

export async function loadPointsSnapshot(): Promise<PointsSnapshot> {
  if (!supabase) throw new Error('尚未設定 Supabase')

  const profile = await initializeUserProfile()
  await supabase.rpc('trim_my_point_transactions')

  const { data: transactions, error } = await supabase
    .from('point_transactions')
    .select('id,user_id,type,amount,balance_after,reason,created_by,created_at')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(MAX_POINT_TRANSACTIONS)
    .returns<PointTransaction[]>()

  if (error) throw new Error(error.message)

  // 更新交易紀錄快取
  const finalTransactions = transactions ?? []
  transactionsCache = finalTransactions
  sessionStorage.setItem(TRANSACTIONS_CACHE_KEY, JSON.stringify(finalTransactions))

  return { profile, transactions: finalTransactions }
}

export async function getMyPointsBalance(): Promise<number> {
  const profile = await initializeUserProfile()
  return profile.points_balance
}

export async function consumePoints(amount: number, reason: string): Promise<UserProfile> {
  if (!supabase) throw new Error('尚未設定 Supabase')

  const { data, error } = await supabase.rpc('consume_points_for_analysis', {
    cost: amount,
    reason,
  }).single<UserProfile>()

  if (error) {
    throw new Error(error.message.includes('不足') ? '您的點數不足' : error.message)
  }

  profileCache = data
  sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(data))
  return data
}

export function getTransactionTypeLabel(type: PointTransactionType) {
  const labels: Record<PointTransactionType, string> = {
    initial: '初始點數',
    consume: '分析扣點',
    admin_adjust: '管理調整',
    refund: '退回點數',
  }
  return labels[type]
}
