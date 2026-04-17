import { Link } from 'react-router-dom'
import { useAnalysisSession } from '../contexts/analysisSession'
import type { PlanType, TransportMode, TripPlan } from '../types/trip'
import { loadGeneratedPlans } from '../utils/tripPlanStorage'
import { getPlanActualDuration } from '../utils/tripTiming'

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

export function ResultsPage() {
  const { resetAnalysisFlow, setFlowRoute } = useAnalysisSession()
  const plans = loadGeneratedPlans()

  if (plans.length === 0) {
    return (
      <section className="page">
        <p className="page-kicker">尚未產生方案</p>
        <h1 className="page-title">先告訴我你想怎麼出發。</h1>
        <p className="page-copy">
          三種方案會在你送出行程偏好後出現，不會直接從選單進入。
        </p>
        <Link className="submit-button result-link" to="/">
          回到行程規劃
        </Link>
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
      <div className="result-grid">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            onSelect={setFlowRoute}
          />
        ))}
      </div>
    </section>
  )
}

function PlanCard({
  plan,
  onSelect,
}: {
  plan: TripPlan
  onSelect: (route: string) => void
}) {
  const previewStops = plan.stops.slice(0, 3)
  const actualDuration = getPlanActualDuration(plan)

  return (
    <article className="plan-card">
      <div>
        <p className="plan-type">{planLabels[plan.type]}</p>
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
          <dd>約 NT$ {plan.budget.toLocaleString('zh-TW')}</dd>
        </div>
        <div>
          <dt>交通</dt>
          <dd>{transportLabels[plan.transportMode]}</dd>
        </div>
        <div>
          <dt>停留點</dt>
          <dd>{plan.stops.length} 個</dd>
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
