import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../services/auth/supabaseClient'
import { initializeUserProfile, getCachedUserProfile } from '../services/points/pointsService'
import { useAuth } from '../contexts/auth'
import type { TransportMode } from '../types/trip'

const transportModeOptions: Array<{ value: TransportMode; label: string }> = [
  { value: 'scooter', label: '機車' },
  { value: 'car', label: '汽車' },
  { value: 'public_transit', label: '大眾運輸' },
]

export function PersonaPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  // 1. 初始化 state 時優先從快取讀取，達成極速顯示
  const cachedProfile = getCachedUserProfile()
  const [isLoading, setIsLoading] = useState(!cachedProfile)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const [companion, setCompanion] = useState(cachedProfile?.persona_companion || '')
  const [budget, setBudget] = useState(cachedProfile?.persona_budget || '')
  const [stamina, setStamina] = useState(cachedProfile?.persona_stamina || '')
  const [transportMode, setTransportMode] = useState<TransportMode | ''>(cachedProfile?.persona_transport_mode || '')
  const [people, setPeople] = useState<number>(cachedProfile?.persona_people || 2)
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
        setPeople(profile.persona_people || 2)
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
          persona_people: people,
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

  if (isLoading) {
    return (
      <div className="persona-page">
        <div className="loading-state">載入中...</div>
      </div>
    )
  }

  return (
    <div className="persona-page">
      <div className="page-header">
        <h1 className="page-title">個性化設定</h1>
        <p className="page-copy">設定您的旅遊人設，讓 AI 產生更貼近您偏好的行程（隨時可修改）。</p>
      </div>

      <form className="persona-form" onSubmit={(e) => void handleSave(e)}>
        <div className="form-group">
          <label htmlFor="companion">同行對象</label>
          <select
            id="companion"
            value={companion}
            onChange={(e) => setCompanion(e.target.value)}
          >
            <option value="">未設定 (使用預設: 情侶 / 約會)</option>
            <option value="情侶 / 約會">情侶 / 約會</option>
            <option value="家人">家人</option>
            <option value="朋友">朋友</option>
            <option value="同事">同事</option>
            <option value="獨旅">獨旅</option>
            <option value="其他">其他</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="budget">預算感</label>
          <select
            id="budget"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          >
            <option value="">未設定 (使用預設: 一般)</option>
            <option value="小資">小資</option>
            <option value="一般">一般</option>
            <option value="輕奢">輕奢</option>
            <option value="豪華">豪華</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="stamina">體力狀況</label>
          <select
            id="stamina"
            value={stamina}
            onChange={(e) => setStamina(e.target.value)}
          >
            <option value="">未設定 (使用預設: 普通)</option>
            <option value="弱">弱 (偏好慢節奏)</option>
            <option value="普通">普通</option>
            <option value="強">強 (可以一直走)</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="transportMode">常用交通工具</label>
          <select
            id="transportMode"
            value={transportMode}
            onChange={(e) => setTransportMode(e.target.value as TransportMode | '')}
          >
            <option value="">不指定，讓 AI 依行程判斷</option>
            {transportModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="people">經常出遊人數</label>
          <select
            id="people"
            value={people}
            onChange={(e) => setPeople(Number(e.target.value))}
          >
            {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {value} 人
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="diet">飲食禁忌</label>
          <input
            id="diet"
            type="text"
            placeholder="例如：不吃牛、全素、海鮮過敏..."
            value={diet}
            onChange={(e) => setDiet(e.target.value)}
          />
          <p className="field-hint">若無則留空 (預設為無飲食禁忌)</p>
        </div>

        <div className="form-actions">
          <button className="submit-button" type="submit" disabled={isSaving}>
            {isSaving ? '儲存中...' : '儲存設定'}
          </button>
          
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
