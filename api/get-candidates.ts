import { getNearbyPlaceCandidates } from './_lib/google-places.js'
import { handleApiOptions, requireAuthenticatedUser } from './_lib/authenticated-user.js'
import type { GenerateTripPlansRequest } from '../src/services/ai/types.js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: {
    authorization?: string
  }
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  end: () => void
  setHeader: (name: string, value: string) => void
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleApiOptions(req.method, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!await requireAuthenticatedUser(req.headers?.authorization, res)) return
  const request = req.body as GenerateTripPlansRequest

  if (!request?.input?.location?.lat || !request?.input?.location?.lng) {
    res.status(400).json({ error: 'Missing location coordinates' })
    return
  }

  try {
    const candidates = await getNearbyPlaceCandidates(request)
    res.status(200).json(candidates)
  } catch (error) {
    console.error('Failed to get candidates:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
