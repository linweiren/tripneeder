import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CloudRain, LoaderCircle, MapPin, RefreshCw, Search } from 'lucide-react'
import {
  getCurrentWeather,
  type CurrentWeather,
  type WeatherLocation,
} from '../services/weather/current'

type CurrentWeatherDashboardProps = { userId: string }

export default function CurrentWeatherDashboard({ userId }: CurrentWeatherDashboardProps) {
  const [location, setLocation] = useState<WeatherLocation | null>(() => readSavedLocation(userId))
  const [placeInput, setPlaceInput] = useState('')
  const [weather, setWeather] = useState<CurrentWeather | null>(null)
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [placeLookupStatus, setPlaceLookupStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    setLocation(readSavedLocation(userId))
    setWeather(null)
    setError('')
  }, [userId])

  useEffect(() => {
    if (readSavedLocation(userId)?.mode === 'manual') return
    let cancelled = false
    setLocating(true)
    setError('')
    void getWeatherLocationFromDevice()
      .then((currentLocation) => {
        if (cancelled) return
        setWeather(null)
        setLocation(currentLocation)
        setPlaceLookupStatus('loading')
        void getReverseGeocodedPlace(currentLocation).then((place) => {
          if (cancelled) return
          setPlaceLookupStatus(place ? 'idle' : 'failed')
          if (!place) return
          setLocation((current) => isSameCurrentLocation(current, currentLocation)
            ? { ...current, ...place }
            : current)
        })
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error
            ? `無法自動取得目前位置：${reason.message}。也可以輸入地點查看天氣。`
            : '無法自動取得目前位置，請允許瀏覽器定位或輸入地點。')
        }
      })
      .finally(() => {
        if (!cancelled) setLocating(false)
      })
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (!location) {
      setWeather(null)
      return
    }

    let cancelled = false
    setWeather(null)
    setLoading(true)
    setError('')
    void getCurrentWeather(location)
      .then((result) => {
        if (!cancelled) setWeather(result)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '目前無法取得天氣資料')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [location?.lat, location?.lng, location?.city, location?.mode, refreshVersion])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshVersion((version) => version + 1)
    }, 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (location) window.localStorage.setItem(storageKey(userId), JSON.stringify(location))
  }, [location, userId])

  async function handleUseCurrentLocation() {
    if (!navigator.geolocation) {
      setError('此裝置不支援定位，請輸入地點搜尋。')
      return
    }

    setLocating(true)
    setError('')
    try {
      const currentLocation = await getWeatherLocationFromDevice()
      setWeather(null)
      setLocation(currentLocation)
      setPlaceLookupStatus('loading')
      void getReverseGeocodedPlace(currentLocation).then((place) => {
        setPlaceLookupStatus(place ? 'idle' : 'failed')
        if (!place) return
        setLocation((current) => isSameCurrentLocation(current, currentLocation)
          ? { ...current, ...place }
          : current)
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '無法取得目前位置，請檢查瀏覽器定位權限。')
    } finally {
      setLocating(false)
    }
  }

  async function handleSearchLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const address = placeInput.trim()
    if (!address) return

    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const place = (await response.json()) as {
        lat?: number
        lng?: number
        name?: string
        address?: string
        city?: string
        error?: string
      }
      if (!response.ok || typeof place.lat !== 'number' || typeof place.lng !== 'number') {
        throw new Error(place.error || '找不到這個地點，請試試縣市、區域或完整地址。')
      }
      setWeather(null)
      setLocation({ lat: place.lat, lng: place.lng, name: place.address || place.name || address, city: place.city || '', mode: 'manual' })
      setPlaceInput('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '地點搜尋失敗，請稍後再試。')
      setLoading(false)
    }
  }

  return (
    <section className="current-weather-dashboard" aria-label="天氣儀表板">
      <div className="current-weather-header">
        <div>
          <p className="current-weather-kicker">TRIPNEEDER WEATHER</p>
          <h2>天氣儀表板</h2>
        </div>
        <button
          className="current-weather-icon-button"
          type="button"
          onClick={() => setRefreshVersion((version) => version + 1)}
          disabled={!location || loading || locating}
          aria-label="更新天氣"
          title="更新天氣"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>

      <form className="weather-location-form" onSubmit={(event) => void handleSearchLocation(event)}>
        <label className="weather-location-label" htmlFor="weather-place">設定天氣地點</label>
        <div className="weather-location-input-row">
          <input
            id="weather-place"
            value={placeInput}
            onChange={(event) => setPlaceInput(event.target.value)}
            placeholder="輸入縣市、區域或地址"
            autoComplete="address-level2"
          />
          <button type="submit" aria-label="搜尋地點" disabled={!placeInput.trim() || loading}>
            <Search size={17} aria-hidden="true" />
          </button>
        </div>
        <button
          className="weather-current-location-button"
          type="button"
          onClick={() => void handleUseCurrentLocation()}
          disabled={locating || loading}
        >
          {locating ? <LoaderCircle size={15} className="weather-spinner" /> : <MapPin size={15} />}
          {locating ? '正在定位…' : '使用目前位置'}
        </button>
      </form>

      {location ? (
        <div className="weather-selected-location" aria-live="polite">
          <span>{location.mode === 'current' ? '目前位置' : '設定地點'}</span>
          <strong>{location.name !== '目前位置'
            ? location.name
            : placeLookupStatus === 'loading'
              ? '正在辨識地點…'
              : placeLookupStatus === 'failed'
                ? '無法辨識地點，請搜尋地點'
                : '等待地點資訊'}</strong>
        </div>
      ) : (
        <p className="current-weather-message">輸入地點，或使用目前位置查看天氣。</p>
      )}

      {loading ? <p className="current-weather-message" role="status">正在更新觀測與預報…</p> : null}
      {error ? <p className="current-weather-error" role="alert">{error}</p> : null}

      {!loading && weather ? (
        <>
          <div className="weather-now-card">
            <span className="weather-now-symbol" aria-hidden="true">{weatherEmoji(weather.weather)}</span>
            <div className="weather-now-copy">
              <strong>{weather.temperature === null ? '--' : Math.round(weather.temperature)}<span>°C</span></strong>
              <span>{weather.weather || '目前天氣'}</span>
            </div>
            <span className="weather-rain-now" aria-label={`未來時段降雨機率 ${weather.forecast[0]?.rainProbability ?? '--'}%`}><CloudRain size={15} />{weather.forecast[0]?.rainProbability ?? '--'}%</span>
          </div>
          <div className="weather-current-stats">
            <WeatherStat label="濕度" value={formatValue(weather.humidity, '%')} />
            <WeatherStat label="雨量" value={formatValue(weather.precipitation, ' mm')} />
            <WeatherStat label="風速" value={formatValue(weather.windSpeed, ' m/s')} />
          </div>
          <AirQualityPanel airQuality={weather.airQuality} error={weather.airQualityError} />
          <div className="weather-forecast-heading">
            <h3>未來 8 小時</h3>
          </div>
          {weather.forecast.length ? (
            <ol className="weather-forecast-list">
              {weather.forecast.slice(0, 8).map((period) => (
                <li key={period.startTime}>
                  <time dateTime={period.startTime}>{formatForecastTime(period.startTime)}</time>
                  <span className="weather-forecast-symbol" aria-hidden="true">{weatherEmoji(period.weather)}</span>
                  <span className="weather-forecast-condition">{period.weather || '—'}</span>
                  <span className="weather-forecast-temp">{period.temperature === null ? '--' : `${Math.round(period.temperature)}°`}</span>
                  <span className="weather-forecast-pop"><CloudRain size={13} />{period.rainProbability ?? '--'}%</span>
                </li>
              ))}
            </ol>
          ) : <p className="current-weather-message">目前沒有可顯示的短時預報。</p>}
          <p className="current-weather-source">
            天氣觀測：{[weather.countyName, weather.townName].filter(Boolean).join('')}{weather.stationName}測站・距離 {weather.distanceKm} 公里
            {weather.observedAt ? `・觀測 ${formatObservedAt(weather.observedAt)}` : ''}
          </p>
        </>
      ) : null}
    </section>
  )
}

