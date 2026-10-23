export async function reverseGeocodeLocationName(
  lat: number,
  lng: number,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    })
    if (!response.ok) return null
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('name' in data) || typeof data.name !== 'string') return null
    return data.name.trim() || null
  } catch {
    return null
  }
}
