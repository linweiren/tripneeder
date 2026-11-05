import { createClient } from '@supabase/supabase-js'

const ACTIVE_SUPABASE_URL = 'https://jaxlqqctnnbfritxkkpy.supabase.co'
const ACTIVE_SUPABASE_ANON_KEY = 'sb_publishable_4iJp5JFnksDVX7STPw05nA_aNNFVznK'

const rawUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const rawAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

const isLegacyDeadProject = rawUrl.includes('hscnfrjtjdifhnadnlye') || rawUrl.includes('your-project-ref')

const supabaseUrl = !rawUrl.trim() || isLegacyDeadProject ? ACTIVE_SUPABASE_URL : rawUrl
const supabaseAnonKey = !rawAnonKey.trim() || isLegacyDeadProject ? ACTIVE_SUPABASE_ANON_KEY : rawAnonKey

export const isSupabaseConfigured =
  Boolean(supabaseUrl.trim()) && Boolean(supabaseAnonKey.trim())

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        persistSession: true,
      },
    })
  : null
