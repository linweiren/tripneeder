import { useNavigate } from 'react-router-dom'
import type { PlanType, TransportMode } from '../types/trip'
import {
  savePlanForDetail,
  type StoredTripRecord,
} from '../utils/tripPlanStorage'

const planLabels: Record<PlanType, string> = {
  safe: '保守型',
  balanced: '平衡型',
  explore: '探索型',
}

const transportLabels: Record<TransportMode, string> = {
  scooter: '機車',
  car: '開車',
  public_transit: '大眾運輸',
}

type TripRecordListProps = {
  records: StoredTripRecord[]
  emptyTitle: string
  emptyCopy: string
  source: 'favorites' | 'recent'
  onRemove?: (recordId: string) => void
}

export function TripRecordList({
  records,
  emptyTitle,
  emptyCopy,
  source,
  onRemove,
}: TripRecordListProps) {
  const navigate = useNavigate()

  function openRecord(record: StoredTripRecord) {
    savePlanForDetail(record.plan, record.input)
    navigate(`/plans/${record.plan.id}`, { state: { from: source } })
  }

  if (records.length === 0) {
    return (
      <div className="empty-record-panel">
        <h2>{emptyTitle}</h2>
        <p>{emptyCopy}</p>
      </div>
    )
  }

  return (
    <div className="stored-trip-list">
      {records.map((record) => (
        <article
          className="stored-trip-card"
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
          {onRemove ? (
            <button
              className="remove-record-button"
              type="button"
              onClick={(event) => {
                event.stopPropagation()

                if (window.confirm('確定要永久移除這個收藏嗎？')) {
                  onRemove(record.id)
                }
              }}
            >
              移除收藏
            </button>
          ) : null}

          <div className="stored-trip-main">
            <p className="plan-type">{planLabels[record.plan.type]}</p>
            <h2>{record.plan.title}</h2>
            <p className="plan-subtitle">{record.plan.subtitle}</p>
            <p>{record.plan.summary}</p>
          </div>

          <dl className="stored-trip-metrics">
            <div>
              <dt>日期</dt>
              <dd>{formatRecordDate(record.createdAt)}</dd>
            </div>
            <div>
              <dt>總時間</dt>
              <dd>{formatMinutes(record.plan.totalTime)}</dd>
            </div>
            <div>
              <dt>預算</dt>
              <dd>約 NT$ {record.plan.budget.toLocaleString('zh-TW')}</dd>
            </div>
            <div>
              <dt>交通</dt>
              <dd>{transportLabels[record.plan.transportMode]}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
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
