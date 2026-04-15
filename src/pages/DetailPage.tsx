import { Link, useParams } from 'react-router-dom'
import { loadGeneratedPlans } from '../utils/tripPlanStorage'

export function DetailPage() {
  const { planId } = useParams()
  const plans = loadGeneratedPlans()
  const selectedPlan = plans.find((plan) => plan.id === planId)

  return (
    <section className="page">
      <Link className="back-link" to="/results">
        重新選擇
      </Link>

      <p className="page-kicker">Phase 4 會完成詳情與雨天切換</p>
      <h1 className="page-title">{selectedPlan?.title ?? '行程時間軸與交通細節。'}</h1>
      {selectedPlan ? <p className="page-copy">{selectedPlan.subtitle}</p> : null}
      <p className="page-copy">
        {selectedPlan?.summary ??
          '目前沒有找到已選方案，請回到三種方案頁重新選擇。'}
      </p>
    </section>
  )
}