function WeatherStat({ label, value }: { label: string; value: string }) {
  return <div className="weather-current-stat"><span>{label}</span><strong>{value}</strong></div>
}

function AirQualityPanel({ airQuality, error }: { airQuality: CurrentWeather['airQuality']; error: string | null }) {
  if (!airQuality) {
    return (
      <section className="weather-air-quality" aria-label="空氣品質">
        <div className="weather-air-quality-heading">
          <h3>空氣品質</h3>
          <span>每小時更新</span>
        </div>
        <p className="weather-air-quality-unavailable">
          {error || '附近測站目前沒有可用讀值，請稍後更新。'}
        </p>
      </section>
    )
  }

  const aqiClass = getAqiClass(airQuality.aqi)
  return (
    <section className="weather-air-quality" aria-label="空氣品質">
      <div className="weather-air-quality-heading">
        <div>
          <h3>空氣品質</h3>
          <span>{airQuality.stationName}測站・距離 {airQuality.distanceKm} 公里</span>
        </div>
        <div className={`weather-aqi-badge ${aqiClass}`}>
          <strong>{airQuality.aqi ?? '--'}</strong>
          <span>{airQuality.status || 'AQI'}</span>
        </div>
      </div>
      <div className="weather-air-quality-details">
        <span>PM2.5</span>
        <strong>{formatValue(airQuality.pm25, ' μg/m³')}</strong>
        {airQuality.pollutant ? <span>主要污染物：{airQuality.pollutant}</span> : null}
      </div>
      {airQuality.updatedAt ? <p className="weather-air-quality-time">資料時間 {airQuality.updatedAt}</p> : null}
    </section>
  )
}

