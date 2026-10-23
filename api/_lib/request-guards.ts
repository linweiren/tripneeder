import { createHash } from 'node:crypto'

type HeaderBag = Record<string, string | string[] | undefined>

type RequestLike = {
  headers?: HeaderBag
}

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFiniteCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

export function isJsonWithinLimit(value: unknown, maxBytes: number) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes
  } catch {
    return false
  }
}

export function getRequestClientKey(request: RequestLike) {
  const realIp = getHeader(request.headers, 'x-real-ip')
  if (realIp) return `ip:${realIp.trim().slice(0, 100)}`

  const forwardedFor = getHeader(request.headers, 'x-forwarded-for')
  const lastForwardedIp = forwardedFor?.split(',').at(-1)?.trim()
  return `ip:${lastForwardedIp || 'unknown'}`
}

export function consumeRateLimit(key: string, maxRequests: number, windowMs: number, now = Date.now()) {
  const current = rateLimitBuckets.get(key)
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    pruneRateLimitBuckets(now)
    return true
  }
  if (current.count >= maxRequests) return false
  current.count += 1
  return true
}

export async function consumeApiRateLimit(key: string, maxRequests: number, windowMs: number) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return consumeRateLimit(key, maxRequests, windowMs)
  }

  const bucketKey = createHash('sha256').update(key).digest('hex')
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/consume_api_rate_limit`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_bucket_key: bucketKey,
        p_max_requests: maxRequests,
        p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`Rate-limit store returned ${response.status}`)
    const result: unknown = await response.json()
    return result === true || (Array.isArray(result) && result[0] === true)
  } catch (error) {
    console.error('Durable API rate limit unavailable; using per-instance fallback.', error)
    return consumeRateLimit(key, maxRequests, windowMs)
  }
}

function getHeader(headers: HeaderBag | undefined, name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function pruneRateLimitBuckets(now: number) {
  if (rateLimitBuckets.size < 5000) return
  for (const [key, value] of rateLimitBuckets) {
    if (value.resetAt <= now) rateLimitBuckets.delete(key)
  }
}
