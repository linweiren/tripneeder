import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useAnalysisSession } from '../contexts/analysisSession'
import { useDialog } from '../contexts/dialog'
import type {
  BudgetLevel,
  TransportMode,
  TripCategory,
  TripInput,
  TripLocation,
  TripTag,
} from '../types/trip'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

const categoryOptions: Array<{ value: TripCategory; label: string }> = [
  { value: 'date', label: '約會' },
  { value: 'relax', label: '放鬆' },
  { value: 'explore', label: '探索' },
  { value: 'food', label: '美食' },
  { value: 'outdoor', label: '戶外走走' },
  { value: 'indoor', label: '室內活動' },
  { value: 'solo', label: '一個人' },
  { value: 'other', label: '其他' },
]

const budgetOptions: Array<{
  value: BudgetLevel
  label: string
  description: string
}> = [
  { value: 'budget', label: '小資', description: '盡量省一點' },
  { value: 'standard', label: '一般', description: '舒服但不鋪張' },
  { value: 'premium', label: '輕奢', description: '可以有一點儀式感' },
  { value: 'luxury', label: '豪華', description: '體驗優先' },
]

const tagOptions: Array<{ value: TripTag; label: string }> = [
  { value: 'not_too_tired', label: '不要太累' },
  { value: 'indoor_first', label: '室內優先' },
  { value: 'hidden_gems', label: '小眾' },
  { value: 'short_distance', label: '短距離' },
  { value: 'food_first', label: '美食優先' },
  { value: 'photo_first', label: '拍照優先' },
  { value: 'no_full_meals', label: '不吃正餐' },
]

const durationOptions = [
  { value: 60, label: '1h' },
  { value: 120, label: '2h' },
  { value: 180, label: '3h' },
  { value: 360, label: '半天 6h' },
  { value: 600, label: '一天 10h' },
  { value: -1, label: '自訂' },
]

const transportModeOptions: Array<{ value: TransportMode; label: string }> = [
  { value: 'scooter', label: '機車' },
  { value: 'car', label: '汽車' },
  { value: 'public_transit', label: '大眾運輸' },
]

const initialInput: TripInput = {
  category: undefined,
  customCategory: '',
  startTime: '',
  endTime: '',
  transportMode: undefined,
  budget: undefined,
  people: undefined,
  tags: [],
  location: {
    name: '',
  },
}

const planSlotLabels = ['保守型', '平衡型', '探索型']

const hourOptions = Array.from({ length: 24 }, (_, index) =>
  String(index).padStart(2, '0'),
)

const minuteOptions = ['00', '15', '30', '45']
const FAST_LOCATION_TARGET_ACCURACY_METERS = 300
const MAX_ACCEPTABLE_LOCATION_ACCURACY_METERS = 1200

