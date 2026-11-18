import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useAnalysisSession } from '../contexts/analysisSession'

export function LineTripPage() {
  const { generationId } = useParams()
  const location = useLocation()
  const { user, isAuthLoading, signInWithGoogle } = useAuth()
  const { restorePaidGeneration } = useAnalysisSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function open() {
    setBusy(true); setError('')
    try {
      if (!user) { await signInWithGoogle(`${window.location.origin}${location.pathname}`); return }
      if (!generationId) throw new Error('找不到行程。')
      await restorePaidGeneration(generationId)
    } catch { setError('無法讀取此行程。請確認登入的是 LINE 連接的原帳號，或至最近行程恢復。') }
    finally { setBusy(false) }
  }
  return <section className="empty-record-panel"><h1>查看 LINE 已完成行程</h1>
    <p>使用連接的 TripNeeder 帳號開啟，免費恢復已扣點行程。</p>
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={busy || isAuthLoading} onClick={() => void open()}>{busy ? '讀取中…' : user ? '開啟行程' : '使用 Google 登入'}</button>
    <p><Link to="/recent">前往最近行程</Link></p>
  </section>
}
