import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { tripPlanner } from '../services/ai'
import type {
  BudgetLevel,
  TripCategory,
  TripInput,
  TripTag,
} from '../types/trip'
import { saveGeneratedPlans } from '../utils/tripPlanStorage'

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

const initialInput: TripInput = {
  category: 'relax',
  customCategory: '',
  startTime: '',
  endTime: '',
  budget: 'standard',
  people: 2,
  tags: [],
  location: {
    name: '',
  },
}

const loadingSteps = [
  '理解你的旅行偏好',
  '整理時間與起點',
  '準備交給 AI 分析',
]

const hourOptions = Array.from({ length: 24 }, (_, index) =>
  String(index).padStart(2, '0'),
)

const minuteOptions = ['00', '15', '30', '45']

export function HomePage() {
  const navigate = useNavigate()
  const [input, setInput] = useState<TripInput>(initialInput)
  const [isLocating, setIsLocating] = useState(false)
  const [locationStatus, setLocationStatus] = useState('')
  const [formError, setFormError] = useState('')
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const requestIdRef = useRef(0)

  const isOtherCategory = input.category === 'other'

  const selectedLocationText = useMemo(() => {
    if (input.location.lat && input.location.lng) {
      return `目前座標：${input.location.lat.toFixed(5)}, ${input.location.lng.toFixed(5)}`
    }

    return ''
  }, [input.location.lat, input.location.lng])

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

  function handleLocate() {
    if (!navigator.geolocation) {
      window.alert('無法取得您的定位！請檢查權限設定。')
      return
    }

    setIsLocating(true)
    setLocationStatus('')

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude
        const lng = position.coords.longitude

        setInput((current) => ({
          ...current,
          location: {
            name: current.location.name,
            lat,
            lng,
          },
        }))
        setLocationStatus('座標抓取成功！')
        setIsLocating(false)
      },
      () => {
        setIsLocating(false)
        window.alert('無法取得您的定位！請檢查權限設定。')
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    )
  }

  async function startAnalysis() {
    setFormError('')
    setAnalysisError('')

    if (!isValidInput(input)) {
      setFormError('請確認必填欄位都已完成，再開始分析行程。')
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoadingPreview(true)

    try {
      const response = await tripPlanner.generateTripPlans({ input })

      if (requestId !== requestIdRef.current) {
        return
      }

      saveGeneratedPlans(response.plans, input)
      navigate('/results')
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return
      }

      setAnalysisError(
        error instanceof Error
          ? error.message
          : 'AI 分析失敗，請稍後再試。',
      )
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void startAnalysis()
  }

  function cancelAnalysis() {
    requestIdRef.current += 1
    setAnalysisError('')
    setIsLoadingPreview(false)
  }

  if (isLoadingPreview) {
    return (
      <section className="page trip-loading">
        <p className="page-kicker">正在準備分析</p>
        <h1 className="page-title">想來點什麼樣的旅行？</h1>
        <div className="loading-panel" role="status" aria-live="polite">
          {!analysisError ? (
            <div className="loading-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          <div>
            <h2>{analysisError ? '分析沒有成功' : '正在整理你的旅行偏好...'}</h2>
            <p>
              {analysisError ||
                'AI 正在規劃三種行程風格，請稍等一下。'}
            </p>
          </div>
          {!analysisError ? (
            <ul className="loading-steps">
              {loadingSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
          {analysisError ? (
            <div className="loading-actions">
              <button
                className="submit-button"
                type="button"
                onClick={() => void startAnalysis()}
              >
                重新分析
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={cancelAnalysis}
              >
                回到表單
              </button>
            </div>
          ) : null}
          {!analysisError ? (
            <button
              className="secondary-button"
              type="button"
              onClick={cancelAnalysis}
            >
              取消
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section className="page">
      <p className="page-kicker">行程規劃</p>
      <h1 className="page-title">想來點什麼樣的旅行？</h1>
      <p className="page-copy">
        告訴我今天的時間、預算和起點，我們先把偏好整理好。
      </p>

      <form className="trip-form" onSubmit={handleSubmit}>
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
                onClick={() => updateInput('category', option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {isOtherCategory ? (
            <label className="field-label">
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
          <legend>今天想怎麼安排時間？</legend>
          <div className="field-row">
            <TimeSelect
              label="從什麼時候開始？"
              value={input.startTime}
              onChange={(value) => updateInput('startTime', value)}
            />
            <TimeSelect
              label="想玩到什麼時候？"
              value={input.endTime}
              onChange={(value) => updateInput('endTime', value)}
            />
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
                onClick={() => updateInput('budget', option.value)}
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
              onClick={() => updateInput('people', Math.max(1, input.people - 1))}
            >
              -
            </button>
            <strong>{input.people}</strong>
            <button
              type="button"
              onClick={() =>
                updateInput('people', Math.min(10, input.people + 1))
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
          <legend>從哪裡出發？</legend>
          <div className="location-choice">
            <div>
              <button
                className="location-button"
                type="button"
                onClick={handleLocate}
                disabled={isLocating}
              >
                {isLocating ? '定位中...' : '使用目前位置'}
              </button>
              {locationStatus ? (
                <p className="location-success">{locationStatus}</p>
              ) : null}
              {selectedLocationText ? (
                <p className="location-coordinate">{selectedLocationText}</p>
              ) : null}
            </div>

            <div className="or-divider">
              <span>or</span>
            </div>

            <label className="field-label">
              輸入地區或地點
              <input
                value={input.location.name}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    location: {
                      ...current.location,
                      name: event.target.value,
                    },
                  }))
                }
                placeholder="例如：台北信義區、駁二、西門町、我家附近"
              />
            </label>
          </div>
        </fieldset>

        {formError ? <p className="form-error">{formError}</p> : null}

        <button className="submit-button" type="submit">
          出發！GO！
        </button>
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
    input.location.name.trim().length > 0 ||
    (typeof input.location.lat === 'number' &&
      typeof input.location.lng === 'number')

  return (
    input.category.length > 0 &&
    (input.category !== 'other' ||
      Boolean(input.customCategory && input.customCategory.trim())) &&
    isCompleteTime(input.startTime) &&
    isCompleteTime(input.endTime) &&
    input.budget.length > 0 &&
    input.people >= 1 &&
    input.people <= 10 &&
    hasLocation
  )
}

function isCompleteTime(value: string) {
  return /^\d{2}:\d{2}$/.test(value)
}
