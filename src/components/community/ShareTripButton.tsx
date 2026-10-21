import { useEffect, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Share2, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/auth'
import { useDialog } from '../../contexts/dialog'
import type { TripInput, TripPlan } from '../../types/trip'
import { COMMUNITY_TAG_LIMIT, getSharedPlanSignature, hasSharedPlan, shareTrip } from '../../services/community/communityService'
import { savePlanForDetail } from '../../utils/tripPlanStorage'

const suggestedTags = ['美食', '小資', '親子', '約會', '戶外', '雨天備案']

export function ShareTripButton({
  plan,
  input,
  className = 'community-share-trigger',
  label = '分享行程',
}: {
  plan: TripPlan
  input: TripInput | null
  className?: string
  label?: string
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, isAuthLoading } = useAuth()
  const dialog = useDialog()
  const planSignature = getSharedPlanSignature(plan)
  const [isOpen, setIsOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [isSharing, setIsSharing] = useState(false)
  const [isShareStatusLoading, setIsShareStatusLoading] = useState(true)
  const [isAlreadyShared, setIsAlreadyShared] = useState(false)

  useEffect(() => {
    let active = true
    if (isAuthLoading) return () => { active = false }
    if (!user) {
      setIsAlreadyShared(false)
      setIsShareStatusLoading(false)
      return () => { active = false }
    }
    setIsShareStatusLoading(true)
    void hasSharedPlan(planSignature)
      .then((shared) => { if (active) setIsAlreadyShared(shared) })
      .catch(() => { if (active) setIsAlreadyShared(false) })
      .finally(() => { if (active) setIsShareStatusLoading(false) })
    return () => { active = false }
  }, [isAuthLoading, planSignature, user])

  function stopCardEvent(event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) {
    event.stopPropagation()
  }

  function openDialog() {
    if (!user) {
      navigate('/login', { state: { from: location.pathname } })
      return
    }
    setTags([])
    setTagDraft('')
    setIsOpen(true)
  }

  function addTag(value = tagDraft) {
    const nextTag = value.trim().replace(/^#/, '').slice(0, 20)
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) {
      setTagDraft('')
      return
    }
    if (tags.length >= COMMUNITY_TAG_LIMIT) return
    setTags((current) => [...current, nextTag])
    setTagDraft('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSharing(true)
    try {
      const sharedId = await shareTrip(plan, input, tags)
      setIsOpen(false)
      savePlanForDetail(plan, input)
      navigate(`/plans/${encodeURIComponent(plan.id)}?source=community&shareId=${encodeURIComponent(sharedId)}&from=mine`)
    } catch (error) {
      await dialog.alert({
        title: '分享失敗',
        message: error instanceof Error ? error.message : '目前無法分享行程，請稍後再試。',
      })
    } finally {
      setIsSharing(false)
    }
  }

  if (isAuthLoading || isShareStatusLoading || isAlreadyShared) return null

  return (
    <>
      <button className={className} type="button" onClick={(event) => { stopCardEvent(event); openDialog() }} onKeyDown={stopCardEvent}>
        <Share2 size={16} aria-hidden="true" /> {label}
      </button>
      {isOpen ? (
        <div className="community-modal-backdrop" role="presentation" onClick={() => setIsOpen(false)}>
          <section className="community-share-modal" role="dialog" aria-modal="true" aria-labelledby="share-trip-title" onClick={(event) => event.stopPropagation()}>
            <button className="community-modal-close" type="button" aria-label="關閉分享設定" onClick={() => setIsOpen(false)}><X size={20} /></button>
            <p className="community-modal-kicker">TRIPNEEDER COMMUNITY</p>
            <h2 id="share-trip-title">分享這趟行程</h2>
            <p className="community-modal-description">為行程加上最多兩個標籤，讓其他旅人更容易找到。</p>
            <form onSubmit={(event) => void handleSubmit(event)}>
              <label className="community-tag-label" htmlFor="community-tag-draft">行程標籤 <span>{tags.length}/{COMMUNITY_TAG_LIMIT}</span></label>
              <div className="community-tag-entry">
                <input
                  id="community-tag-draft"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); addTag() }
                  }}
                  maxLength={20}
                  placeholder={tags.length >= COMMUNITY_TAG_LIMIT ? '最多選兩個標籤' : '輸入標籤後按 Enter'}
                  disabled={tags.length >= COMMUNITY_TAG_LIMIT}
                />
                <button type="button" onClick={() => addTag()} disabled={!tagDraft.trim() || tags.length >= COMMUNITY_TAG_LIMIT}>加入</button>
              </div>
              <div className="community-tag-suggestions" aria-label="常用標籤">
                {suggestedTags.map((tag) => (
                  <button key={tag} type="button" onClick={() => addTag(tag)} disabled={tags.length >= COMMUNITY_TAG_LIMIT || tags.includes(tag)}>#{tag}</button>
                ))}
              </div>
              {tags.length > 0 ? (
                <ul className="community-selected-tags">
                  {tags.map((tag) => <li key={tag}>#{tag}<button type="button" aria-label={`移除標籤 ${tag}`} onClick={() => setTags((current) => current.filter((item) => item !== tag))}><X size={14} /></button></li>)}
                </ul>
              ) : null}
              <div className="community-modal-actions">
                <button className="community-modal-cancel" type="button" onClick={() => setIsOpen(false)} disabled={isSharing}>取消</button>
                <button className="community-modal-submit" type="submit" disabled={isSharing}>{isSharing ? '正在分享…' : '發布分享'}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  )
}
