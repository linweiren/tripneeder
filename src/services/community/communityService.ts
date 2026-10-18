import { supabase } from '../auth/supabaseClient'
import type { TripInput, TripPlan } from '../../types/trip'

export const COMMUNITY_LIKE_REWARD_THRESHOLD = 10
export const COMMUNITY_LIKE_REWARD_POINTS = 20
export const COMMUNITY_TAG_LIMIT = 2
export const COMMUNITY_COMMENT_LIMIT = 500

let ownSharedPlanIdsRequest: Promise<Set<string>> | null = null

export type SharedTrip = {
  id: string
  plan: TripPlan
  input: TripInput | null
  tags: string[]
  author_display_name: string
  created_at: string
  like_count: number
  comment_count: number
  view_count: number
  liked_by_me: boolean
  reward_awarded: boolean
  is_owner: boolean
}

export async function loadSharedTrips(tripId?: string, ownerOnly = false): Promise<SharedTrip[]> {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('shared_trip_feed', {
    p_trip_id: tripId ?? null,
    p_owner_only: ownerOnly,
  })
  if (error) throw error
  return (data ?? []) as SharedTrip[]
}

export async function hasSharedPlan(planId: string): Promise<boolean> {
  if (!ownSharedPlanIdsRequest) {
    ownSharedPlanIdsRequest = loadSharedTrips(undefined, true)
      .then((trips) => {
        return new Set(trips.map((trip) => trip.plan.id))
      })
      .catch((error: unknown) => {
        ownSharedPlanIdsRequest = null
        throw error
      })
  }
  const planIds = await ownSharedPlanIdsRequest
  return planIds.has(planId)
}

export async function shareTrip(plan: TripPlan, input: TripInput | null, tags: string[] = []) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('share_trip', {
    p_plan: plan,
    p_input: input,
    p_tags: tags.slice(0, COMMUNITY_TAG_LIMIT),
  })
  if (error) throw error
  ownSharedPlanIdsRequest = null
  return data as string
}

export type SharedTripComment = {
  id: string
  author_display_name: string
  body: string
  created_at: string
  is_mine: boolean
}

export async function loadSharedTripComments(tripId: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('shared_trip_comments_feed', {
    p_trip_id: tripId,
  })
  if (error) throw error
  return (data ?? []) as SharedTripComment[]
}

export async function addSharedTripComment(tripId: string, body: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { error } = await supabase.rpc('add_shared_trip_comment', {
    p_trip_id: tripId,
    p_body: body,
  })
  if (error) throw error
}

export async function deleteSharedTripComment(commentId: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { error } = await supabase.rpc('delete_shared_trip_comment', {
    p_comment_id: commentId,
  })
  if (error) throw error
}

export async function recordSharedTripView(tripId: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('record_shared_trip_view', {
    p_trip_id: tripId,
  })
  if (error) throw error
  return data as number
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
