import { useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useAnalysisSession } from '../contexts/analysisSession'
import { useDialog } from '../contexts/dialog'
import type {
  BudgetLevel,
  TripCategory,
  TripInput,
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

const planSlotLabels = ['保守型', '平衡型', '探索型']

const hourOptions = Array.from({ length: 24 }, (_, index) =>
  String(index).padStart(2, '0'),
)

const minuteOptions = ['00', '15', '30', '45']

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
  const [isLocating, setIsLocating] = useState(false)
  const [locationStatus, setLocationStatus] = useState('')
  const [formError, setFormError] = useState('')

  const isOtherCategory = input.category === 'other'
  const isAnalysisInProgress = session?.status === 'analyzing'
  const analysisError = session?.status === 'error' ? session.error : ''
  const shouldShowOtherCategoryError =
    Boolean(formError) &&
    input.category === 'other' &&
    !input.customCategory?.trim()

  const selectedLocationText = useMemo(() => {
    if (input.location.name && input.location.lat && input.location.lng) {
      return `目前位置：${input.location.name}`
    }

    if (input.location.lat && input.location.lng) {
      return `目前座標：${input.location.lat.toFixed(5)}, ${input.location.lng.toFixed(5)}`
    }

    return ''
  }, [input.location.name, input.location.lat, input.location.lng])

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

  async function handleLocate() {
    if (!navigator.geolocation) {
      void dialog.alert({
        title: '無法取得定位',
        message: '無法取得您的定位！請檢查權限設定。',
      })
      return
    }

    setIsLocating(true)
    setLocationStatus('')

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude
        const lng = position.coords.longitude

        setInput((current) => ({
          ...current,
          location: {
            ...current.location,
            lat,
            lng,
          },
        }))

        setLocationStatus('座標抓取成功，正在反查地名...')

        try {
          const response = await fetch('/api/geocode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng }),
          })
          const data = await response.json()

          if (data.name) {
            setInput((current) => ({
              ...current,
              location: {
                ...current.location,
                name: data.name,
              },
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
        }
      },
      () => {
        setIsLocating(false)
        void dialog.alert({
          title: '無法取得定位',
          message: '無法取得您的定位！請檢查權限設定。',
        })
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    )
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

    if (!isValidInput(input)) {
      setFormError('請確認必填欄位都已完成，再開始分析行程。')
      return
    }

    await startSessionAnalysis(input)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void startAnalysis()
  }

  async function handleCancelAnalysis() {
    const confirmed = await dialog.confirm({
      title: '取消分析',
      message: '確定取消嗎？點數已確定扣除。',
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
            <p>
              {analysisError ||
                (readyCount === 0
                  ? 'AI 正在規劃三種行程風格，請稍等一下。'
                  : '方案會逐張出現，完成後自動前往結果頁。')}
            </p>
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
      <div className="home-hero">
        <p className="page-kicker">行程規劃</p>
        <h1 className="page-title">想來點什麼樣的旅行？</h1>
      </div>

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
                required
                aria-invalid={shouldShowOtherCategoryError}
                aria-describedby={
                  shouldShowOtherCategoryError ? 'custom-category-error' : undefined
                }
                onChange={(event) =>
                  updateInput('customCategory', event.target.value)
                }
                placeholder="例如：想找安靜、有海風、能慢慢走的地方"
              />
              {shouldShowOtherCategoryError ? (
                <p className="field-error" id="custom-category-error">
                  請簡單描述你想要的旅行類型。
                </p>
              ) : null}
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
          出發！GO！（扣除20點數）
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