function getAqiClass(aqi: number | null) {
  if (aqi === null) return 'weather-aqi-unknown'
  if (aqi <= 50) return 'weather-aqi-good'
  if (aqi <= 100) return 'weather-aqi-moderate'
  if (aqi <= 150) return 'weather-aqi-sensitive'
  if (aqi <= 200) return 'weather-aqi-unhealthy'
  if (aqi <= 300) return 'weather-aqi-very-unhealthy'
  return 'weather-aqi-hazardous'
}

function storageKey(userId: string) { return `weather-dashboard:${userId}` }

function readSavedLocation(userId: string): WeatherLocation | null {
  try {
    const value = window.localStorage.getItem(storageKey(userId))
    if (!value) return null
    const location = JSON.parse(value) as Partial<WeatherLocation>
    if (typeof location.lat !== 'number' || typeof location.lng !== 'number') return null
    return {
      lat: location.lat,
      lng: location.lng,
      name: location.name || '已儲存地點',
      city: location.city || '',
      mode: location.mode === 'manual' ? 'manual' : 'current',
    }
  } catch {
    return null
  }
}

async function getWeatherLocationFromDevice(): Promise<WeatherLocation> {
  if (!navigator.geolocation) throw new Error('此裝置不支援定位')
  const position = await Promise.race([
    getBrowserPosition(),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('定位逾時，請檢查瀏覽器定位權限後重試')), 12_000)
    }),
  ])
  const { latitude: lat, longitude: lng } = position.coords
  // Start weather lookup as soon as coordinates arrive. The weather response
  // already includes the county and township, so reverse geocoding is optional.
  return { lat, lng, name: '目前位置', city: '', mode: 'current' }
}

async function getReverseGeocodedPlace(location: WeatherLocation): Promise<Pick<WeatherLocation, 'name' | 'city'> | null> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: location.lat, lng: location.lng }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const place = (await response.json()) as { name?: string; address?: string; city?: string }
    const name = place.address || place.name
    return name ? { name, city: place.city || location.city } : null
  } catch {
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

function isSameCurrentLocation(current: WeatherLocation | null, target: WeatherLocation): current is WeatherLocation {
  return current?.mode === 'current' && current.lat === target.lat && current.lng === target.lng
}

function getBrowserPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
      timeout: 10_000,
    })
  })
}

function formatValue(value: number | null, suffix: string) { return value === null ? '--' : `${value}${suffix}` }

function formatObservedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

function formatForecastTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

function weatherEmoji(condition: string) {
  if (condition.includes('雷')) return '⛈️'
  if (condition.includes('雨')) return '🌧️'
  if (condition.includes('晴')) return '☀️'
  if (condition.includes('陰') || condition.includes('雲')) return '☁️'
  return '🌤️'
}
