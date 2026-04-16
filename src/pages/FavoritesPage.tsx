import { useState } from 'react'
import { TripRecordList } from '../components/TripRecordList'
import {
  loadFavoriteTripRecords,
  removeFavoriteTrip,
} from '../utils/tripPlanStorage'

export function FavoritesPage() {
  const [records, setRecords] = useState(() => loadFavoriteTripRecords())

  function handleRemove(recordId: string) {
    removeFavoriteTrip(recordId)
    setRecords(loadFavoriteTripRecords())
  }

  return (
    <section className="page">
      <p className="page-kicker">已收藏行程</p>
      <h1 className="page-title">收藏。</h1>
      <TripRecordList
        records={records}
        emptyTitle="還沒有收藏任何方案"
        emptyCopy="在詳情頁底部按下收藏後，行程會出現在這裡。"
        source="favorites"
        onRemove={handleRemove}
      />
    </section>
  )
}
