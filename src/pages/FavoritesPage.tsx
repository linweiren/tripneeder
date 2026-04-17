import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TripRecordList } from '../components/TripRecordList'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  loadFavoriteRecords,
  prepareTripRecordsForUser,
  removeFavoriteRecord,
} from '../services/tripRecords/tripRecordService'
import {
  loadFavoriteTripRecords,
  type StoredTripRecord,
} from '../utils/tripPlanStorage'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

export function FavoritesPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const [recordSnapshot, setRecordSnapshot] = useState<{
    userId: string
    records: StoredTripRecord[]
  } | null>(null)
  const [storageRevision, setStorageRevision] = useState(0)
  const hasPromptedLoginRef = useRef(false)
  const visibleRecords =
    user && recordSnapshot?.userId === user.id ? recordSnapshot.records : []
  const isRecordsLoading = Boolean(user && recordSnapshot?.userId !== user.id)

  useEffect(() => {
    if (!user) {
      return
    }

    let isMounted = true
    const userId = user.id

    async function loadRecords() {
      try {
        await prepareTripRecordsForUser(userId)
        const nextRecords = await loadFavoriteRecords(userId)

        if (isMounted) {
          setRecordSnapshot({
            userId,
            records: nextRecords,
          })
        }
      } catch {
        if (isMounted) {
          setRecordSnapshot({
            userId,
            records: loadFavoriteTripRecords(userId),
          })
        }

        void dialog.alert({
          title: '同步失敗',
          message: '收藏同步失敗，請稍後再試。',
        })
      }
    }

    void loadRecords()

    return () => {
      isMounted = false
    }
  }, [dialog, storageRevision, user])

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
    <section className="page">
      <p className="page-kicker">已收藏行程</p>
      <h1 className="page-title">收藏</h1>
      {user && isRecordsLoading ? (
        <div className="empty-record-panel" role="status" aria-live="polite">
          <h2>正在讀取收藏...</h2>
          <p>我們正在同步你的收藏行程。</p>
        </div>
      ) : null}
      {user && !isRecordsLoading ? (
        <TripRecordList
          records={visibleRecords}
          emptyTitle="還沒有收藏任何方案"
          emptyCopy="在詳情頁底部按下收藏後，行程會出現在這裡。"
          source="favorites"
          onRemove={(recordId) => void handleRemove(recordId)}
        />
      ) : null}
    </section>
  )
}
