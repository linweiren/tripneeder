export type WeatherLocation = {
  lat: number
  lng: number
  name: string
  city: string
  mode: 'current' | 'manual'
}

export type WeatherForecastPeriod = {
  startTime: string
  weather: string
  temperature: number | null
  rainProbability: number | null
}

export type AirQualityReading = {
  stationName: string
  aqi: number | null
  status: string
  pollutant: string
  pm25: number | null
  updatedAt: string
  distanceKm: number
}

export type CurrentWeather = {
  stationName: string
  countyName: string
  townName: string
  observedAt: string
  distanceKm: number
  weather: string
  temperature: number | null
  humidity: number | null
  precipitation: number | null
  windDirection: number | null
  windSpeed: number | null
  forecast: WeatherForecastPeriod[]
  airQuality: AirQualityReading | null
  airQualityError: string | null
}

export async function getCurrentWeather(location: WeatherLocation) {
  const params = new URLSearchParams({
    lat: String(location.lat),
    lng: String(location.lng),
    city: location.city,
  })
  const response = await fetch(`/api/current-weather?${params.toString()}`)

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(errorData.error || `取得目前天氣失敗，HTTP ${response.status}`)
  }

  return (await response.json()) as CurrentWeather
}
