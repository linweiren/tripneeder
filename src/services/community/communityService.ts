import { supabase } from '../auth/supabaseClient'
import type { TripInput, TripPlan } from '../../types/trip'

export const COMMUNITY_LIKE_REWARD_THRESHOLD = 10
export const COMMUNITY_LIKE_REWARD_POINTS = 20

export type SharedTrip = {
  id: string
  plan: TripPlan
  input: TripInput | null
  author_display_name: string
  created_at: string
  like_count: number
  liked_by_me: boolean
  reward_awarded: boolean
  is_owner: boolean
}

export async function loadSharedTrips(tripId?: string): Promise<SharedTrip[]> {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('shared_trip_feed', {
    p_trip_id: tripId ?? null,
  })
  if (error) throw error
  return (data ?? []) as SharedTrip[]
}

export async function shareTrip(plan: TripPlan, input: TripInput | null) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('share_trip', {
    p_plan: plan,
    p_input: input,
  })
  if (error) throw error
  return data as string
}

export async function toggleSharedTripLike(tripId: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('toggle_shared_trip_like', {
    p_trip_id: tripId,
  })
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result) throw new Error('喜歡狀態更新失敗，請稍後再試。')
  return result as {
    liked: boolean
    like_count: number
    reward_awarded: boolean
    points_awarded: number
  }
}