export function HomePage() {
  const navigate = useNavigate()
  const {
    session,
    startAnalysis: startSessionAnalysis,
    retryAnalysis,
    resetAnalysisFlow,
    cancelAnalysis,
  } = useAnalysisSession()
  const { user } = useAuth()
  const dialog = useDialog()

  const [input, setInput] = useState<TripInput>(initialInput)
  const [duration, setDuration] = useState<number>(180) // Default 3h
  const [useCurrentLocation, setUseCurrentLocation] = useState(true)
  const [showManualLocation, setShowManualLocation] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  
  const [isLocating, setIsLocating] = useState(false)
  const [locationStatus, setLocationStatus] = useState('')
  const [formError, setFormError] = useState('')

  const isOtherCategory = input.category === 'other'
  const isAnalysisInProgress = session?.status === 'analyzing'
  const analysisError = session?.status === 'error' ? session.error : ''

  // Preference summary for the advanced toggle button
  const preferenceSummary = useMemo(() => {
    const parts: string[] = []
    
    // Location
    if (input.location.name) {
      parts.push(input.location.name)
    } else if (input.location.lat) {
      parts.push('目前位置')
    }

    // Category
    if (input.category) {
      const cat = categoryOptions.find(o => o.value === input.category)
      parts.push(cat?.label || '')
    }

    // Budget
    if (input.budget) {
      const b = budgetOptions.find(o => o.value === input.budget)
      parts.push(b?.label || '')
    }

    // People
    if (input.people) {
      parts.push(`${input.people}人`)
    }

    if (parts.length === 0) return ''
    return `(已設: ${parts.join(', ')})`
  }, [input.location, input.category, input.budget, input.people])

  // Initialize start time to now if not set
  useEffect(() => {
    if (!input.startTime) {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(Math.floor(now.getMinutes() / 15) * 15).padStart(2, '0')
      updateInput('startTime', `${hh}:${mm}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update endTime whenever startTime or duration changes
  useEffect(() => {
    if (input.startTime && duration > 0) {
      const endTime = addMinutesToTime(input.startTime, duration)
      updateInput('endTime', endTime)
    }
  }, [input.startTime, duration])

  const selectedLocationText = useMemo(() => {
    if (input.location.name && input.location.lat && input.location.lng) {
      return `目前位置：${input.location.name}`
    }

    if (input.location.lat && input.location.lng) {
      return `目前座標：${input.location.lat.toFixed(5)}, ${input.location.lng.toFixed(5)}`
    }

    return ''
  }, [input.location.name, input.location.lat, input.location.lng])

  const isCrossDay = useMemo(() => {
    if (!input.startTime || !input.endTime) return false
    const start = parseTimeToMinutes(input.startTime)
    const end = parseTimeToMinutes(input.endTime)
    return end < start
  }, [input.startTime, input.endTime])

  function updateInput<Value extends keyof TripInput>(
    key: Value,
    value: TripInput[Value],
  ) {
    setInput((current) => ({ ...current, [key]: value }))
  }

  function toggleTag(tag: TripTag) {
    setInput((current) => {
      const tags = current.tags.includes(tag)
        ? current.tags.filter((item) => item !== tag)
        : [...current.tags, tag]

      return { ...current, tags }
    })
  }

  function toggleInput<Value extends keyof TripInput>(
    key: Value,
    value: TripInput[Value],
  ) {
    setInput((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }))
  }

  /**
   * Refactored handleLocate to return the final location object.
   * This allows calling it from startAnalysis and waiting for the result.
   */
  async function handleLocate(): Promise<TripLocation | null> {
    if (!navigator.geolocation) {
      void dialog.alert({
        title: '無法取得定位',
        message: '無法取得您的定位！請檢查權限設定。',
      })
      return null
    }

    setIsLocating(true)
    setLocationStatus('')

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude
          const lng = position.coords.longitude
          const initialLocation: TripLocation = { lat, lng, name: '' }

          // Optimization: Resolve immediately once we have coordinates
          // to unblock the UI (e.g. show points confirmation)
          resolve(initialLocation)
          
          setLocationStatus('座標抓取成功，正在背景查詢地名...')

          try {
            const response = await fetch('/api/geocode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lat, lng }),
            })
            const data = await response.json()

            if (data.name) {
              setInput(prev => ({
                ...prev,
                location: { ...prev.location, lat, lng, name: data.name }
              }))
              setLocationStatus('定位成功！')
            } else {
              setLocationStatus('座標抓取成功！')
            }
          } catch (error) {
            console.error('Geocoding failed:', error)
            setLocationStatus('座標抓取成功！')
          } finally {
            setIsLocating(false)
            setUseCurrentLocation(true)
          }
        },
        () => {
          setIsLocating(false)
          void dialog.alert({
            title: '無法取得定位',
            message: '無法取得您的定位！請檢查權限設定。',
          })
          resolve(null)
        },
        {
          enableHighAccuracy: false, // Much faster for most mobile devices
          timeout: 6000,             // Shorter timeout
        },
      )
    })
  }

  async function handleLocatePreferred(): Promise<TripLocation | null> {
    if (!navigator.geolocation) {
      return handleLocate()
    }

    setIsLocating(true)
    setLocationStatus('')

    try {
      const position = await getBestAvailablePosition()
      const lat = position.coords.latitude
      const lng = position.coords.longitude
      const accuracy = Math.round(position.coords.accuracy)
      const location: TripLocation = { lat, lng, name: '' }

      setInput((current) => ({
        ...current,
        location: {
          ...current.location,
          lat,
          lng,
        },
      }))
      setUseCurrentLocation(true)
      setLocationStatus(`座標已取得，精度約 ${accuracy} 公尺，正在查詢地名...`)

      try {
        const response = await fetch('/api/geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lng }),
        })
        const data = await response.json()

        if (data.name) {
          location.name = data.name
          setInput((current) => ({
            ...current,
            location: {
              ...current.location,
              lat,
              lng,
              name: data.name,
            },
          }))
          setLocationStatus(`定位成功，精度約 ${accuracy} 公尺`)
        } else {
          setLocationStatus(`座標已取得，精度約 ${accuracy} 公尺`)
        }
      } catch (error) {
        console.error('Geocoding failed:', error)
        setLocationStatus(`座標已取得，精度約 ${accuracy} 公尺`)
      }

      return location
    } catch (error) {
      void dialog.alert({
        title: '無法取得定位',
        message:
          error instanceof Error && error.message
            ? error.message
            : '無法取得您的定位，請檢查定位權限後再試一次。',
      })
      return null
    } finally {
      setIsLocating(false)
    }
  }

  async function startAnalysis() {
    setFormError('')

    if (!user) {
      const confirmed = await dialog.confirm({
        title: loginPromptTitle,
        message: loginPromptMessage,
      })

      if (confirmed) {
        navigate('/login', { state: { from: '/' } })
      }

      return
    }

    let currentInput = { ...input }

    // Logic: If no location is set, try to auto-locate first
    const hasLocationData = 
      (input.location.name && input.location.name.trim().length > 0) || 
      (input.location.lat && input.location.lng)

    if (!hasLocationData) {
      const autoLocation = await handleLocatePreferred()
      if (!autoLocation) {
        setFormError('無法取得定位，請進入進階設定手動輸入地點。')
        setShowAdvanced(true)
        return
      }
      currentInput.location = autoLocation
    }

    if (!isValidInput(currentInput)) {
      setFormError('請確認必填欄位都已完成，再開始分析行程。')
      setShowAdvanced(true)
      return
    }

    // Confirmation dialog for points
    const confirmed = await dialog.confirm({
      title: '確認生成行程',
      message: '將使用 20 點數 生成完整行程方案 (包含路線與最佳安排)',
      confirmLabel: '確認並扣點',
      cancelLabel: '我再想想'
    })

    if (confirmed) {
      await startSessionAnalysis(currentInput)
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void startAnalysis()
  }

  async function handleCancelAnalysis() {
    const confirmed = await dialog.confirm({
      title: '取消分析',
      message: '確定取消嗎？分析未完成前不會扣除點數。',
      confirmLabel: '確認取消',
    })

    if (confirmed) {
      cancelAnalysis()
    }
  }

  if (session?.status === 'success') {
    return <Navigate to={session.lastRoute} replace />
  }

  if (isAnalysisInProgress || analysisError) {
    const partialPlans = session?.partialPlans ?? []
    const readyCount = Math.min(partialPlans.length, 3)

    return (
      <section className="page trip-loading">
        <p className="page-kicker">正在準備分析</p>
        <h1 className="page-title">想來點什麼樣的旅行？</h1>
        <div className="loading-panel" role="status" aria-live="polite">
          <div>
            <h2>
              {analysisError
                ? '分析沒有成功'
                : readyCount === 0
                  ? '正在整理你的旅行偏好...'
                  : `已完成 ${readyCount} / 3 個方案`}
            </h2>
            {analysisError ? (
              <p>{analysisError}</p>
            ) : null}
          </div>
          {analysisError ? (
            <p className="analysis-no-charge-note">分析失敗不扣除點數</p>
          ) : null}
          {!analysisError ? (
            <ul className="plan-skeleton-list">
              {planSlotLabels.map((slotLabel, index) => {
                const plan = partialPlans[index]
                const isReady = Boolean(plan?.title)
                return (
                  <li
                    key={slotLabel}
                    className={`plan-skeleton-card${isReady ? ' is-ready' : ''}`}
                  >
                    <span className="plan-skeleton-tag">{slotLabel}</span>
                    {isReady ? (
                      <>
                        <h3 className="plan-skeleton-title">{plan?.title}</h3>
                        {plan?.subtitle ? (
                          <p className="plan-skeleton-subtitle">
                            {plan.subtitle}
                          </p>
                        ) : null}
                        {plan?.summary ? (
                          <p className="plan-skeleton-summary">{plan.summary}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="plan-skeleton-bar plan-skeleton-bar-title" />
                        <span className="plan-skeleton-bar plan-skeleton-bar-subtitle" />
                        <span className="plan-skeleton-bar plan-skeleton-bar-summary" />
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {!analysisError ? (
            <div className="loading-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCancelAnalysis()}
              >
                取消分析
              </button>
            </div>
          ) : null}
          {analysisError ? (
            <div className="loading-actions">
              <button
                className="submit-button"
                type="button"
                onClick={() => void retryAnalysis()}
              >
                重新分析
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={resetAnalysisFlow}
              >
                回到表單
              </button>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section className="page home-page">
      <form className="trip-form home-trip-form" onSubmit={handleSubmit}>
        <div className="home-top-panel">
          <div className="home-hero">
            <p className="page-kicker">現場快速排行程</p>
            <h1 className="page-title">想在這玩多久？</h1>
          </div>

          {/* Step 1: Duration Selection (Main View) */}
          <fieldset className="form-section duration-section" aria-label="想玩多久">
            <div className="chip-grid duration-chip-grid">
              <div className="duration-chip-row duration-chip-row-three">
                {durationOptions.slice(0, 3).map((option) => (
                  <button
                    key={option.label}
                    className={
                      duration === option.value ? 'chip chip-active' : 'chip'
                    }
                    type="button"
                    onClick={() => setDuration(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="duration-chip-row duration-chip-row-two">
                {durationOptions.slice(3, 5).map((option) => (
                  <button
                    key={option.label}
                    className={
                      duration === option.value ? 'chip chip-active' : 'chip'
                    }
                    type="button"
                    onClick={() => setDuration(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className={
                duration === -1
                  ? 'custom-duration-toggle custom-duration-toggle-active'
                  : 'custom-duration-toggle'
              }
              type="button"
              aria-pressed={duration === -1}
              onClick={() => setDuration(-1)}
            >
              自訂結束時間
            </button>

            {duration === -1 && (
               <div className="custom-duration-fields">
                  <TimeSelect
                    label="自訂結束時間"
                    value={input.endTime}
                    onChange={(value) => {
                      updateInput('endTime', value)
                      setDuration(0) // Set to 0 to stop auto-calculating from duration
                    }}
                  />
               </div>
            )}
          </fieldset>
        </div>

        <div className="home-bottom-panel">
          <div className="duration-display">
            預計玩到 <strong>{input.endTime}</strong>
            {isCrossDay && <span className="cross-day-note"> (明天)</span>}
          </div>

          {formError ? <p className="form-error" style={{ marginBottom: '16px' }}>{formError}</p> : null}

          <button 
            className="submit-button home-submit-button" 
            type="submit" 
            disabled={isLocating}
          >
            {isLocating ? '正在取得定位...' : '立即出發'}
          </button>

          {/* Step 2: Advanced Settings (Collapsed) */}
          <div className="advanced-toggle-area">
            <button 
              type="button" 
              className="advanced-toggle-button"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? '收起進階設定 ↑' : `更多偏好設定 ${preferenceSummary} ↓`}
            </button>
          </div>
        </div>

        {showAdvanced && (
          <div className="advanced-settings-panel">
            {/* Moved Location Selection here */}
            <fieldset className="form-section">
              <legend>你在哪裡？</legend>
              <div className="location-quick-start">
                <button
                  className={`location-button-large ${useCurrentLocation && input.location.lat ? 'active' : ''}`}
                  type="button"
                  onClick={handleLocatePreferred}
                  disabled={isLocating}
                >
                  {isLocating ? (
                    '定位中...'
                  ) : (
                    <>
                      <span className="icon">📍</span>
                      {selectedLocationText || '使用目前位置'}
                    </>
                  )}
                </button>
                
                {locationStatus && !selectedLocationText ? (
                  <p className="location-status-text">{locationStatus}</p>
                ) : null}

                <button 
                  type="button" 
                  className="toggle-manual-location"
                  onClick={() => {
                    setShowManualLocation(!showManualLocation)
                    if (!showManualLocation) setUseCurrentLocation(false)
                  }}
                >
                  {showManualLocation ? (
                    <>收起指定起點 ▲</>
                  ) : (
                    <>不在現場？改用指定起點 ▼</>
                  )}
                </button>

                {showManualLocation && (
                  <div className="manual-location-fields">
                    <label className="field-label">
                      指定起點名稱
                      <input
                        value={input.location.name}
                        onChange={(event) => {
                          setInput((current) => ({
                            ...current,
                            location: {
                              name: event.target.value,
                              lat: undefined,
                              lng: undefined
                            },
                          }))
                          setUseCurrentLocation(false)
                        }}
                        placeholder="例如：台北信義區、駁二、西門町"
                      />
                    </label>
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>想要哪一種氛圍？</legend>
              <div className="chip-grid">
                {categoryOptions.map((option) => (
                  <button
                    key={option.value}
                    className={
                      input.category === option.value ? 'chip chip-active' : 'chip'
                    }
                    type="button"
                    onClick={() => {
                      toggleInput('category', option.value)
                      if (input.category === option.value) {
                        updateInput('customCategory', '')
                      }
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {isOtherCategory ? (
                <label className="field-label" style={{ marginTop: '12px' }}>
                  其他類型
                  <input
                    value={input.customCategory}
                    onChange={(event) =>
                      updateInput('customCategory', event.target.value)
                    }
                    placeholder="例如：想找安靜、有海風、能慢慢走的地方"
                  />
                </label>
              ) : null}
            </fieldset>

            <fieldset className="form-section">
              <legend>交通工具偏好</legend>
              <div className="chip-grid">
                {transportModeOptions.map((option) => (
                  <button
                    key={option.value}
                    className={
                      input.transportMode === option.value ? 'chip chip-active' : 'chip'
                    }
                    type="button"
                    onClick={() => toggleInput('transportMode', option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>預算感覺</legend>
              <div className="budget-grid">
                {budgetOptions.map((option) => (
                  <button
                    key={option.value}
                    className={
                      input.budget === option.value
                        ? 'budget-option budget-option-active'
                        : 'budget-option'
                    }
                    type="button"
                    onClick={() => toggleInput('budget', option.value)}
                  >
                    <span>{option.label}</span>
                    <small>{option.description}</small>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>幾個人出發？</legend>
              <div className="people-control">
                <button
                  type="button"
                  onClick={() =>
                    updateInput(
                      'people',
                      typeof input.people === 'number'
                        ? input.people <= 1
                          ? undefined
                          : input.people - 1
                        : undefined,
                    )
                  }
                >
                  -
                </button>
                <strong>{input.people ?? '未設置'}</strong>
                <button
                  type="button"
                  onClick={() =>
                    updateInput(
                      'people',
                      typeof input.people === 'number'
                        ? Math.min(10, input.people + 1)
                        : 1,
                    )
                  }
                >
                  +
                </button>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>有什麼偏好或限制？</legend>
              <div className="chip-grid">
                {tagOptions.map((option) => (
                  <button
                    key={option.value}
                    className={
                      input.tags.includes(option.value) ? 'chip chip-active' : 'chip'
                    }
                    type="button"
                    onClick={() => toggleTag(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
            
            <fieldset className="form-section">
              <legend>精確時間設定</legend>
              <div className="field-row">
                <TimeSelect
                  label="開始時間"
                  value={input.startTime}
                  onChange={(value) => updateInput('startTime', value)}
                />
                <TimeSelect
                  label="結束時間"
                  value={input.endTime}
                  onChange={(value) => {
                    updateInput('endTime', value)
                    setDuration(0)
                  }}
                />
              </div>
            </fieldset>
          </div>
        )}
      </form>
    </section>
  )
}

type TimeSelectProps = {
  label: string
  value: string
  onChange: (value: string) => void
}

function TimeSelect({ label, value, onChange }: TimeSelectProps) {
  const [hour = '', minute = ''] = value.split(':')

  function updateTime(nextHour: string, nextMinute: string) {
    if (!nextHour || !nextMinute) return
    onChange(`${nextHour}:${nextMinute}`)
  }

  return (
    <div className="field-label">
      <span>{label}</span>
      <div className="time-select-group">
        <select
          aria-label={`${label} 小時`}
          value={hour}
          onChange={(event) => updateTime(event.target.value, minute)}
        >
          <option value="">時</option>
          {hourOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span aria-hidden="true">:</span>
        <select
          aria-label={`${label} 分鐘`}
          value={minute}
          onChange={(event) => updateTime(hour, event.target.value)}
        >
          <option value="">分</option>
          {minuteOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function isValidInput(input: TripInput) {
  const hasLocation =
    (input.location.name && input.location.name.trim().length > 0) ||
    (typeof input.location.lat === 'number' &&
      typeof input.location.lng === 'number')

  return (
    (input.category === undefined || input.category.length > 0) &&
    (input.category !== 'other' ||
      Boolean(input.customCategory && input.customCategory.trim())) &&
    isCompleteTime(input.startTime) &&
    isCompleteTime(input.endTime) &&
    (input.budget === undefined || input.budget.length > 0) &&
    (input.people === undefined || (input.people >= 1 && input.people <= 10)) &&
    hasLocation
  )
}

function isCompleteTime(value: string) {
  return /^\d{2}:\d{2}$/.test(value)
}

function addMinutesToTime(time: string, minutes: number): string {
  if (!/^\d{2}:\d{2}$/.test(time)) return ''
  const [h, m] = time.split(':').map(Number)
  const date = new Date()
  date.setHours(h, m, 0, 0)
  date.setMinutes(date.getMinutes() + minutes)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return 0

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

async function getBestAvailablePosition() {
  let bestPosition: GeolocationPosition | null = null
  let lastError: Error | null = null

  const attempts: Array<
    PositionOptions & {
      acceptAccuracyMeters?: number
    }
  > = [
    {
      enableHighAccuracy: true,
      timeout: 5000,
      maximumAge: 15000,
      acceptAccuracyMeters: FAST_LOCATION_TARGET_ACCURACY_METERS,
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
      acceptAccuracyMeters: MAX_ACCEPTABLE_LOCATION_ACCURACY_METERS,
    },
    {
      enableHighAccuracy: false,
      timeout: 5000,
      maximumAge: 30000,
    },
  ]

  for (const attempt of attempts) {
    try {
      const position = await getCurrentPosition(attempt)

      if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
        bestPosition = position
      }

      if (
        typeof attempt.acceptAccuracyMeters === 'number' &&
        position.coords.accuracy <= attempt.acceptAccuracyMeters
      ) {
        return position
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('定位失敗')
    }
  }

  if (bestPosition) {
    return bestPosition
  }

  throw lastError ?? new Error('無法取得定位')
}

function getCurrentPosition(options: PositionOptions) {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options)
  })
}
