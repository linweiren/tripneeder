import { repairTransportSegments } from './_lib/google-routes.js'
import type { Stop, TransportMode, TransportSegment } from '../src/types/trip.js'

type VercelRequest = {
  method?: string
  body?: unknown
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

  const { stops, transportSegments, transportMode } = req.body as {
    stops: Stop[]
    transportSegments: TransportSegment[]
    transportMode: TransportMode
  }

  if (!stops || !transportMode) {
    res.status(400).json({ error: 'Missing stops or transportMode' })
    return
  }

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
