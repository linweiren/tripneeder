import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CalendarDays, Clock3, Heart, MessageCircle, Share2, Wallet } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  loadSharedTrips,
  recordSharedTripView,
  toggleSharedTripLike,
  unshareTrip,
  type SharedTrip,
} from '../services/community/communityService'
import { getPlanActualDuration } from '../utils/tripTiming'
import { savePlanForDetail } from '../utils/tripPlanStorage'

export function CommunityPage() {
  return <CommunityFeed ownerOnly={false} />
}

export function CommunityMySharesPage() {
  return <CommunityFeed ownerOnly />
}

/** Legacy shared-trip URLs now enter the same planner and discussion as feed cards. */
export function CommunitySharedTripRedirectPage() {
  const { tripId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void loadSharedTrips(tripId)
      .then((trips) => {
        if (!active) return
        setError('')
        const trip = trips[0]
        if (!trip) throw new Error('找不到這份分享，可能已經移除。')
        savePlanForDetail(trip.plan, trip.input, trip.id)
        if (user && !trip.is_owner) void recordSharedTripView(trip.id).catch(() => undefined)
        const from = trip.is_owner ? 'mine' : 'community'
        navigate(`/plans/${encodeURIComponent(trip.plan.id)}?source=community&shareId=${encodeURIComponent(trip.id)}&from=${from}`, { replace: true })
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '分享行程載入失敗。')
      })
    return () => { active = false }
  }, [navigate, tripId, user])

  return (
    <section className="page community-page">
      <Link className="back-link back-icon-button" to="/community" aria-label="返回旅人分享"><ArrowLeft aria-hidden="true" /></Link>
      {error ? <div className="community-empty" role="alert"><h1>無法開啟分享行程</h1><p>{error}</p><Link className="community-detail-button" to="/community">返回旅人分享</Link></div> : <p className="community-empty" role="status">正在開啟行程與討論…</p>}
    </section>
  )
}

