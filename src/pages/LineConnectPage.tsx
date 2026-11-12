import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { supabase } from '../services/auth/supabaseClient'
import { initializeUserProfile } from '../services/points/pointsService'

export function LineConnectPage() {
  const { user, isAuthLoading, signInWithGoogle } = useAuth()
  const location = useLocation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const params = new URLSearchParams(location.search)
  const link = { line_user_id: params.get('line_user_id'), ts: params.get('ts'), sig: params.get('sig') }
  const valid = Boolean(link.line_user_id && link.ts && link.sig)

  async function connect() {
    setBusy(true); setError('')
    try {
      if (!user) { await signInWithGoogle(window.location.href); return }
      await initializeUserProfile()
      const { data } = await supabase!.auth.getSession()
      if (!data.session || data.session.user.id !== user.id) throw new Error('登入帳號已變更，請重新開啟連接頁面。')
      const response = await fetch('/api/bind-line', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ action: 'begin', ...link }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '無法連接，請從 LINE 取得新連結。')
      const target = new URL(result.url)
      if (target.origin !== 'https://access.line.me' || target.pathname !== '/dialog/bot/accountLink') throw new Error('無效的連接網址。')
      window.location.assign(target.href)
    } catch (err) { setError(err instanceof Error ? err.message : '連接失敗。') }
    finally { setBusy(false) }
  }

  return <section className="empty-record-panel">
    <h1>連接 LINE 帳號</h1>
    <p>連接後，LINE 行程將使用此 TripNeeder 帳號的點數，並保存至同一帳號。</p>
    {user ? <p>目前帳號：{user.email}</p> : <p>請先使用原有帳號登入，再確認連接。</p>}
    <p>接著會開啟 LINE 官方確認頁。請使用發起連接的同一個 LINE 帳號。</p>
    {!valid ? <p role="alert">連結資料不完整，請回到 LINE 取得新連結。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button className="primary-button" disabled={!valid || busy || isAuthLoading} onClick={() => void connect()}>
      {busy ? '處理中…' : user ? '確認連接並前往 LINE' : '使用 Google 登入'}
    </button>
    <p><Link to="/">取消並返回首頁</Link></p>
  </section>
}
