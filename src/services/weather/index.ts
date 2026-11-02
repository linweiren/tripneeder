
export type WeatherForecast = {
  startTime: string
  endTime: string
  weather: string
  rainProbability: string
  minTemperature: string
  maxTemperature: string
  comfort: string
}

export type WeatherResponse = {
  location: string
  forecasts: WeatherForecast[]
}

export async function getWeather(
  location: string
): Promise<WeatherResponse> {
  const params = new URLSearchParams({ location })

  const response = await fetch(`/api/weather?${params.toString()}`)

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(
      errorData.error || `取得天氣失敗，HTTP ${response.status}`
    )
  }

  return (await response.json()) as WeatherResponse
}