function CommunityFeed({ ownerOnly }: { ownerOnly: boolean }) {
  const navigate = useNavigate()
  const { user, isAuthLoading } = useAuth()
  const dialog = useDialog()
  const [trips, setTrips] = useState<SharedTrip[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [feedOffset, setFeedOffset] = useState(30)
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingLikeId, setPendingLikeId] = useState('')
  const [sortMode, setSortMode] = useState<'newest' | 'likes' | 'discussion'>('newest')
  const [locationFilter, setLocationFilter] = useState('')
  const [minBudget, setMinBudget] = useState('')
  const [maxBudget, setMaxBudget] = useState('')
  const [selectedTag, setSelectedTag] = useState('')

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage('')
    try {
      const result = await loadSharedTrips(undefined, ownerOnly, { limit: 30, offset: 0, sort: ownerOnly ? 'newest' : sortMode })
      setTrips(ownerOnly ? result : result.filter((trip) => !trip.is_owner))
      setHasMore(result.length === 30)
      setFeedOffset(result.length)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '分享行程載入失敗。')
    } finally {
      setIsLoading(false)
    }
  }, [ownerOnly, sortMode])

  useEffect(() => { void refresh() }, [refresh])

  async function loadMore() {
    if (isLoadingMore || !hasMore) return
    setIsLoadingMore(true)
    try {
      const result = await loadSharedTrips(undefined, ownerOnly, {
        limit: 30,
        offset: feedOffset,
        sort: ownerOnly ? 'newest' : sortMode,
      })
      setTrips((current) => {
        const ids = new Set(current.map((item) => item.id))
        const next = [...current, ...result.filter((item) => !ids.has(item.id) && (ownerOnly || !item.is_owner))]
        return next
      })
      setHasMore(result.length === 30)
      setFeedOffset((offset) => offset + result.length)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '載入更多分享失敗。')
    } finally {
      setIsLoadingMore(false)
    }
  }

  useEffect(() => {
    if (isAuthLoading || !ownerOnly || user) return
    navigate('/login', { replace: true, state: { from: '/community/mine' } })
  }, [isAuthLoading, navigate, ownerOnly, user])

  const allTags = useMemo(() => Array.from(new Set(trips.flatMap((trip) => trip.tags ?? []))).sort(), [trips])
  const visibleTrips = useMemo(() => {
    const locationNeedle = locationFilter.trim().toLocaleLowerCase()
    const min = minBudget === '' ? null : Number(minBudget)
    const max = maxBudget === '' ? null : Number(maxBudget)
    return trips.filter((trip) => {
      const searchableText = [trip.plan.title, ...trip.plan.stops.map((stop) => stop.name)].join(' ').toLocaleLowerCase()
      if (locationNeedle && !searchableText.includes(locationNeedle)) return false
      if (min !== null && trip.plan.budget < min) return false
      if (max !== null && trip.plan.budget > max) return false
      if (selectedTag && !(trip.tags ?? []).includes(selectedTag)) return false
      return true
    }).sort((a, b) => {
      if (sortMode === 'likes') return b.like_count - a.like_count || b.created_at.localeCompare(a.created_at)
      if (sortMode === 'discussion') return getDiscussionHeat(b) - getDiscussionHeat(a) || b.created_at.localeCompare(a.created_at)
      return b.created_at.localeCompare(a.created_at)
    })
  }, [locationFilter, maxBudget, minBudget, selectedTag, sortMode, trips])

  async function handleLike(trip: SharedTrip) {
    if (!user) {
      navigate('/login', { state: { from: '/community' } })
      return
    }
    setPendingLikeId(trip.id)
    try {
      const result = await toggleSharedTripLike(trip.id)
      setTrips((current) => current.map((item) => item.id === trip.id
        ? { ...item, liked_by_me: result.liked, like_count: result.like_count, reward_awarded: result.reward_awarded }
        : item))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '喜歡狀態更新失敗。')
    } finally {
      setPendingLikeId('')
    }
  }

  async function handleUnshare(trip: SharedTrip) {
    if (!(await dialog.confirm({ title: '取消公開分享', message: '取消後，其他旅人將無法再查看此行程；相關按讚、留言與瀏覽紀錄也會一併移除。確定取消公開分享嗎？', confirmLabel: '取消分享' }))) return
    try {
      await unshareTrip(trip.id)
      setTrips((current) => current.filter((item) => item.id !== trip.id))
      await dialog.alert({ title: '已取消公開分享', message: '此行程已從公開列表移除，相關互動紀錄也已刪除。原因：你已選擇取消公開分享。' })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '取消分享失敗，請稍後再試。')
    }
  }

  function openTrip(trip: SharedTrip) {
    savePlanForDetail(trip.plan, trip.input, trip.id)
    navigate(`/plans/${encodeURIComponent(trip.plan.id)}?source=community&shareId=${encodeURIComponent(trip.id)}&from=${ownerOnly ? 'mine' : 'community'}`)
  }

  return (
    <section className="community-page">
      {ownerOnly ? <Link className="back-link back-icon-button" to="/community" aria-label="返回旅人分享"><ArrowLeft aria-hidden="true" /></Link> : null}
      <header className="community-hero">
        <h1>{ownerOnly ? '我的分享' : '旅人分享'}</h1>
        <div className="community-hero-actions">
          {!ownerOnly ? <Link className="community-my-shares-link" to="/community/mine">我的分享</Link> : null}
          <Link className="community-hero-share-link" to="/favorites"><Share2 size={16} />分享收藏行程</Link>
        </div>
      </header>

      {errorMessage ? <p className="community-error" role="alert">{errorMessage}</p> : null}
      {!ownerOnly ? <CommunityFilters
        locationFilter={locationFilter} setLocationFilter={setLocationFilter}
        minBudget={minBudget} setMinBudget={setMinBudget} maxBudget={maxBudget} setMaxBudget={setMaxBudget}
        allTags={allTags} selectedTag={selectedTag} setSelectedTag={setSelectedTag}
        sortMode={sortMode} setSortMode={setSortMode}
      /> : null}
      {isLoading ? <div className="community-empty" role="status">正在讀取分享行程…</div> : null}
      {!isLoading && !errorMessage && visibleTrips.length === 0 ? (
        <div className="community-empty">
          <h2>{ownerOnly ? '你還沒有分享過行程' : trips.length ? '沒有符合條件的行程' : '還沒有公開分享'}</h2>
          <p>{ownerOnly ? '從行程結果、收藏或行程詳情分享一趟旅程吧。' : '可以調整篩選條件，或從收藏行程開始分享。'}</p>
          {!ownerOnly && trips.length === 0 ? <Link className="community-detail-button" to="/favorites">前往收藏分享</Link> : null}
        </div>
      ) : null}
      {!isLoading && visibleTrips.length > 0 ? <div className="community-list">
        {visibleTrips.map((trip) => ownerOnly
          ? <MySharedTripCard key={trip.id} trip={trip} onOpen={() => openTrip(trip)} onUnshare={() => void handleUnshare(trip)} />
          : <SharedTripCard key={trip.id} trip={trip} pending={pendingLikeId === trip.id} onLike={() => void handleLike(trip)} onOpen={() => openTrip(trip)} />)}
      </div> : null}
      {!isLoading && hasMore ? <div className="community-load-more"><button className="community-detail-button" type="button" onClick={() => void loadMore()} disabled={isLoadingMore}>{isLoadingMore ? '載入中…' : '載入更多分享'}</button></div> : null}
    </section>
  )
}

