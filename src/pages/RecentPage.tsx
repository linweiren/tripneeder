import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TripRecordList } from '../components/TripRecordList'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  getCachedRecentRecords,
  hasCachedTripRecords,
  loadRecentRecords,
  prepareTripRecordsForUser,
} from '../services/tripRecords/tripRecordService'
import {
  type StoredTripRecord,
} from '../utils/tripPlanStorage'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

const RECORD_SYNC_TIMEOUT_MS = 8000

export function RecentPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const [recordSnapshot, setRecordSnapshot] = useState<{
    userId: string
    records: StoredTripRecord[]
  } | null>(null)
  const [isRecordsLoading, setIsRecordsLoading] = useState(false)
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
      const cachedRecords = getCachedRecentRecords(userId)
      const hasLoadedRemoteCache = hasCachedTripRecords('recent', userId)

      if (isMounted) {
        setRecordSnapshot({
          userId,
          records: cachedRecords,
        })
        setIsRecordsLoading(!hasLoadedRemoteCache && cachedRecords.length === 0)
      }

      try {
        await withTimeout(
          prepareTripRecordsForUser(userId),
          RECORD_SYNC_TIMEOUT_MS,
        )
        const nextRecords = await withTimeout(
          loadRecentRecords(userId),
          RECORD_SYNC_TIMEOUT_MS,
        )

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
            records: getCachedRecentRecords(userId),
          })
          setIsRecordsLoading(false)
        }
      }
    }

    void loadRecords()

    return () => {
      isMounted = false
    }
  }, [user])

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
          navigate('/login', { state: { from: '/recent' } })
        }
      })
  }, [dialog, isAuthLoading, navigate, user])

  return (
    <section className="page">
      <p className="page-kicker">最近生成</p>
      <h1 className="page-title">最近生成</h1>
      {user && isRecordsLoading ? (
        <div className="empty-record-panel" role="status" aria-live="polite">
          <h2>正在讀取最近生成...</h2>
          <p>我們正在同步你的行程紀錄。</p>
        </div>
      ) : null}
      {user && !isRecordsLoading ? (
        <TripRecordList
          records={visibleRecords}
          emptyTitle="還沒有最近生成的方案呀"
          source="recent"
        />
      ) : null}
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
