import { createClient } from '@supabase/supabase-js'

type AuthResponse = {
  status: (code: number) => AuthResponse
  json: (body: unknown) => void
  end: () => void
  setHeader: (name: string, value: string) => void
}

export function handleApiOptions(method: string | undefined, res: AuthResponse): boolean {
  if (method !== 'OPTIONS') return false
  res.setHeader('Allow', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.status(204).end()
  return true
}

// Supabase Auth validates the supplied JWT; decoding its payload is not authentication.
// This performs no profile initialization, balance lookup, or points consumption.
export async function requireAuthenticatedUser(authorization: string | undefined, res: AuthResponse) {
  res.setHeader('Cache-Control', 'no-store')
  const accessToken = authorization?.match(/^Bearer[ \t]+(\S+)[ \t]*$/i)?.[1]
  const unauthorized = () => {
    res.status(401).json({ error: '請重新登入以繼續使用本服務。' })
    return null
  }
  if (!accessToken) return unauthorized()

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    res.status(500).json({ error: '伺服器登入驗證設定不完整，請聯絡管理員。' })
    return null
  }

  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
    })
    const { data, error } = await client.auth.getUser(accessToken)
    if (error) {
      if ([400, 401, 403].includes(error.status ?? 0)) return unauthorized()
      throw error
    }
    if (!data.user || typeof data.user.id !== 'string' || !data.user.id.trim()) return unauthorized()
    return { userId: data.user.id, accessToken }
  } catch {
    // A verification outage must never fall through to a paid provider.
    res.status(503).json({ error: '登入驗證服務暫時無法使用，請稍後再試。' })
    return null
  }
}
