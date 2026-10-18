import { useEffect, useState } from 'react'
import { CloudRain, LoaderCircle } from 'lucide-react'
import { getCurrentWeather, type CurrentWeather, type WeatherForecastPeriod } from '../services/weather/current'

type WeatherCardProps = {
  location: string
  city?: string
  latitude?: number
  longitude?: number
}

type WeatherPoint = {
  time: Date
  weather: string
  temperature: number | null
  rainProbability: number | null
}

export default function WeatherCard({ location, city: requestedCity, latitude, longitude }: WeatherCardProps) {
  const [data, setData] = useState<CurrentWeather | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const placeName = location.trim()
    let cancelled = false
    if (!placeName) {
      setData(null)
      setError('')
      setLoading(false)
      return
    }

    async function loadWeather() {
      setLoading(true)
      setError('')
      setData(null)
      try {
        let lat = latitude
        let lng = longitude
        let city = requestedCity || placeName
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          const response = await fetch('/api/geocode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: placeName }),
          })
          const place = await response.json() as { lat?: number; lng?: number; city?: string; address?: string; error?: string }
          if (!response.ok || typeof place.lat !== 'number' || typeof place.lng !== 'number') {
            throw new Error(place.error || '無法定位行程地點')
          }
          lat = place.lat
          lng = place.lng
          city = requestedCity || place.city || placeName
        }
        if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('缺少行程地點座標')
        const result = await getCurrentWeather({ lat, lng, city, name: placeName, mode: 'manual' })
        if (!cancelled) setData(result)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '目前無法取得天氣資料')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadWeather()
    return () => { cancelled = true }
  }, [latitude, location, longitude])

  if (!location.trim()) return null

  const hourly = data ? buildNextFiveHours(data.forecast) : []
  const currentRain = data?.forecast[0]?.rainProbability ?? null
  return (
    <section className="detail-weather-card" aria-label={`${location}目前及短時天氣`}>
      <div className="detail-weather-heading"><h2>行程附近・{location}</h2><span>目前・未來 5 小時</span></div>
      {loading ? <p className="detail-weather-status" role="status"><LoaderCircle size={15} className="weather-spinner" />取得天氣中…</p> : null}
      {error ? <p className="detail-weather-status" role="alert">{error}</p> : null}
      {!loading && data ? (
        <>
          <div className="detail-weather-current">
            <span className="detail-weather-emoji" aria-hidden="true">{weatherEmoji(data.weather)}</span>
            <div><strong>{data.temperature === null ? '--' : Math.round(data.temperature)}°</strong><span>{data.weather || '目前天氣'}</span></div>
            <span className="detail-weather-rain"><CloudRain size={15} />{currentRain === null ? '--' : `${currentRain}%`}</span>
          </div>
          {hourly.length ? (
            <ol className="detail-weather-hours">
              {hourly.map((hour) => (
                <li key={hour.time.toISOString()}>
                  <time dateTime={hour.time.toISOString()}>{formatHour(hour.time)}</time>
                  <span aria-hidden="true">{weatherEmoji(hour.weather)}</span>
                  <strong>{hour.temperature === null ? '--' : `${Math.round(hour.temperature)}°`}</strong>
                  <span className="detail-weather-rain"><CloudRain size={13} />{hour.rainProbability === null ? '--' : `${hour.rainProbability}%`}</span>
                </li>
              ))}
            </ol>
          ) : <p className="detail-weather-status">目前沒有短時預報資料。</p>}
          {data.observedAt ? <p className="detail-weather-source">觀測至 {formatObservedAt(data.observedAt)}・{data.stationName}</p> : null}
        </>
      ) : null}
    </section>
  )
}

function buildNextFiveHours(forecast: WeatherForecastPeriod[], now = new Date()): WeatherPoint[] {
  const sorted = forecast
    .map((period) => ({ period, time: new Date(period.startTime) }))
    .filter(({ time }) => Number.isFinite(time.getTime()))
    .sort((a, b) => a.time.getTime() - b.time.getTime())
  if (!sorted.length) return []

  const nextHour = new Date(now)
  nextHour.setMinutes(0, 0, 0)
  nextHour.setHours(nextHour.getHours() + 1)
  return Array.from({ length: 5 }, (_, index) => {
    const time = new Date(nextHour)
    time.setHours(nextHour.getHours() + index)
    const timestamp = time.getTime()
    const before = [...sorted].reverse().find((item) => item.time.getTime() <= timestamp)
    const after = sorted.find((item) => item.time.getTime() > timestamp)
    const nearest = before ?? after ?? sorted[sorted.length - 1]
    let temperature = readNumber(nearest.period.temperature)
    if (before && after && before.time.getTime() !== after.time.getTime()) {
      const previousTemp = readNumber(before.period.temperature)
      const nextTemp = readNumber(after.period.temperature)
      if (previousTemp !== null && nextTemp !== null) {
        const ratio = (timestamp - before.time.getTime()) / (after.time.getTime() - before.time.getTime())
        temperature = previousTemp + (nextTemp - previousTemp) * ratio
      }
    }
    return {
      time,
      weather: (before?.period.weather || after?.period.weather || nearest.period.weather).trim(),
      temperature,
      rainProbability: readNumber(nearest.period.rainProbability),
    }
  })
}

function readNumber(value: number | null | string) {
  if (value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function weatherEmoji(value: string) {
  if (/雷/.test(value)) return '⛈️'
  if (/雨|陣雨/.test(value)) return '🌧️'
  if (/雪/.test(value)) return '🌨️'
  if (/晴/.test(value) && /雲/.test(value)) return '⛅'
  if (/晴/.test(value)) return '☀️'
  if (/雲|陰/.test(value)) return '☁️'
  return '🌤️'
}

function formatHour(value: Date) {
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

function formatObservedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
