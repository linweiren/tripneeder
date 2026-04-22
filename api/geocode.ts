/// <reference types="node" />

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
  setHeader: (name: string, value: string) => void
  end: () => void
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { lat, lng } = (req.body as { lat?: number; lng?: number }) || {}

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    res.status(400).json({ error: 'Missing coordinates' })
    return
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY

  if (!apiKey) {
    res.status(500).json({ error: 'Google API key not configured' })
    return
  }

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&language=zh-TW`
    )
    const data = (await response.json()) as {
      status: string
      results: Array<{
        formatted_address: string
        address_components: Array<{
          long_name: string
          types: string[]
        }>
      }>
    }

    if (data.status !== 'OK') {
      res.status(502).json({ error: 'Geocoding failed', status: data.status })
      return
    }

    const result = data.results[0]
    const components = result.address_components

    // 台灣地名邏輯：優先找 administrative_area_level_1 (縣市) 與 sublocality_level_1 / locality (區)
    const city = components.find((c) => c.types.includes('administrative_area_level_1'))?.long_name || ''
    const district = components.find((c) => 
      c.types.includes('sublocality_level_1') || 
      c.types.includes('locality') ||
      c.types.includes('administrative_area_level_2')
    )?.long_name || ''

    const shortName = city + district

    res.status(200).json({
      name: shortName || result.formatted_address,
      address: result.formatted_address
    })
  } catch (error) {
    console.error('Geocoding error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
