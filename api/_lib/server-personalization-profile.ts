import {
  buildPreferenceProfile,
  type PreferenceProfile,
} from '../../src/services/personalization/preferenceProfile.js'
import { mapPersonalizationEventRowToProfileEvent } from '../../src/services/personalization/personalizationEventRows.js'

type SupabaseQueryResult = Promise<{
  data: Record<string, unknown>[] | null
  error: { message: string } | null
}>

type PersonalizationSupabaseClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        order: (column: string, options: { ascending: boolean }) => {
          limit: (count: number) => SupabaseQueryResult
        }
      }
    }
  }
}

const RECENT_PERSONALIZATION_EVENT_LIMIT = 30

export async function loadServerPreferenceProfile(
  supabase: PersonalizationSupabaseClient,
  userId?: string,
): Promise<PreferenceProfile> {
  if (!userId) return buildPreferenceProfile([])

  try {
    const { data, error } = await supabase
      .from('personalization_events')
      .select(
        'event_type,place_id,place_name,stop_type,google_types,candidate_role,food_subtype,plan_type,input_category,input_tags,event_snapshot,created_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(RECENT_PERSONALIZATION_EVENT_LIMIT)

    if (error || !data) {
      if (error) console.error('loadServerPreferenceProfile error:', error)
      return buildPreferenceProfile([])
    }

    return buildPreferenceProfile(data.map(mapPersonalizationEventRowToProfileEvent))
  } catch (error) {
    console.error('loadServerPreferenceProfile error:', error)
    return buildPreferenceProfile([])
  }
}
