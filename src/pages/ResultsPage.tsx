import { Link } from 'react-router-dom'
import { useAnalysisSession } from '../contexts/analysisSession'
import type { TransportMode, TripPlan } from '../types/trip'
import { loadGeneratedPlans } from '../utils/tripPlanStorage'
import { getPlanActualDuration } from '../utils/tripTiming'

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
      <section className="page">
        <p className="page-kicker">尚未產生方案</p>
        <h1 className="page-title">這次沒有找到可用方案。</h1>
        <p className="page-copy">
          目前沒有符合營業時間與路線條件的行程，請調整時間或重新生成。
        </p>
        <button className="submit-button result-link" type="button" onClick={resetAnalysisFlow}>
          回到行程規劃
        </button>
      </section>
    )
  }

  return (
    <section className="page">
      <button className="back-link" type="button" onClick={resetAnalysisFlow}>
        重新選擇偏好
      </button>
      <p className="page-kicker">AI 已整理三種走法</p>
      <h1 className="page-title">選擇行程方案</h1>
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

  return (
    <article className="plan-card">
      <div>
        <p className="plan-type">{label}</p>
        <h2>{plan.title}</h2>
        <p>{plan.summary}</p>
      </div>

      <dl className="plan-metrics">
        <div>
          <dt>總時間</dt>
          <dd>{formatMinutes(actualDuration)}</dd>
        </div>
        <div>
          <dt>預算</dt>
          <dd>約 NT$ {(plan.budget ?? 0).toLocaleString('zh-TW')}</dd>
        </div>
        <div>
          <dt>交通</dt>
          <dd>{transportLabels[plan.transportMode] ?? '未指定'}</dd>
        </div>
        <div>
          <dt>停留點</dt>
          <dd>{stops.length} 個</dd>
        </div>
      </dl>

      <div className="stop-preview">
        <strong>行程</strong>
        <ol>
          {previewStops.map((stop) => (
            <li key={`${plan.id}-${stop.id || stop.name}`}>{stop.name}</li>
          ))}
        </ol>
      </div>

      <Link
        className="secondary-button result-link"
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