function CommunityFilters({
  locationFilter, setLocationFilter, minBudget, setMinBudget, maxBudget, setMaxBudget,
  allTags, selectedTag, setSelectedTag, sortMode, setSortMode,
}: {
  locationFilter: string
  setLocationFilter: (value: string) => void
  minBudget: string
  setMinBudget: (value: string) => void
  maxBudget: string
  setMaxBudget: (value: string) => void
  allTags: string[]
  selectedTag: string
  setSelectedTag: (value: string) => void
  sortMode: 'newest' | 'likes' | 'discussion'
  setSortMode: (value: 'newest' | 'likes' | 'discussion') => void
}) {
  return (
    <section className="community-filters" aria-label="篩選旅人分享行程">
      <label className="community-compact-control community-location-control"><span className="sr-only">地點</span><input aria-label="地點" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)} placeholder="地點" /></label>
      <div className="community-budget-control" aria-label="預算範圍"><input aria-label="最低預算" type="number" min="0" value={minBudget} onChange={(event) => setMinBudget(event.target.value)} placeholder="預算起" /><span>–</span><input aria-label="最高預算" type="number" min="0" value={maxBudget} onChange={(event) => setMaxBudget(event.target.value)} placeholder="預算迄" /></div>
      <label className="community-compact-control"><span className="sr-only">標籤</span><select aria-label="標籤" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">全部標籤</option>{allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
      <label className="community-compact-control"><span className="sr-only">排序</span><select aria-label="排序" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="newest">最新</option><option value="likes">最多喜歡</option><option value="discussion">討論熱度</option></select></label>
    </section>
  )
}

function MySharedTripCard({ trip, onOpen, onUnshare }: { trip: SharedTrip; onOpen: () => void; onUnshare: () => void }) {
  const plan = trip.plan
  const date = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit' }).format(new Date(trip.created_at))
  return (
    <article className="stored-trip-card history-card community-my-share-card" role="link" tabIndex={0} onClick={onOpen} onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
    }}>
      <div className="history-card-head"><span className="plan-type history-card-tag">我的分享</span><span className="history-view-link">行程與討論</span></div>
      <div className="stored-trip-main history-card-main"><h2>{plan.title}</h2><p className="community-my-share-author">分享人・{trip.author_display_name}{(trip.tags ?? []).length ? ` · ${trip.tags.map((tag) => `#${tag}`).join(' ')}` : ''}</p></div>
      <dl className="stored-trip-metrics history-info-grid community-my-share-metrics">
        <div className="history-info-item"><span className="history-info-icon"><CalendarDays aria-hidden="true" /></span><dt>分享日期</dt><dd>{date}</dd></div>
        <div className="history-info-item"><span className="history-info-icon"><Clock3 aria-hidden="true" /></span><dt>總時間</dt><dd>{formatCommunityDuration(getPlanActualDuration(plan))}</dd></div>
        <div className="history-info-item"><span className="history-info-icon"><Wallet aria-hidden="true" /></span><dt>預算</dt><dd>約 NT$ {plan.budget.toLocaleString('zh-TW')}</dd></div>
        <div className="history-info-item"><span className="history-info-icon"><Heart aria-hidden="true" /></span><dt>互動</dt><dd>{trip.like_count} 喜歡・{trip.comment_count} 討論</dd></div>
      </dl>
      <div className="community-my-share-footer"><span className="community-my-share-views">{trip.view_count} 次瀏覽</span><button className="community-detail-button" type="button" onClick={(event) => { event.stopPropagation(); onUnshare() }}>取消公開分享</button></div>
    </article>
  )
}

function SharedTripCard({ trip, onLike, pending, onOpen }: {
  trip: SharedTrip
  onLike: () => void
  pending: boolean
  onOpen: () => void
}) {
  const { plan } = trip
  const date = new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric' }).format(new Date(trip.created_at))
  return (
    <article className="community-trip-card">
      <div className="community-trip-topline"><span className="community-trip-category">旅人行程</span><time>{date}</time></div>
      <h2>{plan.title}</h2>
      <p className="community-trip-subtitle">{plan.subtitle || plan.summary}</p>
      <div className="community-author-row"><span>分享人 <strong>{trip.author_display_name}</strong></span></div>
      <div className="community-trip-meta"><span>{plan.stops.length} 個行程地點</span><span>約 NT$ {plan.budget.toLocaleString('zh-TW')}</span><span><MessageCircle size={15} />討論熱度 {getDiscussionHeat(trip)}</span></div>
      {(trip.tags ?? []).length > 0 ? <div className="community-trip-tags">{trip.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
      <footer className="community-trip-actions">
        <button className={`community-like-button${trip.liked_by_me ? ' community-like-active' : ''}`} type="button" onClick={onLike} disabled={pending || trip.is_owner} aria-pressed={trip.liked_by_me}><Heart size={18} fill={trip.liked_by_me ? 'currentColor' : 'none'} />{pending ? '處理中…' : trip.is_owner ? '自己的分享' : trip.liked_by_me ? '已喜歡' : '喜歡'}・{trip.like_count}</button>
        <span className="community-stat"><MessageCircle size={16} />{trip.comment_count} 則討論</span>
        <span className="community-stat">{trip.view_count} 次瀏覽</span>
        <button className="community-detail-button" type="button" onClick={onOpen}>查看行程與討論</button>
      </footer>
    </article>
  )
}

function getDiscussionHeat(trip: SharedTrip) {
  return trip.like_count + trip.comment_count * 2
}

function formatCommunityDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return `${remainder} 分鐘`
  return remainder ? `${hours} 小時 ${remainder} 分鐘` : `${hours} 小時`
}
