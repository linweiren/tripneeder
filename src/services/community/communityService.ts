import { supabase } from '../auth/supabaseClient'
import type { TripInput, TripPlan } from '../../types/trip'
import { deduplicateAndValidateSharedTrips, getSharedPlanSignature, sanitizeSharedPlan } from './communityData'
export { deduplicateAndValidateSharedTrips, getSharedPlanSignature, sanitizeSharedPlan } from './communityData'

export const COMMUNITY_TAG_LIMIT = 2
export const COMMUNITY_COMMENT_LIMIT = 500
export const COMMUNITY_PAGE_SIZE = 30
export const COMMUNITY_COMMENT_PAGE_SIZE = 50

let ownSharedPlanSignaturesRequest: Promise<Set<string>> | null = null

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

export async function loadSharedTrips(
  tripId?: string,
  ownerOnly = false,
  page: { limit?: number; offset?: number; sort?: 'newest' | 'likes' | 'discussion' } = {},
): Promise<SharedTrip[]> {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('shared_trip_feed', {
    p_trip_id: tripId ?? null,
    p_owner_only: ownerOnly,
    p_limit: Math.min(100, Math.max(1, page.limit ?? COMMUNITY_PAGE_SIZE)),
    p_offset: Math.max(0, page.offset ?? 0),
    p_sort: page.sort ?? 'newest',
  })
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('分享平台回傳格式不正確。')
  return deduplicateAndValidateSharedTrips(data)
}

export async function hasSharedPlan(planSignature: string): Promise<boolean> {
  if (!ownSharedPlanSignaturesRequest) {
    ownSharedPlanSignaturesRequest = (async () => {
      const signatures = new Set<string>()
      for (let offset = 0; ; offset += COMMUNITY_PAGE_SIZE) {
        const trips = await loadSharedTrips(undefined, true, { offset })
        for (const trip of trips) signatures.add(getSharedPlanSignature(trip.plan))
        if (trips.length < COMMUNITY_PAGE_SIZE) break
      }
      return signatures
    })()
      .catch((error: unknown) => {
        ownSharedPlanSignaturesRequest = null
        throw error
      })
  }
  const planSignatures = await ownSharedPlanSignaturesRequest
  return planSignatures.has(planSignature)
}

export async function shareTrip(plan: TripPlan, tags: string[] = []) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const publicPlan = sanitizeSharedPlan(plan)
  const serialized = JSON.stringify(publicPlan)
  if (serialized.length > 200_000) throw new Error('行程資料過大，請精簡行程後再分享。')
  const { data, error } = await supabase.rpc('share_trip', {
    p_plan: publicPlan,
    p_input: null,
    p_tags: tags.slice(0, COMMUNITY_TAG_LIMIT),
  })
  if (error) throw error
  ownSharedPlanSignaturesRequest = null
  return data as string
}

export async function unshareTrip(tripId: string) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { error } = await supabase.rpc('unshare_trip', { p_trip_id: tripId })
  if (error) throw error
  ownSharedPlanSignaturesRequest = null
}

export type SharedTripComment = {
  id: string
  author_display_name: string
  body: string
  created_at: string
  is_mine: boolean
}

export async function loadSharedTripComments(tripId: string, offset = 0) {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { data, error } = await supabase.rpc('shared_trip_comments_feed', {
    p_trip_id: tripId,
    p_limit: COMMUNITY_COMMENT_PAGE_SIZE + 1,
    p_offset: Math.max(0, offset),
  })
  if (error) throw error
  const rows = Array.isArray(data) ? data as SharedTripComment[] : []
  return { comments: rows.slice(0, COMMUNITY_COMMENT_PAGE_SIZE), hasMore: rows.length > COMMUNITY_COMMENT_PAGE_SIZE }
}

export async function reportSharedTripComment(commentId: string, reason: 'spam' | 'harassment' | 'private_info' | 'other') {
  if (!supabase) throw new Error('分享平台尚未連接 Supabase。')
  const { error } = await supabase.rpc('report_shared_trip_comment', { p_comment_id: commentId, p_reason: reason })
  if (error) throw error
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
