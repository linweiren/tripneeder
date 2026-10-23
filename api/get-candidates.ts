import { getNearbyPlaceCandidates } from './_lib/google-places.js'
import { verifySupabaseAccessToken } from './_lib/auth.js'
import { consumeApiRateLimit, getRequestClientKey, isFiniteCoordinate, isJsonWithinLimit, isRecord } from './_lib/request-guards.js'
import type { GenerateTripPlansRequest } from '../src/services/ai/types.js'

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

  const requestBody = req.body
  if (!isRecord(requestBody) || !isRecord(requestBody.input) || !isRecord(requestBody.input.location) ||
    !isJsonWithinLimit(requestBody, 32_000) ||
    !isFiniteCoordinate(requestBody.input.location.lat, -90, 90) ||
    !isFiniteCoordinate(requestBody.input.location.lng, -180, 180)) {
    res.status(400).json({ error: 'Invalid or oversized candidate request' })
    return
  }

  const clientKey = getRequestClientKey(req)
  if (!await consumeApiRateLimit(`candidate:${clientKey}`, 12, 60_000)) {
    res.status(429).json({ error: '請求過於頻繁，請稍後再試。' })
    return
  }

  const user = await verifySupabaseAccessToken(req.headers?.authorization)
  if (!user) {
    res.status(401).json({ error: '請登入後再取得候選地點。' })
    return
  }
  if (!await consumeApiRateLimit(`candidate:user:${user.id}`, 20, 60_000)) {
    res.status(429).json({ error: '候選地點請求已達使用上限，請稍後再試。' })
    return
  }

  try {
    const candidates = await getNearbyPlaceCandidates(requestBody as unknown as GenerateTripPlansRequest)
    res.status(200).json(candidates)
  } catch (error) {
    console.error('Failed to get candidates:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
