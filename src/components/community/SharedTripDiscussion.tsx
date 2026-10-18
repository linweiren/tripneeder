import { useEffect, useState, type FormEvent } from 'react'
import { MessageCircle, Trash2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/auth'
import { useDialog } from '../../contexts/dialog'
import {
  addSharedTripComment,
  COMMUNITY_COMMENT_LIMIT,
  deleteSharedTripComment,
  loadSharedTripComments,
  type SharedTripComment,
} from '../../services/community/communityService'

export function SharedTripDiscussion({ tripId }: { tripId: string }) {
  const { user } = useAuth()
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const [comments, setComments] = useState<SharedTripComment[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function refreshComments() {
    setComments(await loadSharedTripComments(tripId))
  }

  useEffect(() => {
    let mounted = true
    setLoading(true)
    void loadSharedTripComments(tripId)
      .then((result) => { if (mounted) setComments(result) })
      .catch((reason: unknown) => { if (mounted) setError(reason instanceof Error ? reason.message : '討論內容載入失敗。') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [tripId])

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    if (!user) {
      navigate('/login', { state: { from: `${location.pathname}${location.search}` } })
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await addSharedTripComment(tripId, body)
      setDraft('')
      await refreshComments()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '留言發布失敗，請稍後再試。')
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteComment(commentId: string) {
    if (!(await dialog.confirm({ title: '刪除留言', message: '確定要刪除這則留言嗎？', confirmLabel: '刪除' }))) return
    try {
      await deleteSharedTripComment(commentId)
      await refreshComments()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '留言刪除失敗。')
    }
  }

  return (
    <section className="community-discussion" aria-labelledby="discussion-title">
      <header className="community-discussion-header">
        <div className="community-discussion-title"><MessageCircle size={18} aria-hidden="true" /><h2 id="discussion-title">討論區</h2></div>
        <span>{comments.length} 則</span>
      </header>
      <form className="community-comment-form" onSubmit={(event) => void submitComment(event)}>
        <label className="sr-only" htmlFor="shared-trip-comment-draft">留言</label>
        <textarea id="shared-trip-comment-draft" value={draft} onChange={(event) => setDraft(event.target.value.slice(0, COMMUNITY_COMMENT_LIMIT))} maxLength={COMMUNITY_COMMENT_LIMIT} placeholder={user ? '寫下你的行程建議或心得…' : '登入後即可留言'} />
        <div className="community-comment-submit-row"><span>{draft.length}/{COMMUNITY_COMMENT_LIMIT}</span><button type="submit" disabled={submitting || !draft.trim()}>{submitting ? '發布中…' : '留言'}</button></div>
      </form>
      {error ? <p className="community-error" role="alert">{error}</p> : null}
      {loading ? <p className="community-comments-status">載入中…</p> : comments.length === 0 ? <p className="community-comments-status">還沒有留言</p> : (
        <ol className="community-comments-list">
          {comments.map((comment) => (
            <li key={comment.id} className="community-comment">
              <div className="community-comment-author"><span className="community-avatar">{comment.author_display_name.slice(0, 1).toUpperCase()}</span><strong>{comment.author_display_name}</strong><time>{formatCommentDate(comment.created_at)}</time>{comment.is_mine ? <button type="button" className="community-comment-delete" aria-label="刪除留言" onClick={() => void deleteComment(comment.id)}><Trash2 size={15} /></button> : null}</div>
              <p>{comment.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function formatCommentDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
