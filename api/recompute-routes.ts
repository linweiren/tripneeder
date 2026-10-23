import { repairTransportSegments } from './_lib/google-routes.js'
import { verifySupabaseAccessToken } from './_lib/auth.js'
import { consumeApiRateLimit, getRequestClientKey, isFiniteCoordinate, isJsonWithinLimit, isRecord } from './_lib/request-guards.js'
import type { Stop, TransportMode, TransportSegment } from '../src/types/trip.js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: {
    authorization?: string
    'x-real-ip'?: string
    'x-forwarded-for'?: string
  }
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body
  if (!isRecord(body) || !Array.isArray(body.stops) || body.stops.length < 1 || body.stops.length > 30 ||
    (body.transportSegments !== undefined && (!Array.isArray(body.transportSegments) || body.transportSegments.length > 29 || !body.transportSegments.every(isValidSegment))) ||
    !['scooter', 'car', 'public_transit'].includes(String(body.transportMode)) ||
    !isJsonWithinLimit(body, 32_000) || !body.stops.every(isValidStop)) {
    res.status(400).json({ error: '行程站點或交通方式格式不正確，或資料超過限制。' })
    return
  }

  const clientKey = getRequestClientKey(req)
  if (!await consumeApiRateLimit(`routes:${clientKey}`, 20, 60_000)) {
    res.status(429).json({ error: '路線重算請求過於頻繁，請稍後再試。' })
    return
  }
  const user = await verifySupabaseAccessToken(req.headers?.authorization)
  if (!user) {
    res.status(401).json({ error: '請登入後再重算交通路線。' })
    return
  }
  if (!await consumeApiRateLimit(`routes:user:${user.id}`, 30, 60_000)) {
    res.status(429).json({ error: '路線重算已達使用上限，請稍後再試。' })
    return
  }

  const { stops, transportMode } = body as {
    stops: Stop[]
    transportMode: TransportMode
  }
  const transportSegments = (body.transportSegments ?? []) as TransportSegment[]

  try {
    const { segments, routesFailed } = await repairTransportSegments(
      transportSegments || [],
      stops,
      transportMode,
    )

    const totalTime =
      stops.reduce((total, stop) => total + stop.duration, 0) +
      segments.reduce((total, segment) => total + segment.duration, 0)

    res.status(200).json({
      transportSegments: segments,
      totalTime,
      routesFailed,
    })
  } catch (error) {
    console.error('Failed to recompute routes:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

function isValidStop(value: unknown): value is Stop {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 100 ||
    typeof value.name !== 'string' || value.name.length > 300 ||
    typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 1440) return false
  const hasLat = value.lat !== undefined
  const hasLng = value.lng !== undefined
  if (hasLat !== hasLng) return false
  return !hasLat || (isFiniteCoordinate(value.lat, -90, 90) && isFiniteCoordinate(value.lng, -180, 180))
}

function isValidSegment(value: unknown): value is TransportSegment {
  return isRecord(value) && typeof value.fromStopId === 'string' && value.fromStopId.length <= 100 &&
    typeof value.toStopId === 'string' && value.toStopId.length <= 100 &&
    ['scooter', 'car', 'public_transit'].includes(String(value.mode)) &&
    typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0 && value.duration <= 1440 &&
    typeof value.label === 'string' && value.label.length <= 500
}
