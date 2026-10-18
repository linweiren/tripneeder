type VercelRequest = {
  method?: string
  query?: { lat?: string; lng?: string; city?: string }
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
}

type CwaCoordinate = {
  CoordinateName?: string
  StationLatitude?: string
  StationLongitude?: string
}

type CwaStation = {
  StationName?: string
  ObsTime?: { DateTime?: string }
  GeoInfo?: {
    Coordinates?: CwaCoordinate[]
    CountyName?: string
    TownName?: string
  }
  WeatherElement?: {
    Weather?: string
    AirTemperature?: string
    RelativeHumidity?: string
    Now?: { Precipitation?: string }
    WindDirection?: string
    WindSpeed?: string
  }
}

type CwaResponse = {
  success?: string
  records?: { Station?: CwaStation[] }
}

type CwaForecastTime = {
  DataTime?: string
  StartTime?: string
  EndTime?: string
  ElementValue?: Array<Record<string, string | undefined>>
}

type CwaForecastLocation = {
  LocationName?: string
  Latitude?: string
  Longitude?: string
  WeatherElement?: Array<{ ElementName?: string; Time?: CwaForecastTime[] }>
}

type CwaForecastResponse = {
  success?: string
  records?: { Locations?: Array<{ Location?: CwaForecastLocation[] }> }
}

type AirQualityRow = Record<string, string | undefined>
type AirQuality = {
  stationName: string
  aqi: number | null
  status: string
  pollutant: string
  pm25: number | null
  updatedAt: string
  distanceKm: number
}

type StationCache = {
  expiresAt: number
  stations: CwaStation[]
}

