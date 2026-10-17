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

  const { lat, lng, address } = (req.body as {
    lat?: number
    lng?: number
    address?: string
  }) || {}

  const apiKey = process.env.GOOGLE_PLACES_API_KEY

  if (!apiKey) {
    res.status(500).json({ error: 'Google API key not configured' })
    return
  }

  try {
    const isAddressSearch = Boolean(address?.trim())
    if (!isAddressSearch && (typeof lat !== 'number' || typeof lng !== 'number')) {
      res.status(400).json({ error: '請提供座標或地點名稱' })
      return
    }

    const query = isAddressSearch
      ? `address=${encodeURIComponent(address!.trim())}&components=country:TW`
      : `latlng=${lat},${lng}`
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${query}&key=${apiKey}&language=zh-TW&region=tw`
    )
    const data = (await response.json()) as {
      status: string
      results: Array<{
        formatted_address: string
        geometry?: { location?: { lat: number; lng: number } }
        address_components: Array<{
          long_name: string
          short_name?: string
          types: string[]
        }>
      }>
    }

    if (data.status !== 'OK' || !data.results?.[0]) {
      res.status(data.status === 'ZERO_RESULTS' ? 404 : 502).json({
        error: data.status === 'ZERO_RESULTS' ? '找不到這個地點' : 'Geocoding failed',
        status: data.status,
      })
      return
    }

    const result = data.results[0]
    const components = result.address_components
    const city = components.find((c) => c.types.includes('administrative_area_level_1'))?.long_name || ''
    const countryComponent = components.find((c) => c.types.includes('country'))
    const country = countryComponent?.short_name || countryComponent?.long_name || ''
    const district = components.find((c) => 
      c.types.includes('sublocality_level_1') || 
      c.types.includes('locality') ||
      c.types.includes('administrative_area_level_2')
    )?.long_name || ''

    if (isAddressSearch && country !== 'TW' && country !== 'Taiwan') {
      res.status(400).json({ error: '目前僅支援台灣地點' })
      return
    }

    const shortName = city + district

    res.status(200).json({
      name: shortName || result.formatted_address,
      address: result.formatted_address,
      country,
      city,
      lat: result.geometry?.location?.lat,
      lng: result.geometry?.location?.lng,
    })
  } catch (error) {
    console.error('Geocoding error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
