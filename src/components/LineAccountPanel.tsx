import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/auth'
import { supabase } from '../services/auth/supabaseClient'

export function LineAccountPanel() {
  const { user } = useAuth()
  const [state, setState] = useState<{ owner: string; linked: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (user) void (async () => {
      try {
        const { data } = await supabase!.auth.getSession()
        if (data.session?.user.id !== user.id) return
        const response = await fetch('/api/bind-line', { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store' })
        const result = await response.json()
        if (!response.ok) throw new Error('暫時無法讀取 LINE 連接狀態。')
        if (active) setState({ owner: user.id, linked: result.linked === true })
      } catch { if (active) setError('暫時無法讀取 LINE 連接狀態。') }
    })()
    return () => { active = false }
  }, [user])
  async function unlink() {
    if (!user || !window.confirm('確定解除此帳號的 LINE 連接？')) return
    setBusy(true); setError('')
    try {
      const { data } = await supabase!.auth.getSession()
      if (data.session?.user.id !== user.id) throw new Error('請重新登入。')
      const response = await fetch('/api/bind-line', { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unbind' }) })
      if (!response.ok) throw new Error('解除失敗，請稍後再試。')
      setState({ owner: user.id, linked: false })
    } catch (err) { setError(err instanceof Error ? err.message : '解除失敗。') }
    finally { setBusy(false) }
  }
  if (!user) return null
  const current = state?.owner === user.id ? state : null
  return <section className="empty-record-panel">
    <h2>LINE 帳號連接</h2>
    {error ? <p role="alert">{error}</p> : null}
    {current ? <p>{current.linked ? '已連接 LINE 帳號' : '尚未連接。請在 LINE 官方帳號發送訊息取得專屬連結。'}</p> : <p>正在確認連接狀態…</p>}
    {current?.linked ? <button type="button" disabled={busy} onClick={() => void unlink()}>{busy ? '解除中…' : '解除 LINE 連接'}</button> : null}
  </section>
}
