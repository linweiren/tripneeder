export type AuthenticatedUser = { id: string }

export async function verifySupabaseAccessToken(authorization?: string): Promise<AuthenticatedUser | null> {
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const accessToken = match?.[1]?.trim()
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!accessToken || !supabaseUrl || !anonKey) return null

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const user = await response.json() as { id?: unknown }
    return typeof user.id === 'string' && user.id ? { id: user.id } : null
  } catch {
    return null
  }
}
