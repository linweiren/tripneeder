
import { useEffect, useState } from 'react'
import {
  getWeather,
  type WeatherResponse,
} from '../services/weather'

type WeatherCardProps = {
  location: string
}

export default function WeatherCard({
  location,
}: WeatherCardProps) {
  const [data, setData] = useState<WeatherResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const city = location.trim()
    let cancelled = false

    if (!city) {
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
        const result = await getWeather(city)

        if (!cancelled) {
          setData(result)
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : '取得天氣資料失敗'
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadWeather()

    return () => {
      cancelled = true
    }
  }, [location])

  if (!location.trim()) {
    return null
  }

  return (
    <section
      style={{
        padding: '20px',
        margin: '16px 0',
        border: '1px solid #e5e7eb',
        borderRadius: '16px',
        background: '#ffffff',
        color: '#1f2937',
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        🌤️ {location} 天氣預報
      </h3>

      {loading && <p>正在取得天氣資料...</p>}

      {error && (
        <p role="alert" style={{ color: '#dc2626' }}>
          {error}
        </p>
      )}

      {data && (
        <>
          <p>
            預報地區：{data.location}
          </p>

          {data.forecasts.length === 0 ? (
            <p>目前沒有可顯示的預報資料。</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px',
              }}
            >
              {data.forecasts.map((forecast) => (
                <article
                  key={forecast.startTime}
                  style={{
                    padding: '14px',
                    borderRadius: '12px',
                    background: '#f3f7fb',
                  }}
                >
                  <p style={{ fontWeight: 600 }}>
                    {forecast.startTime}
                  </p>

                  <p>天氣：{forecast.weather || '暫無資料'}</p>

                  <p>
                    溫度：{forecast.minTemperature || '--'}°C
                    {' ～ '}
                    {forecast.maxTemperature || '--'}°C
                  </p>

                  <p>
                    降雨機率：
                    {forecast.rainProbability
                      ? `${forecast.rainProbability}%`
                      : '暫無資料'}
                  </p>

                  <p>
                    舒適度：{forecast.comfort || '暫無資料'}
                  </p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}