let stationCache: StationCache | null = null
let airQualityCache: { expiresAt: number; stations: AirQualityRow[] } | null = null
const forecastCache = new Map<string, { expiresAt: number; forecast: Array<{
  startTime: string
  weather: string
  temperature: number | null
  rainProbability: number | null
}> }>()

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const lat = Number(req.query?.lat)
  const lng = Number(req.query?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: '請提供有效的經緯度' })
    return
  }

  const apiKey = process.env.CWA_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'CWA_API_KEY 尚未設定' })
    return
  }

  try {
    const stations = await getStations(apiKey)
    const stationCandidates = stations
      .map((station) => {
        const coordinates = station.GeoInfo?.Coordinates ?? []
        const coordinate =
          coordinates.find((item) => item.CoordinateName === 'WGS84') ??
          coordinates[0]
        const stationLat = parseNumber(coordinate?.StationLatitude)
        const stationLng = parseNumber(coordinate?.StationLongitude)
        const temperature = parseNumber(station.WeatherElement?.AirTemperature)

        if (stationLat === null || stationLng === null || temperature === null) {
          return null
        }

        return {
          station,
          distanceKm: haversineDistanceKm(lat, lng, stationLat, stationLng),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    const nearest = [...stationCandidates]
      .sort((a, b) => a.distanceKm - b.distanceKm)[0]

    if (!nearest) {
      res.status(404).json({ error: '附近目前沒有可用的氣象觀測資料' })
      return
    }

    const station = nearest.station
    const elements = station.WeatherElement
    const forecastCity = req.query?.city || station.GeoInfo?.CountyName || ''
    const [forecast, airQualityResult] = await Promise.all([
      getForecast(apiKey, lat, lng, forecastCity).catch((error) => {
        console.error('CWA forecast error:', error)
        return []
      }),
      getAirQuality(lat, lng).then((airQuality) => ({ airQuality, error: null as string | null })).catch((error) => {
        console.error('MOENV air quality error:', error)
        return {
          airQuality: null,
          error: error instanceof Error ? error.message : '空品服務暫時無法連線',
        }
      }),
    ])
    res.status(200).json({
      stationName: station.StationName ?? '附近測站',
      countyName: station.GeoInfo?.CountyName ?? '',
      townName: station.GeoInfo?.TownName ?? '',
      observedAt: station.ObsTime?.DateTime ?? '',
      distanceKm: Math.round(nearest.distanceKm * 10) / 10,
      weather: elements?.Weather ?? '',
      temperature: parseNumber(elements?.AirTemperature),
      humidity: parseNumber(elements?.RelativeHumidity),
      precipitation: parseNumber(elements?.Now?.Precipitation),
      windDirection: parseNumber(elements?.WindDirection),
      windSpeed: parseNumber(elements?.WindSpeed),
      forecast,
      airQuality: airQualityResult.airQuality,
      airQualityError: airQualityResult.error,
    })
  } catch (error) {
    console.error('Current weather API error:', error)
    res.status(502).json({ error: '目前無法取得中央氣象署觀測資料' })
  }
}

async function getForecast(apiKey: string, lat: number, lng: number, city: string) {
  const cacheKey = `${city.trim() || 'all'}:${lat.toFixed(2)}:${lng.toFixed(2)}`
  const cached = forecastCache.get(cacheKey)
  let locations: CwaForecastLocation[]
  if (cached && cached.expiresAt > Date.now()) {
    return cached.forecast
  }

  locations = await fetchForecastLocations(apiKey, city)
  if (locations.length === 0 && city.trim()) {
    locations = await fetchForecastLocations(apiKey, '')
  }
  if (locations.length === 0) {
    throw new Error('CWA response did not contain township forecasts')
  }

  const nearest = locations
    .map((location) => ({
      location,
      distanceKm: haversineDistanceKm(
        lat,
        lng,
        Number(location.Latitude),
        Number(location.Longitude),
      ),
    }))
    .filter((item) => Number.isFinite(item.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0]?.location
  if (!nearest) return []

  const elements = nearest.WeatherElement ?? []
  const findElement = (...names: string[]) =>
    elements.find((item) => names.includes(item.ElementName ?? ''))
  const temperatures = findElement('溫度', 'Temperature')?.Time ?? []
  const conditions = findElement('天氣現象', 'Weather')?.Time ?? []
  const rainPeriods = findElement('3小時降雨機率', 'ProbabilityOfPrecipitation')?.Time ?? []
  const now = Date.now()
  const forecast = temperatures
    .map((temperatureTime) => {
      const startTime = temperatureTime.DataTime ?? temperatureTime.StartTime ?? ''
      const timestamp = Date.parse(startTime)
      if (!startTime || !Number.isFinite(timestamp) || timestamp < now || timestamp > now + 24 * 60 * 60 * 1000) {
        return null
      }
      const weatherTime = findTimePeriod(conditions, timestamp)
      const rainTime = findTimePeriod(rainPeriods, timestamp)
      return {
        startTime,
        weather: getForecastValue(weatherTime, 'Weather'),
        temperature: parseNumber(getForecastValue(temperatureTime, 'Temperature')),
        rainProbability: parseNumber(getForecastValue(rainTime, 'ProbabilityOfPrecipitation')),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 24)

  forecastCache.set(cacheKey, { expiresAt: Date.now() + 30 * 60 * 1000, forecast })
  return forecast
}

function findTimePeriod(periods: CwaForecastTime[], timestamp: number) {
  let closest: CwaForecastTime | undefined
  let closestDistance = Number.POSITIVE_INFINITY
  for (const period of periods) {
    const start = Date.parse(period.StartTime ?? period.DataTime ?? '')
    const end = Date.parse(period.EndTime ?? '')
    if (Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end) {
      return period
    }
    if (Number.isFinite(start) && Math.abs(timestamp - start) < closestDistance) {
      closest = period
      closestDistance = Math.abs(timestamp - start)
    }
  }
  return closest
}

async function getAirQuality(lat: number, lng: number): Promise<AirQuality | null> {
  const apiKey = process.env.MOENV_API_KEY
  if (!apiKey) throw new Error('MOENV_API_KEY 尚未設定；請確認 Vercel 環境變數並重新部署')

  if (!airQualityCache || airQualityCache.expiresAt <= Date.now()) {
    const params = new URLSearchParams({ api_key: apiKey, offset: '0', limit: '1000', format: 'json' })
    const response = await fetch(`https://data.moenv.gov.tw/api/v2/AQX_P_432?${params.toString()}`)
    if (!response.ok) throw new Error(`MOENV HTTP status: ${response.status}`)
    const data = (await response.json()) as unknown
    const stations = Array.isArray(data)
      ? data as AirQualityRow[]
      : isRecord(data) && Array.isArray(data.records)
        ? data.records as AirQualityRow[]
        : null
    if (!stations) {
      const message = isRecord(data) && typeof data.message === 'string' ? `：${data.message}` : ''
      throw new Error(`空品 API 回傳格式不正確${message}。請確認 API Key 與資料集權限`)
    }
    airQualityCache = { expiresAt: Date.now() + 30 * 60 * 1000, stations }
  }

  const nearest = airQualityCache.stations
    .map((station) => {
      const stationLat = parseNumber(getField(station, 'latitude'))
      const stationLng = parseNumber(getField(station, 'longitude'))
      if (stationLat === null || stationLng === null) return null
      return { station, distanceKm: haversineDistanceKm(lat, lng, stationLat, stationLng) }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0]
  if (!nearest) return null

  const station = nearest.station
  return {
    stationName: getField(station, 'sitename') || '附近空品測站',
    aqi: parseNumber(getField(station, 'aqi')),
    status: getField(station, 'status'),
    pollutant: getField(station, 'pollutant'),
    pm25: parseNumber(getField(station, 'pm2.5') || getField(station, 'pm25')),
    updatedAt: getField(station, 'publishtime'),
    distanceKm: Math.round(nearest.distanceKm * 10) / 10,
  }
}

function getField(record: AirQualityRow, name: string) {
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? record[key] ?? '' : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fetchForecastLocations(apiKey: string, city: string) {
  const params = new URLSearchParams({ Authorization: apiKey, format: 'JSON' })
  if (city.trim()) params.set('LocationName', city.trim())
  params.set('ElementName', '溫度,天氣現象,3小時降雨機率')
  const response = await fetch(
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-089?${params.toString()}`,
  )
  if (!response.ok) throw new Error(`CWA forecast HTTP status: ${response.status}`)
  const data = (await response.json()) as CwaForecastResponse
  return data.records?.Locations?.flatMap((group) => group.Location ?? []) ?? []
}

function getForecastValue(time: CwaForecastTime | undefined, key: string) {
  const value = time?.ElementValue?.[0]
  return value?.[key] ?? value?.parameterName ?? value?.value ?? ''
}

async function getStations(apiKey: string) {
  if (stationCache && stationCache.expiresAt > Date.now()) {
    return stationCache.stations
  }

  const params = new URLSearchParams({
    Authorization: apiKey,
    format: 'JSON',
  })
  const response = await fetch(
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001?${params.toString()}`,
  )

  if (!response.ok) {
    throw new Error(`CWA HTTP status: ${response.status}`)
  }

  const data = (await response.json()) as CwaResponse
  if (data.success !== 'true' || !data.records?.Station) {
    throw new Error('CWA response did not contain station observations')
  }

  stationCache = {
    expiresAt: Date.now() + 5 * 60 * 1000,
    stations: data.records.Station,
  }
  return stationCache.stations
}

function parseNumber(value?: string | number) {
  if (value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > -90 ? parsed : null
}

function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const latitudeDelta = radians(lat2 - lat1)
  const longitudeDelta = radians(lng2 - lng1)
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
