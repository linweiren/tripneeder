import { supabase } from '../auth/supabaseClient'

export type UserProfile = {
  id: string
  email: string
  display_name: string | null
  points_balance: number
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

export type PointTransactionType =
  | 'initial'
  | 'consume'
  | 'admin_adjust'
  | 'refund'

export type PointsSnapshot = {
  profile: UserProfile
  transactions: PointTransaction[]
}

const MAX_POINT_TRANSACTIONS = 30

export async function initializeUserProfile(): Promise<UserProfile> {
  if (!supabase) {
    throw new Error('尚未設定 Supabase，無法讀取點數資料。')
  }

  const { data: profile, error: profileError } =
    await supabase.rpc('initialize_user_profile').single<UserProfile>()

  if (profileError || !profile) {
    throw new Error(
      profileError?.message || '無法建立或讀取使用者點數資料。',
    )
  }

  return profile
}

export async function loadPointsSnapshot(): Promise<PointsSnapshot> {
  if (!supabase) {
    throw new Error('尚未設定 Supabase，無法讀取點數資料。')
  }

  const profile = await initializeUserProfile()
  await trimMyPointTransactions()

  const { data: transactions, error: transactionsError } = await supabase
    .from('point_transactions')
    .select(
      'id,user_id,type,amount,balance_after,reason,created_by,created_at',
    )
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(MAX_POINT_TRANSACTIONS)
    .returns<PointTransaction[]>()

  if (transactionsError) {
    throw new Error(transactionsError.message)
  }

  return {
    profile,
    transactions: transactions ?? [],
  }
}

async function trimMyPointTransactions() {
  if (!supabase) {
    return
  }

  await supabase.rpc('trim_my_point_transactions')
}

export async function getMyPointsBalance(): Promise<number> {
  if (!supabase) {
    throw new Error('尚未設定 Supabase，無法讀取點數資料。')
  }

  await initializeUserProfile()

  const { data, error } = await supabase.rpc('get_my_points_balance')

  if (error || typeof data !== 'number') {
    throw new Error(error?.message || '無法讀取點數餘額。')
  }

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
