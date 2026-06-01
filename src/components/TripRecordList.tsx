import { useNavigate } from 'react-router-dom'
import { useDialog } from '../contexts/dialog'
import type { TransportMode } from '../types/trip'
import { getPlanActualDuration } from '../utils/tripTiming'
import {
  savePlanForDetail,
  type StoredTripRecord,
} from '../utils/tripPlanStorage'
import mascotEmptyState from '../assets/mascot/mascot-empty-state.webp'

const transportLabels: Record<TransportMode, string> = {
  scooter: '機車',
  car: '開車',
  public_transit: '大眾運輸',
}

type TripRecordListProps = {
  records: StoredTripRecord[]
  emptyTitle: string
  source: 'favorites' | 'recent'
  onRemove?: (recordId: string) => void
}

export function TripRecordList({
  records,
  emptyTitle,
  source,
  onRemove,
}: TripRecordListProps) {
  const navigate = useNavigate()
  const dialog = useDialog()

  function openRecord(record: StoredTripRecord) {
    savePlanForDetail(record.plan, record.input)
    const params = new URLSearchParams({
      source,
      recordId: record.id,
    })
    navigate(`/plans/${record.plan.id}?${params.toString()}`, {
      state: { from: source, recordId: record.id },
    })
  }

  if (records.length === 0) {
    return (
      <div className="empty-record-panel">
        <img
          className="empty-record-mascot"
          src={mascotEmptyState}
          width={320}
          height={382}
          alt="TripNeeder 奶油白旅行貓休息中"
          decoding="async"
          loading="eager"
        />
        <h2>{emptyTitle}</h2>
      </div>
    )
  }

  return (
    <div className="stored-trip-list history-list">
      {records.map((record) => (
        <article
          className={`stored-trip-card history-card${onRemove ? ' stored-trip-card-removable history-card-removable' : ''}`}
          key={record.id}
          role="button"
          tabIndex={0}
          onClick={() => openRecord(record)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openRecord(record)
            }
          }}
        >
          <div className="history-card-head">
            <span className="plan-type history-card-tag">行程方案</span>
            {onRemove ? (
              <button
                className="remove-record-button history-remove-button"
                type="button"
                onClick={(event) => {
                  event.stopPropagation()

                  void dialog
                    .confirm({
                      title: '移除收藏',
                      message: '確定要永久移除這個收藏嗎？',
                      confirmLabel: '移除收藏',
                    })
                    .then((confirmed) => {
                      if (confirmed) {
                        onRemove(record.id)
                      }
                    })
                }}
              >
                移除收藏
              </button>
            ) : (
              <span className="history-view-link" aria-hidden="true">
                查看行程
              </span>
            )}
          </div>

          <div className="stored-trip-main history-card-main">
            <h2>{record.plan.title}</h2>
          </div>

          <dl className="stored-trip-metrics history-info-grid">
            <div className="history-info-item">
              <MetricIcon type="calendar" />
              <dt>日期</dt>
              <dd>{formatRecordDate(record.createdAt)}</dd>
            </div>
            <div className="history-info-item">
              <MetricIcon type="clock" />
              <dt>總時間</dt>
              <dd>{formatMinutes(getPlanActualDuration(record.plan))}</dd>
            </div>
            <div className="history-info-item">
              <MetricIcon type="wallet" />
              <dt>預算</dt>
              <dd>約 NT$ {record.plan.budget.toLocaleString('zh-TW')}</dd>
            </div>
            <div className="history-info-item">
              <MetricIcon type="vehicle" />
              <dt>交通</dt>
              <dd>{transportLabels[record.plan.transportMode]}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  )
}

function MetricIcon({
  type,
}: {
  type: 'calendar' | 'clock' | 'wallet' | 'vehicle'
}) {
  return (
    <span className="history-info-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {type === 'calendar' ? (
          <>
            <path d="M7 3.75v3M17 3.75v3M5.75 8.25h12.5" />
            <rect x="4.25" y="5.25" width="15.5" height="15" rx="3" />
            <path d="M8.25 12h.1M12 12h.1M15.75 12h.1M8.25 15.75h.1M12 15.75h.1" />
          </>
        ) : null}
        {type === 'clock' ? (
          <>
            <circle cx="12" cy="12" r="8.25" />
            <path d="M12 7.75v4.65l3.2 1.9" />
          </>
        ) : null}
        {type === 'wallet' ? (
          <>
            <path d="M5.25 7.25h12.2a2.3 2.3 0 0 1 2.3 2.3v6.9a2.3 2.3 0 0 1-2.3 2.3H5.25a2 2 0 0 1-2-2V7.35a2.1 2.1 0 0 1 2.1-2.1h10.4" />
            <path d="M15.5 12.1h4.25v3.8H15.5a1.9 1.9 0 0 1 0-3.8Z" />
            <path d="M16.6 14h.1" />
          </>
        ) : null}
        {type === 'vehicle' ? (
          <>
            <path d="M4.5 13.7h5.25l2.3-4.5h3.5l3.95 4.5h-3.75" />
            <path d="M8.15 13.7l2.65 3.05h3.6" />
            <circle cx="6.75" cy="16.75" r="1.85" />
            <circle cx="17.3" cy="16.75" r="1.85" />
            <path d="M13.15 9.2l1.75 4.5" />
          </>
        ) : null}
      </svg>
    </span>
  )
}

function formatRecordDate(value: string) {
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

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60

  if (hours === 0) {
    return `${restMinutes} 分鐘`
  }

  if (restMinutes === 0) {
    return `${hours} 小時`
  }

  return `${hours} 小時 ${restMinutes} 分鐘`
}
