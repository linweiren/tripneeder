import { Link } from 'react-router-dom'
import type { PlanType, TransportMode, TripPlan } from '../types/trip'
import { loadGeneratedPlans } from '../utils/tripPlanStorage'

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
      <p className="page-kicker">AI 已整理三種走法</p>
      <h1 className="page-title">三種風格，一眼比較。</h1>
      <div className="result-grid">
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>
    </section>
  )
}

function PlanCard({ plan }: { plan: TripPlan }) {
  const previewStops = plan.stops.slice(0, 3)

  return (
    <article className="plan-card">
      <div>
        <p className="plan-type">{planLabels[plan.type]}</p>
        <h2>{plan.title}</h2>
        <p className="plan-subtitle">{plan.subtitle}</p>
        <p>{plan.summary}</p>
      </div>

      <dl className="plan-metrics">
        <div>
          <dt>總時間</dt>
          <dd>{formatMinutes(plan.totalTime)}</dd>
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
        <strong>前幾站</strong>
        <ol>
          {previewStops.map((stop) => (
            <li key={`${plan.id}-${stop.id || stop.name}`}>{stop.name}</li>
          ))}
        </ol>
      </div>

      <Link className="secondary-button result-link" to={`/plans/${plan.id}`}>
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
