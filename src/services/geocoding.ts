export type GeocodedPlace = { name?: string; address?: string; city?: string; lat?: number; lng?: number }
export type GeocodeQuery = { lat: number; lng: number } | { address: string }

export async function geocodeLocation(query: GeocodeQuery, accessToken: string | undefined, fetcher: typeof fetch = fetch): Promise<GeocodedPlace> {
  if (!accessToken) throw new Error('請先登入再查詢地點。')
  const response = await fetcher('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(10_000),
  })
  const value: unknown = await response.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('地點查詢回傳格式不正確。')
  const data = value as Record<string, unknown>
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '地點查詢失敗。')
  const text = (key: string) => typeof data[key] === 'string' ? data[key] as string : undefined
  return { name: text('name'), address: text('address'), city: text('city'),
    lat: typeof data.lat === 'number' && Number.isFinite(data.lat) && Math.abs(data.lat) <= 90 ? data.lat : undefined,
    lng: typeof data.lng === 'number' && Number.isFinite(data.lng) && Math.abs(data.lng) <= 180 ? data.lng : undefined }
}

export async function reverseGeocodeLocationName(lat: number, lng: number, fetcher: typeof fetch = fetch, accessToken?: string): Promise<string | null> {
  try { return (await geocodeLocation({ lat, lng }, accessToken, fetcher)).name?.trim() || null }
  catch { return null }
}
