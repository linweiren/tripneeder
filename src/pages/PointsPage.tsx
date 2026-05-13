import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import {
  getTransactionTypeLabel,
  loadPointsSnapshot,
  getCachedPointsSnapshot,
  type PointTransaction,
  type PointsSnapshot,
} from '../services/points/pointsService'
import {
  loginPromptMessage,
  loginPromptTitle,
} from '../utils/loginPrompt'
import pointsHeaderArt from '../assets/mascot/points-header-art.png'
import pointsBalanceCoin from '../assets/mascot/points-balance-coin.png'
import pointsRecordsIcon from '../assets/mascot/points-records-icon.png'
import pointsAddIcon from '../assets/mascot/points-add-icon.png'
import pointsDeductIcon from '../assets/mascot/points-deduct-icon.png'
import pointsAccountIcon from '../assets/mascot/points-account-icon.png'
import historyBottomBg from '../assets/mascot/history-bottom-bg.png'

export function PointsPage() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const { user, isAuthLoading } = useAuth()
  const hasPromptedLoginRef = useRef(false)

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
              : '無法讀取點數資料，請稍後再試。',
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
  }, [pointsSnapshot, user])

  if (!user) {
    return <section className="page" />
  }

  const transactions = visiblePointsSnapshot?.transactions ?? []
  const currentBalance = visiblePointsSnapshot?.profile.points_balance
  const accountEmail = user.email ?? '尚未取得帳號'

  return (
    <section className="points-page" aria-label="點數管理">
      <img
        className="points-bottom-art"
        src={historyBottomBg}
        alt=""
        aria-hidden="true"
      />

      <section className="points-fixed-top">
        <img
          className="points-header-art"
          src={pointsHeaderArt}
          alt="點數管理"
        />

        <div className="points-summary-card" aria-label="帳號與點數摘要">
          <div className="points-summary-item">
            <img
              className="points-summary-icon"
              src={pointsAccountIcon}
              alt=""
              aria-hidden="true"
            />
            <div className="points-summary-copy">
              <span>目前帳號</span>
              <strong className="points-account-email">{accountEmail}</strong>
            </div>
          </div>

          <div className="points-summary-divider" aria-hidden="true" />

          <div className="points-summary-item points-summary-item-balance">
            <img
              className="points-summary-icon points-coin-icon"
              src={pointsBalanceCoin}
              alt=""
              aria-hidden="true"
            />
            <div className="points-summary-copy">
              <span>目前點數</span>
              <strong className="points-balance-value">
                {typeof currentBalance === 'number'
                  ? currentBalance.toLocaleString('zh-TW')
                  : '--'}
              </strong>
            </div>
          </div>
        </div>

        <p className="points-retention-note">
          僅保留最近 30 筆紀錄，後續將自動移除較舊紀錄
        </p>

        {isPointsLoading && !visiblePointsSnapshot ? (
          <p className="points-status">正在讀取點數資料...</p>
        ) : null}

        {pointsError ? (
          <p className="points-error">
            {pointsError}
          </p>
        ) : null}

        <div className="points-history-title">
          <img
            className="points-history-title-icon"
            src={pointsRecordsIcon}
            alt=""
            aria-hidden="true"
          />
          <h2>點數紀錄</h2>
        </div>
      </section>

      <section className="points-history-scroll" aria-label="最近點數紀錄">
        {visiblePointsSnapshot ? (
          transactions.length > 0 ? (
            <ol className="points-record-list">
              {transactions.map((transaction) => (
                <PointRecordItem
                  key={transaction.id}
                  transaction={transaction}
                />
              ))}
            </ol>
          ) : (
            <p className="points-empty-state">目前沒有點數紀錄。</p>
          )
        ) : null}
      </section>
    </section>
  )
}

function PointRecordItem({ transaction }: { transaction: PointTransaction }) {
  const isPositive = transaction.amount > 0
  const amountClassName = isPositive
    ? 'points-record-amount points-record-amount-positive'
    : 'points-record-amount points-record-amount-negative'

  return (
    <li className="points-record-card">
      <div className="points-record-main">
        <img
          className="points-record-icon"
          src={isPositive ? pointsAddIcon : pointsDeductIcon}
          alt=""
          aria-hidden="true"
        />
        <div className="points-record-copy">
          <strong>{getTransactionTypeLabel(transaction.type)}</strong>
          <span>{formatTransactionDate(transaction.created_at)}</span>
        </div>
      </div>

      <div className="points-record-meta">
        <span className={amountClassName}>{formatPointAmount(transaction.amount)}</span>
        <small>餘額 {transaction.balance_after.toLocaleString('zh-TW')}</small>
      </div>
    </li>
  )
}

function formatPointAmount(amount: number) {
  if (amount > 0) {
    return `+${amount.toLocaleString('zh-TW')}`
  }

  return amount.toLocaleString('zh-TW')
}

function formatTransactionDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '時間未明'
  }

  return new Intl.DateTimeFormat('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
