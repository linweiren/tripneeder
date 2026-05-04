import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  getTransactionTypeLabel,
  loadPointsSnapshot,
  getCachedPointsSnapshot,
  type PointsSnapshot,
} from '../services/points/pointsService'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'

export function PointsPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const hasPromptedLoginRef = useRef(false)

  // 1. 初始化優先使用快取
  const [pointsSnapshot, setPointsSnapshot] = useState<PointsSnapshot | null>(() => getCachedPointsSnapshot())
  const [pointsError, setPointsError] = useState('')
  const [isPointsLoading, setIsPointsLoading] = useState(!getCachedPointsSnapshot())
  
  const visiblePointsSnapshot =
    pointsSnapshot?.profile.id === user?.id ? pointsSnapshot : null

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
          navigate('/login', { state: { from: '/points' } })
        }
      })
  }, [dialog, isAuthLoading, navigate, user])

  useEffect(() => {
    if (!user) {
      return
    }

    let isMounted = true

    async function loadPoints() {
      // 只有在完全沒資料時才顯示主 loading
      if (!pointsSnapshot) {
        setIsPointsLoading(true)
      }
      setPointsError('')

      try {
        const snapshot = await loadPointsSnapshot()
        if (isMounted) {
          setPointsSnapshot(snapshot)
        }
      } catch (error) {
        if (isMounted) {
          setPointsError(
            error instanceof Error
              ? error.message
              : '目前無法讀取點數資料。',
          )
        }
      } finally {
        if (isMounted) {
          setIsPointsLoading(false)
        }
      }
    }

    void loadPoints()

    return () => {
      isMounted = false
    }
  }, [user])

  if (!user) {
    return <section className="page" />
  }

  return (
    <section className="page points-page">
      <h1 className="page-title">點數管理</h1>
      <div className="points-panel">
        <p className="plan-type">目前帳號</p>
        <h2>{user.email ?? '已登入使用者'}</h2>
        
        {/* 背景更新時顯示一個小的提示或 spinner，不再阻擋整個畫面 */}
        {isPointsLoading && !visiblePointsSnapshot ? <p>正在讀取點數...</p> : null}
        
        {pointsError ? (
          <p className="points-error">
            {pointsError}
          </p>
        ) : null}

        {visiblePointsSnapshot ? (
          <>
            <div className="points-balance-card">
              <span>目前點數</span>
              <strong>{visiblePointsSnapshot.profile.points_balance}</strong>
              {isPointsLoading && <small style={{ display: 'block', fontSize: '12px', color: '#666' }}>更新中...</small>}
            </div>

            <div className="points-history">
              <h2>點數紀錄</h2>
              {visiblePointsSnapshot.transactions.length > 0 ? (
                <ol>
                  {visiblePointsSnapshot.transactions.map((transaction) => (
                    <li key={transaction.id}>
                      <div>
                        <strong>
                          {getTransactionTypeLabel(transaction.type)}
                        </strong>
                        <span>{formatTransactionDate(transaction.created_at)}</span>
                      </div>
                      <div>
                        <span>{formatPointAmount(transaction.amount)}</span>
                        <small>餘額 {transaction.balance_after}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>目前沒有點數紀錄。</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}

function formatPointAmount(amount: number) {
  if (amount > 0) {
    return `+${amount}`
  }

  return String(amount)
}

function formatTransactionDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '未知時間'
  }

  return new Intl.DateTimeFormat('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
