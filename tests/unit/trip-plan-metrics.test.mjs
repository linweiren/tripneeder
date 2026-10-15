import test from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateTransportTotal,
  getDefaultStopDuration,
  getMaximumStopDuration,
  getMinimumStopCountForLongTrip,
  getMinimumStopDuration,
  getPlanActualDuration,
  getReasonableStopDuration,
  getStopStretchWeight,
} from '../../api/_lib/trip-plan-metrics.ts'

test('方案實際時長等於停留加交通', () => {
  const plan = {
    stops: [
      stop('a', 'main_activity', 75),
      stop('b', 'food', 60),
      stop('c', 'ending_or_transition', 45),
    ],
    transportSegments: [{ duration: 10 }, { duration: 12 }],
  }

  assert.equal(getPlanActualDuration(plan), 202)
})

test('預估交通以每段 18 分鐘計算', () => {
  assert.equal(estimateTransportTotal([]), 0)
  assert.equal(estimateTransportTotal([stop('a', 'main_activity', 75)]), 0)
  assert.equal(
    estimateTransportTotal([
      stop('a', 'main_activity', 75),
      stop('b', 'food', 60),
      stop('c', 'main_activity', 75),
    ]),
    36,
  )
})

test('長時段最低站數依有效時長分級', () => {
  assert.equal(getMinimumStopCountForLongTrip(input('12:45', '14:45')), 2)
  assert.equal(getMinimumStopCountForLongTrip(input('12:45', '18:45')), 3)
  assert.equal(getMinimumStopCountForLongTrip(input('12:45', '22:45')), 4)
  assert.equal(getMinimumStopCountForLongTrip(input('12:45', '03:45')), 5)
  assert.equal(getMinimumStopCountForLongTrip(input('12:45', '09:45')), 6)
})

test('基本停留時間規則維持現行硬門檻', () => {
  assert.equal(getDefaultStopDuration('main_activity'), 75)
  assert.equal(getDefaultStopDuration('food'), 60)
  assert.equal(getDefaultStopDuration('ending_or_transition'), 45)
  assert.equal(getMinimumStopDuration(stop('food', 'food', 20)), 45)
  assert.equal(getMinimumStopDuration(stop('park', 'main_activity', 20)), 40)
})

test('可拉長停留時間依景點類型分類', () => {
  assert.equal(getMaximumStopDuration(stop('restaurant', 'food', 60)), 90)
  assert.equal(getMaximumStopDuration(stop('office', 'main_activity', 60, '鳥松區公所')), 45)
  assert.equal(getMaximumStopDuration(stop('museum', 'main_activity', 60, '高雄市立美術館')), 150)
  assert.equal(getMaximumStopDuration(stop('park', 'main_activity', 60, '澄清湖風景區')), 120)
  assert.equal(getMaximumStopDuration(stop('cafe', 'ending_or_transition', 45, '咖啡弄')), 100)
  assert.equal(getReasonableStopDuration(stop('office', 'main_activity', 20, '鳥松區公所')), 45)
  assert.equal(getStopStretchWeight(stop('museum', 'main_activity', 60, '高雄市立美術館')), 4)
  assert.equal(getStopStretchWeight(stop('office', 'main_activity', 60, '鳥松區公所')), 0)
})

function input(startTime, endTime, tags = []) {
  return { startTime, endTime, tags }
}

function stop(id, type, duration, name = id) {
  return {
    id,
    name,
    type,
    description: '',
    address: '',
    duration,
  }
}
