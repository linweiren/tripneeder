import { useRef, useState } from 'react'
import { useAuth } from '../contexts/auth'
import { useAnalysisSession } from '../contexts/analysisSession'
import { supabase } from '../services/auth/supabaseClient'

type PaidRow = { generation_id: string; completed_at: string }

export function PaidGenerationRecovery() {
  const { user } = useAuth()
  const { restorePaidGeneration } = useAnalysisSession()
  const [snapshot, setSnapshot] = useState<{ owner: string; rows: PaidRow[]; next: number | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ownerRef = useRef(user?.id)
  ownerRef.current = user?.id
  const visible = snapshot?.owner === user?.id ? snapshot : null
  if (!user) return null

  async function load(offset = 0) {
    const owner = user!.id
    setBusy(true); setError('')
    try {
      const { data } = await supabase!.auth.getSession()
      if (!data.session || data.session.user.id !== owner) throw new Error('請先登入。')
      const response = await fetch(`/api/trip-generations?offset=${offset}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
      })
      if (!response.ok) throw new Error('暫時無法讀取已扣點紀錄，請稍後再試。')
      const result = await response.json() as { generations: PaidRow[]; nextOffset: number | null }
      if (ownerRef.current === owner) setSnapshot({ owner, rows: result.generations, next: result.nextOffset })
    } catch (err) { if (ownerRef.current === owner) setError(err instanceof Error ? err.message : '讀取失敗。') }
    finally { setBusy(false) }
  }

  async function restore(id: string) {
    setBusy(true); setError('')
    try { await restorePaidGeneration(id) }
    catch (err) { setError(err instanceof Error ? err.message : '恢復失敗。') }
    finally { setBusy(false) }
  }

  return <div className="empty-record-panel">
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>
      查看已扣點行程（可免費恢復）
    </button>
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <p role="status">正在確認已扣點紀錄…</p> : null}
    {visible ? <>
      {visible.rows.length === 0 ? <p>目前沒有已扣點紀錄。</p> : <ul>
        {visible.rows.map(row => <li key={row.generation_id}>
          <button type="button" disabled={busy} onClick={() => void restore(row.generation_id)}>
            恢復 {new Date(row.completed_at).toLocaleString('zh-TW')} 的行程
          </button>
        </li>)}
      </ul>}
      {visible.next !== null ? <button type="button" disabled={busy} onClick={() => void load(visible.next!)}>下一頁</button> : null}
    </> : null}
  </div>
}
