import { Link } from 'react-router-dom'
import { Car, Clock, MapPin, Wallet } from 'lucide-react'
import { useAnalysisSession } from '../contexts/analysisSession'
import type { TransportMode, TripPlan } from '../types/trip'
import { loadGeneratedPlans } from '../utils/tripPlanStorage'
import { getPlanActualDuration } from '../utils/tripTiming'
import mascotComplete from '../assets/mascot/mascot-complete.png'
import mascotError from '../assets/mascot/mascot-error.png'

const transportLabels: Record<TransportMode, string> = {
  scooter: '機車',
  car: '開車',
  public_transit: '大眾運輸',
}

export function ResultsPage() {
  const { session, resetAnalysisFlow, setFlowRoute, requestPlanDetails } =
    useAnalysisSession()
  const plans = loadGeneratedPlans()
  const warnings = session?.status === 'success' ? (session.warnings ?? []) : []

  if (plans.length === 0) {
    return (
      <section className="page results-page">
        <div className="empty-record-panel error-state-panel">
          <img
            className="empty-record-mascot error-mascot"
            src={mascotError}
            alt="分析失敗吉祥物"
          />
          <h2 style={{ whiteSpace: 'nowrap' }}>這次沒有找到可用方案</h2>
          <p style={{ whiteSpace: 'nowrap' }}>沒有符合營業時間與條件的行程</p>
          <button 
            className="secondary-button" 
            style={{ marginTop: '12px' }}
            type="button" 
            onClick={resetAnalysisFlow}
          >
            回到行程規劃
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="page results-page">
      <img
        className="results-mascot-decoration"
        src={mascotComplete}
        alt=""
        aria-hidden="true"
      />
      <div className="results-hero">
        <button className="back-link" type="button" onClick={resetAnalysisFlow}>
          重新選擇偏好
        </button>
        <h1 className="results-title">3 種專屬方案已為你準備好</h1>
      </div>
      {warnings.length > 0 ? (
        <div className="plan-warning-panel" role="status">
          {warnings.map((warning: string) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
      <div className="result-grid">
        {plans.map((plan, index) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            label={`方案${toChineseNumber(index + 1)}`}
            onSelect={(route) => {
              setFlowRoute(route)
              requestPlanDetails(plan.id, { source: 'generated' })
            }}
          />
        ))}
      </div>
    </section>
  )
}

function PlanCard({
  plan,
  label,
  onSelect,
}: {
  plan: TripPlan
  label: string
  onSelect: (route: string) => void
}) {
  const stops = plan.stops ?? []
  const previewStops = stops.slice(0, 3)
  const actualDuration = getPlanActualDuration(plan)
  const metrics = [
    {
      icon: <Clock aria-hidden="true" />,
      label: '總時間',
      value: formatMinutes(actualDuration),
    },
    {
      icon: <Wallet aria-hidden="true" />,
      label: '預算',
      value: `約 NT$ ${(plan.budget ?? 0).toLocaleString('zh-TW')}`,
    },
    {
      icon: <Car aria-hidden="true" />,
      label: '交通',
      value: transportLabels[plan.transportMode] ?? '未指定',
    },
    {
      icon: <MapPin aria-hidden="true" />,
      label: '停留點',
      value: `${stops.length} 個`,
    },
  ]

  return (
    <article className="plan-card">
      <div className="plan-card-header">
        <p className="plan-type">{label}</p>
        <h2>{plan.title}</h2>
        <p className="plan-summary">{plan.summary}</p>
      </div>

      <dl className="plan-metrics">
        {metrics.map((metric) => (
          <div className="plan-metric-item" key={metric.label}>
            <span className="plan-metric-icon" aria-hidden="true">
              {metric.icon}
            </span>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>

      <div className="stop-preview">
        <strong>行程預覽</strong>
        <ol>
          {previewStops.map((stop, index) => (
            <li key={`${plan.id}-${stop.id || stop.name}`}>
              <span className="stop-preview-index">{index + 1}</span>
              <span>{stop.name}</span>
            </li>
          ))}
        </ol>
      </div>

      <Link
        className="result-link"
        to={`/plans/${plan.id}`}
        onClick={() => onSelect(`/plans/${plan.id}`)}
      >
        選擇此方案
      </Link>
    </article>
  )
}

function toChineseNumber(value: number) {
  return ['一', '二', '三'][value - 1] ?? String(value)
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
