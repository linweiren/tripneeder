import { supabase } from '../auth/supabaseClient'
import { geocodeLocation, type GeocodeQuery } from '../geocoding'
export async function geocodeWeatherLocation(query: GeocodeQuery) {
  const session = await supabase?.auth.getSession()
  return geocodeLocation(query, session?.data.session?.access_token)
}
