import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getMinimumMeaningfulStopDuration,
  getPlanRhythmIssues,
  getRequiredMealCoverageIssues,
  hasConsecutiveSimilarStops,
  hasTooManySimilarStops,
  inferStopRhythmRole,
} from '../../api/_lib/trip-quality-rules.ts'

test('硬性最低停留時間維持餐飲 45 分鐘、非餐飲 40 分鐘', () => {
  assert.equal(getMinimumMeaningfulStopDuration(stop('food', 'food', 30)), 45)
  assert.equal(getMinimumMeaningfulStopDuration(stop('park', 'main_activity', 30)), 40)
})

test('節奏問題包含短站與軟性診斷，但不直接決定硬擋', () => {
  const plan = {
    stops: [
      stop('湖邊公園', 'main_activity', 40),
      stop('森林步道', 'main_activity', 44),
      stop('河濱草地', 'main_activity', 40),
    ],
    transportSegments: [{ duration: 45 }, { duration: 45 }],
  }

  assert.deepEqual(getPlanRhythmIssues(plan, input('12:00', '18:00')), [
    '森林步道 作為中段主景點停留過短',
    '同一方案中開放空間/公園類景點過多，節奏過於單一',
    '連續安排過多公園或戶外開放空間',
    '交通時間占比過高，路線不夠緊湊',
  ])
})

test('連續與總量相似景點偵測維持 open_space 分類', () => {
  const stops = [
    stop('澄清湖風景區', 'main_activity', 60),
    stop('澄清湖九曲橋', 'main_activity', 60),
    stop('鳥松濕地公園', 'main_activity', 60),
  ]

  assert.equal(inferStopRhythmRole(stops[0]), 'open_space')
  assert.equal(hasTooManySimilarStops(stops, 'open_space'), true)
  assert.equal(hasConsecutiveSimilarStops(stops, 'open_space', 3), true)
})

test('雙餐期行程需要午餐與晚餐各至少一個對齊餐飲停留', () => {
  const missingDinner = {
    stops: [
      stop('展覽館', 'main_activity', 75),
      stop('午餐餐廳', 'food', 60),
      stop('美術館', 'main_activity', 120),
      stop('夜景平台', 'main_activity', 90),
    ],
    transportSegments: [{ duration: 15 }, { duration: 15 }, { duration: 15 }],
  }
  const complete = {
    stops: [
      stop('展覽館', 'main_activity', 75),
      stop('午餐餐廳', 'food', 60),
      stop('美術館', 'main_activity', 180),
      stop('晚餐餐廳', 'food', 60),
    ],
    transportSegments: [{ duration: 15 }, { duration: 15 }, { duration: 15 }],
  }

  assert.deepEqual(getRequiredMealCoverageIssues(missingDinner, input('10:30', '22:30')), [
    '行程涵蓋午餐與晚餐，至少需要 2 個餐飲停留（目前 1 個）',
  ])
  assert.deepEqual(getRequiredMealCoverageIssues(complete, input('10:30', '22:30')), [])
})

function input(startTime, endTime, tags = []) {
  return { startTime, endTime, tags }
}

function stop(id, type, duration) {
  return {
    id,
    name: id,
    type,
    description: '',
    address: '',
    duration,
  }
}
