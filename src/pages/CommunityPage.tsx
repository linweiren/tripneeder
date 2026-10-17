import { useCallback, useEffect, useState } from 'react'
import { Heart, MapPin, MessageCircleHeart, Users } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  COMMUNITY_LIKE_REWARD_POINTS,
  COMMUNITY_LIKE_REWARD_THRESHOLD,
  loadSharedTrips,
  toggleSharedTripLike,
  type SharedTrip,
} from '../services/community/communityService'

export function CommunityPage() {
  const { tripId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const dialog = useDialog()
  const [trips, setTrips] = useState<SharedTrip[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingLikeId, setPendingLikeId] = useState('')

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage('')
    try {
      setTrips(await loadSharedTrips(tripId))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '分享行程載入失敗。')
    } finally {
      setIsLoading(false)
    }
  }, [tripId])

  useEffect(() => { void refresh() }, [refresh])

  async function handleLike(trip: SharedTrip) {
    if (!user) {
      navigate('/login', { state: { from: tripId ? `/community/${trip.id}` : '/community' } })
      return
    }
    setPendingLikeId(trip.id)
    try {
      const result = await toggleSharedTripLike(trip.id)
      setTrips((current) => current.map((item) => item.id === trip.id
        ? { ...item, liked_by_me: result.liked, like_count: result.like_count, reward_awarded: result.reward_awarded }
        : item))
      if (result.points_awarded > 0) {
        await dialog.alert({
          title: '分享達成里程碑',
          message: `這份行程已達 ${COMMUNITY_LIKE_REWARD_THRESHOLD} 個喜歡，分享者獲得 ${result.points_awarded} 點。`,
        })
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '喜歡狀態更新失敗。')
    } finally {
      setPendingLikeId('')
    }
  }

  const detailTrip = trips[0]
  return (
    <section className="community-page">
      <header className="community-hero">
        <span className="community-kicker"><Users size={16} /> TripNeeder 旅人分享</span>
        <h1>{tripId ? '行程分享' : '看看大家喜歡的行程'}</h1>
        <p>分享你喜歡的旅行安排，讓更多旅人找到下一段靈感。</p>
        <div className="community-reward-note">
          <MessageCircleHeart size={18} /> 行程獲得 {COMMUNITY_LIKE_REWARD_THRESHOLD} 個喜歡，分享者可獲得 {COMMUNITY_LIKE_REWARD_POINTS} 點
        </div>
      </header>

      {tripId ? <Link className="community-back-link" to="/community">← 回到分享列表</Link> : null}
      {errorMessage ? <p className="community-error" role="alert">{errorMessage}</p> : null}
      {isLoading ? <div className="community-empty" role="status">正在讀取分享行程…</div> : null}
      {!isLoading && !errorMessage && trips.length === 0 ? (
        <div className="community-empty"><h2>{tripId ? '找不到這份分享' : '還沒有公開分享'}</h2><p>收藏一份喜歡的行程，再分享給其他旅人吧。</p></div>
      ) : null}

      {!isLoading && detailTrip ? (
        <div className="community-list">
          <SharedTripCard trip={detailTrip} onLike={() => void handleLike(detailTrip)} pending={pendingLikeId === detailTrip.id} detailed />
        </div>
      ) : null}
      {!isLoading && !tripId && trips.length > 0 ? (
        <div className="community-list">
          {trips.map((trip) => <SharedTripCard key={trip.id} trip={trip} onLike={() => void handleLike(trip)} pending={pendingLikeId === trip.id} />)}
        </div>
      ) : null}
    </section>
  )
}

function SharedTripCard({ trip, onLike, pending, detailed = false }: {
  trip: SharedTrip
  onLike: () => void
  pending: boolean
  detailed?: boolean
}) {
  const navigate = useNavigate()
  const { plan } = trip
  const location = trip.input?.location?.name || plan.stops[0]?.address || plan.stops[0]?.name || '旅程探索'
  const date = new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric' }).format(new Date(trip.created_at))
  return (
    <article className={`community-trip-card${detailed ? ' community-trip-card-detailed' : ''}`}>
      <div className="community-trip-topline"><span className="community-trip-category">旅人行程</span><time>{date}</time></div>
      <h2>{plan.title}</h2>
      <p className="community-trip-subtitle">{plan.subtitle || plan.summary}</p>
      <div className="community-author-row"><span className="community-avatar">{trip.author_display_name.slice(0, 1).toUpperCase()}</span><span>分享人 <strong>{trip.author_display_name}</strong></span></div>
      <div className="community-trip-meta"><span><MapPin size={16} />{location}</span><span>{plan.stops.length} 個行程地點</span><span>約 NT$ {plan.budget.toLocaleString('zh-TW')}</span></div>
      {detailed ? (
        <>
          <p className="community-trip-summary">{plan.summary}</p>
          <ol className="community-stop-list">
            {plan.stops.map((stop, index) => <li key={`${stop.id}-${index}`}><span className="community-stop-index">{index + 1}</span><div><strong>{stop.name}</strong><p>{stop.description}</p>{stop.address ? <small>{stop.address}</small> : null}</div></li>)}
          </ol>
          {plan.rainBackup.length > 0 ? <section className="community-backup"><h3>雨天備案</h3><p>{plan.rainBackup.map((stop) => stop.name).join('・')}</p></section> : null}
        </>
      ) : null}
      <footer className="community-trip-actions">
        <button className={`community-like-button${trip.liked_by_me ? ' community-like-active' : ''}`} type="button" onClick={onLike} disabled={pending || trip.is_owner} aria-pressed={trip.liked_by_me}>
          <Heart size={18} fill={trip.liked_by_me ? 'currentColor' : 'none'} />{pending ? '處理中…' : trip.is_owner ? '自己的分享' : trip.liked_by_me ? '已喜歡' : '喜歡'}・{trip.like_count}
        </button>
        {!detailed ? <button className="community-detail-button" type="button" onClick={() => navigate(`/community/${trip.id}`)}>查看行程</button> : null}
        {trip.reward_awarded ? <span className="community-reward-earned">已達標獲得點數</span> : null}
      </footer>
    </article>
  )
}
