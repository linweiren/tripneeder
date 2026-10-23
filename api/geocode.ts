/// <reference types="node" />
import { consumeApiRateLimit, getRequestClientKey, isFiniteCoordinate, isJsonWithinLimit, isRecord } from './_lib/request-guards.js'

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
  end: () => void
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body
  if (!isRecord(body) || !isJsonWithinLimit(body, 4_000)) {
    res.status(400).json({ error: '請求格式不正確或資料過大' })
    return
  }
  const lat = body.lat
  const lng = body.lng
  const address = body.address
  if (address !== undefined && (typeof address !== 'string' || address.trim().length > 200)) {
    res.status(400).json({ error: '地點名稱不可超過 200 個字元' })
    return
  }
  if ((lat !== undefined && !isFiniteCoordinate(lat, -90, 90)) ||
    (lng !== undefined && !isFiniteCoordinate(lng, -180, 180)) ||
    ((lat === undefined) !== (lng === undefined))) {
    res.status(400).json({ error: '請提供有效的經緯度' })
    return
  }

  const clientKey = getRequestClientKey(req)
  const ipLimit = await consumeApiRateLimit(`geocode:${clientKey}`, 20, 60_000)
  if (ipLimit !== 'allowed') {
    res.status(ipLimit === 'limited' ? 429 : 503).json({ error: ipLimit === 'limited' ? '地點查詢過於頻繁，請稍後再試。' : '服務保護機制暫時無法使用，請稍後再試。' })
    return
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY

  if (!apiKey) {
    res.status(500).json({ error: 'Google API key not configured' })
    return
  }

  try {
    const isAddressSearch = Boolean(address?.trim())
    if (!isAddressSearch && (!isFiniteCoordinate(lat, -90, 90) || !isFiniteCoordinate(lng, -180, 180))) {
      res.status(400).json({ error: '請提供座標或地點名稱' })
      return
    }

    const query = isAddressSearch
      ? `address=${encodeURIComponent(address!.trim())}&components=country:TW`
      : `latlng=${lat},${lng}`
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${query}&key=${apiKey}&language=zh-TW&region=tw`,
      { signal: AbortSignal.timeout(10_000) },
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
