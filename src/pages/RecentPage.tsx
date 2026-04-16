import { TripRecordList } from '../components/TripRecordList'
import { loadRecentTripRecords } from '../utils/tripPlanStorage'

export function RecentPage() {
  const records = loadRecentTripRecords()

  return (
    <section className="page">
      <p className="page-kicker">最近生成</p>
      <h1 className="page-title">最近生成。</h1>
      <TripRecordList
        records={records}
        emptyTitle="還沒有最近生成"
        emptyCopy="送出行程偏好並成功產生三方案後，最近生成會保存在這裡。"
        source="recent"
      />
    </section>
  )
}
