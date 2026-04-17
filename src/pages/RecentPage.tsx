import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { TripRecordList } from '../components/TripRecordList'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import { loadRecentTripRecords } from '../utils/tripPlanStorage'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

export function RecentPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const records = loadRecentTripRecords(user?.id)
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
          navigate('/login', { state: { from: '/recent' } })
        }
      })
  }, [dialog, isAuthLoading, navigate, user])

  return (
    <section className="page">
      <p className="page-kicker">最近生成</p>
      <h1 className="page-title">最近生成</h1>
      {user ? (
        <TripRecordList
          records={records}
          emptyTitle="還沒有最近生成"
          emptyCopy="送出行程偏好並成功產生三方案後，最近生成會保存在這裡。"
          source="recent"
        />
      ) : null}
    </section>
  )
}
