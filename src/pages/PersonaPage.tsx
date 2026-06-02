import { useEffect, useState } from 'react'
import {
  CarFront,
  CheckCircle,
  PersonStanding,
  RotateCcw,
  Users,
  UsersRound,
  Utensils,
  Wallet,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../services/auth/supabaseClient'
import { initializeUserProfile, getCachedUserProfile } from '../services/points/pointsService'
import { useAuth } from '../contexts/auth'
import { AppSelect, type AppSelectOption } from '../components/ui/AppSelect'
import type { TransportMode } from '../types/trip'
import personaTitleArt from '../assets/mascot/persona-title-art.png'

const transportModeOptions: Array<{ value: TransportMode; label: string }> = [
  { value: 'scooter', label: '機車' },
  { value: 'car', label: '汽車' },
  { value: 'public_transit', label: '大眾運輸' },
]

const DEFAULT_PERSONA_FORM = {
  companion: '',
  budget: '',
  stamina: '',
  transportMode: '' as TransportMode | '',
  people: '' as number | '',
  diet: '',
}

const companionOptions: Array<AppSelectOption<string>> = [
  { value: '', label: '未設定 (使用預設: 情侶 / 約會)' },
  { value: '情侶 / 約會', label: '情侶 / 約會' },
  { value: '家人', label: '家人' },
  { value: '朋友', label: '朋友' },
  { value: '同事', label: '同事' },
  { value: '獨旅', label: '獨旅' },
  { value: '其他', label: '其他' },
]

const budgetOptions: Array<AppSelectOption<string>> = [
  { value: '', label: '未設定 (使用預設: 一般)' },
  { value: '小資', label: '小資' },
  { value: '一般', label: '一般' },
  { value: '輕奢', label: '輕奢' },
  { value: '豪華', label: '豪華' },
]

const staminaOptions: Array<AppSelectOption<string>> = [
  { value: '', label: '未設定 (使用預設: 普通)' },
  { value: '弱', label: '弱 (偏好慢節奏)' },
  { value: '普通', label: '普通' },
  { value: '強', label: '強 (可以一直走)' },
]

const personaTransportModeOptions: Array<AppSelectOption<TransportMode>> = [
  { value: '', label: '不指定，讓 AI 依行程判斷' },
  ...transportModeOptions,
]

const peopleOptions: Array<AppSelectOption<number>> = [
  { value: '', label: '未設定 (使用預設: 2 人)' },
  ...Array.from({ length: 10 }, (_, index) => {
    const value = index + 1
    return { value, label: `${value} 人` }
  }),
]

export function PersonaPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  // 1. 初始化 state 時優先從快取讀取，達成極速顯示
  const cachedProfile = getCachedUserProfile()
  const [isLoading, setIsLoading] = useState(!cachedProfile)
  const [isSaving, setIsSaving] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const [companion, setCompanion] = useState(cachedProfile?.persona_companion || '')
  const [budget, setBudget] = useState(cachedProfile?.persona_budget || '')
  const [stamina, setStamina] = useState(cachedProfile?.persona_stamina || '')
  const [transportMode, setTransportMode] = useState<TransportMode | ''>(cachedProfile?.persona_transport_mode || '')
  const [people, setPeople] = useState<number | ''>(cachedProfile?.persona_people ?? DEFAULT_PERSONA_FORM.people)
  const [diet, setDiet] = useState(cachedProfile?.persona_diet || '')

  useEffect(() => {
    if (!user) {
      navigate('/login')
      return
    }

    async function loadPersona() {
      if (!supabase) {
        setIsLoading(false)
        return
      }

      try {
        // 背景更新資料並同步到 state
        const profile = await initializeUserProfile()
        
        setCompanion(profile.persona_companion || '')
        setBudget(profile.persona_budget || '')
        setStamina(profile.persona_stamina || '')
        setTransportMode(profile.persona_transport_mode || '')
        setPeople(profile.persona_people ?? DEFAULT_PERSONA_FORM.people)
        setDiet(profile.persona_diet || '')
      } catch (error) {
        console.error('載入人設背景更新失敗:', error)
      } finally {
        setIsLoading(false)
      }
    }

    void loadPersona()
  }, [user, navigate])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!user || !supabase) return

    setIsSaving(true)
    setSaveStatus(null)
    try {
      // 儲存至資料庫
      const { error } = await supabase
        .from('profiles')
        .update({
          persona_companion: companion || null,
          persona_budget: budget || null,
          persona_stamina: stamina || null,
          persona_transport_mode: transportMode || null,
          persona_people: people === '' ? null : people,
          persona_diet: diet || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)

      if (error) throw error

      // 儲存成功後重新同步全域快取
      await initializeUserProfile()
      
      setSaveStatus({ type: 'success', message: '儲存成功！' })
      setTimeout(() => setSaveStatus(null), 3000)
    } catch (error: unknown) {
      console.error('儲存人設失敗:', error)
      const errorMsg = error instanceof Error ? error.message : '請稍後再試'
      setSaveStatus({ type: 'error', message: `儲存失敗: ${errorMsg}` })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleReset() {
    if (!user || !supabase) return

    setIsResetting(true)
    setSaveStatus(null)
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          persona_companion: null,
          persona_budget: null,
          persona_stamina: null,
          persona_transport_mode: null,
          persona_people: null,
          persona_diet: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)

      if (error) throw error

      await initializeUserProfile()

      setCompanion(DEFAULT_PERSONA_FORM.companion)
      setBudget(DEFAULT_PERSONA_FORM.budget)
      setStamina(DEFAULT_PERSONA_FORM.stamina)
      setTransportMode(DEFAULT_PERSONA_FORM.transportMode)
      setPeople(DEFAULT_PERSONA_FORM.people)
      setDiet(DEFAULT_PERSONA_FORM.diet)

      setSaveStatus({ type: 'success', message: '已重設為系統預設。' })
      setTimeout(() => setSaveStatus(null), 3000)
    } catch (error: unknown) {
      console.error('重設人設失敗:', error)
      const errorMsg = error instanceof Error ? error.message : '請稍後再試'
      setSaveStatus({ type: 'error', message: `重設失敗: ${errorMsg}` })
    } finally {
      setIsResetting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="persona-page">
        <div className="loading-state">載入中...</div>
      </div>
    )
  }

  return (
    <div className="persona-page">
      <div className="persona-hero">
        <img
          className="persona-title-art"
          src={personaTitleArt}
          alt=""
          aria-hidden="true"
          width="1672"
          height="941"
          decoding="async"
          loading="eager"
        />
      </div>

      <form className="persona-form" onSubmit={(e) => void handleSave(e)}>
        <div className="persona-card">
          <div className="persona-field-row">
            <span className="persona-field-icon" aria-hidden="true">
              <Users size={24} strokeWidth={1.8} />
            </span>
            <label htmlFor="companion">同行對象</label>
            <div className="persona-control">
              <AppSelect
                id="companion"
                value={companion}
                options={companionOptions}
                onChange={setCompanion}
              />
            </div>
          </div>

          <div className="persona-field-row">
            <span className="persona-field-icon" aria-hidden="true">
              <Wallet size={24} strokeWidth={1.8} />
            </span>
            <label htmlFor="budget">預算感</label>
            <div className="persona-control">
              <AppSelect
                id="budget"
                value={budget}
                options={budgetOptions}
                onChange={setBudget}
              />
            </div>
          </div>

          <div className="persona-field-row">
            <span className="persona-field-icon" aria-hidden="true">
              <PersonStanding size={25} strokeWidth={1.8} />
            </span>
            <label htmlFor="stamina">體力狀況</label>
            <div className="persona-control">
              <AppSelect
                id="stamina"
                value={stamina}
                options={staminaOptions}
                onChange={setStamina}
              />
            </div>
          </div>

          <div className="persona-field-row">
            <span className="persona-field-icon" aria-hidden="true">
              <CarFront size={24} strokeWidth={1.8} />
            </span>
            <label htmlFor="transportMode">常用交通工具</label>
            <div className="persona-control">
              <AppSelect
                id="transportMode"
                value={transportMode}
                options={personaTransportModeOptions}
                onChange={setTransportMode}
              />
            </div>
          </div>

          <div className="persona-field-row">
            <span className="persona-field-icon" aria-hidden="true">
              <UsersRound size={24} strokeWidth={1.8} />
            </span>
            <label htmlFor="people">經常出遊人數</label>
            <div className="persona-control">
              <AppSelect
                id="people"
                value={people}
                options={peopleOptions}
                onChange={setPeople}
              />
            </div>
          </div>

          <div className="persona-field-row persona-diet-row">
            <span className="persona-field-icon" aria-hidden="true">
              <Utensils size={23} strokeWidth={1.8} />
            </span>
            <div className="persona-control persona-diet-control">
              <label htmlFor="diet">飲食禁忌</label>
              <input
                id="diet"
                type="text"
                placeholder="例如：不吃牛、全素、海鮮過敏..."
                value={diet}
                onChange={(e) => setDiet(e.target.value)}
              />
              <p className="field-hint">若無則留空（預設為無飲食禁忌）</p>
            </div>
          </div>
        </div>

        <div className="form-actions">
          <div className="persona-action-buttons">
            <button
              className="submit-button"
              type="submit"
              disabled={isSaving || isResetting}
            >
              <CheckCircle size={20} strokeWidth={2} aria-hidden="true" />
              {isSaving ? '儲存中...' : '儲存設定'}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={isSaving || isResetting}
              onClick={() => void handleReset()}
            >
              <RotateCcw size={20} strokeWidth={2} aria-hidden="true" />
              {isResetting ? '重設中...' : '重設設定'}
            </button>
          </div>
          
          {saveStatus && (
            <div className={`save-status-msg ${saveStatus.type}`}>
              {saveStatus.message}
            </div>
          )}
        </div>
      </form>
    </div>
  )
}
