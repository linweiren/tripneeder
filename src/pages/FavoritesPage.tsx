import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TripRecordList } from '../components/TripRecordList'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  getCachedFavoriteRecords,
  hasCachedTripRecords,
  prepareTripRecordsForUser,
  removeFavoriteRecord,
} from '../services/tripRecords/tripRecordService'
import {
  type StoredTripRecord,
} from '../utils/tripPlanStorage'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'
import favoriteTitleArt from '../assets/mascot/favorite-title-art.png'
import historyBottomBg from '../assets/mascot/history-bottom-bg.png'

const RECORD_SYNC_TIMEOUT_MS = 8000

export function FavoritesPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const [recordSnapshot, setRecordSnapshot] = useState<{
    userId: string
    records: StoredTripRecord[]
  } | null>(null)
  const [isRecordsLoading, setIsRecordsLoading] = useState(false)
  const [storageRevision, setStorageRevision] = useState(0)
  const hasPromptedLoginRef = useRef(false)
  const visibleRecords =
    user && recordSnapshot?.userId === user.id ? recordSnapshot.records : []

  useEffect(() => {
    if (!user) {
      return
    }

    let isMounted = true
    const userId = user.id

    async function loadRecords() {
      const cachedRecords = getCachedFavoriteRecords(userId)
      const hasLoadedRemoteCache = hasCachedTripRecords('favorite', userId)

      if (isMounted) {
        setRecordSnapshot({
          userId,
          records: cachedRecords,
        })
        setIsRecordsLoading(!hasLoadedRemoteCache && cachedRecords.length === 0)
      }

      if (hasLoadedRemoteCache) {
        return
      }

      try {
        await withTimeout(
          prepareTripRecordsForUser(userId),
          RECORD_SYNC_TIMEOUT_MS,
        )
        const nextRecords = getCachedFavoriteRecords(userId)

        if (isMounted) {
          setRecordSnapshot({
            userId,
            records: nextRecords,
          })
          setIsRecordsLoading(false)
        }
      } catch {
        if (isMounted) {
          setRecordSnapshot({
            userId,
            records: getCachedFavoriteRecords(userId),
          })
          setIsRecordsLoading(false)
        }
      }
    }

    void loadRecords()

    return () => {
      isMounted = false
    }
  }, [storageRevision, user])

  useEffect(() => {
    if (isAuthLoading || user || hasPromptedLoginRef.current) {
      return
    }

    hasPromptedLoginRef.current = true
    void dialog
      .confirm({
        title: loginPromptTitle,
        message: loginPromptMessage,
      })
      .then((confirmed) => {
        if (confirmed) {
          navigate('/login', { state: { from: '/favorites' } })
        }
      })
  }, [dialog, isAuthLoading, navigate, user])

  async function handleRemove(recordId: string) {
    if (!user) {
      return
    }

    const record = visibleRecords.find((currentRecord) => currentRecord.id === recordId)

    try {
      await removeFavoriteRecord(recordId, user.id, record?.plan)
      setStorageRevision((current) => current + 1)
    } catch (error) {
      void dialog.alert({
        title: '同步失敗',
        message:
          error instanceof Error
            ? error.message
            : '移除收藏同步失敗，請稍後再試。',
      })
    }
  }

  return (
    <section className="history-page history-page-favorites">
      <section className="history-hero" aria-label="收藏">
        <img
          className="history-title-art"
          src={favoriteTitleArt}
          alt="收藏"
          decoding="async"
        />
      </section>
      <div className="history-scroll">
        {user && !isRecordsLoading ? (
          <div className="history-status-row" aria-label={`已收藏 ${visibleRecords.length} 個`}>
            <span className="history-status-chip">
              已收藏 {visibleRecords.length} 個
            </span>
          </div>
        ) : null}
        {user && isRecordsLoading ? (
          <div className="empty-record-panel" role="status" aria-live="polite">
            <h2>正在讀取收藏...</h2>
            <p>我們正在同步你的收藏行程。</p>
          </div>
        ) : null}
        {user && !isRecordsLoading ? (
          <TripRecordList
            records={visibleRecords}
            emptyTitle="還沒有收藏任何方案呢"
            source="favorites"
            onRemove={(recordId) => void handleRemove(recordId)}
          />
        ) : null}
      </div>
      <img
        className="history-bottom-art"
        src={historyBottomBg}
        alt=""
        aria-hidden="true"
        decoding="async"
        loading="lazy"
      />
    </section>
  )
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<Value>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error('同步逾時，請稍後再試。'))
      }, timeoutMs)
    }),
  ])
}
