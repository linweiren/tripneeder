import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TripRecordList } from '../components/TripRecordList'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  loadFavoriteTripRecords,
  removeFavoriteTrip,
} from '../utils/tripPlanStorage'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

export function FavoritesPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const [storageRevision, setStorageRevision] = useState(0)
  const records = useMemo(() => {
    void storageRevision
    return loadFavoriteTripRecords(user?.id)
  }, [storageRevision, user?.id])
  const hasPromptedLoginRef = useRef(false)

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

  function handleRemove(recordId: string) {
    removeFavoriteTrip(recordId, user?.id)
    setStorageRevision((current) => current + 1)
  }

  return (
    <section className="page">
      <p className="page-kicker">已收藏行程</p>
      <h1 className="page-title">收藏</h1>
      {user ? (
        <TripRecordList
          records={records}
          emptyTitle="還沒有收藏任何方案"
          emptyCopy="在詳情頁底部按下收藏後，行程會出現在這裡。"
          source="favorites"
          onRemove={handleRemove}
        />
      ) : null}
    </section>
  )
}
