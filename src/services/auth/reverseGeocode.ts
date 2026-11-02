import { geocodeLocation } from '../geocoding.js'
export async function reverseGeocodeCoordinates(lat: number, lng: number, accessToken?: string): Promise<{ name?: string } | null> {
  // GPS remains usable without signing in or when the optional paid lookup fails.
  if (!accessToken) return null
  try { const { name } = await geocodeLocation({ lat, lng }, accessToken); return { name } } catch { return null }
}
