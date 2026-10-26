export async function reverseGeocodeCoordinates(lat: number, lng: number, accessToken?: string): Promise<{ name?: string } | null> {
  // GPS coordinates remain usable without signing in; only the paid lookup needs a session.
  if (!accessToken) return null
  const response = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ lat, lng }),
  })
  if (!response.ok) return null
  return response.json()
}
