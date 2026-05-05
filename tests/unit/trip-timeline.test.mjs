import test from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateOffsetBeforeInsertion,
  estimateOffsetBeforeStop,
  findMealWindowInsertionIndex,
  getEstimatedArrivalMinutesForStop,
  getEstimatedPlanArrivalMinutes,
  getRequiredAvailabilitySlotForStop,
} from '../../api/_lib/trip-timeline.ts'

test('站點抵達時間使用有效行程起點與交通段逐站推算', () => {
  const stops = [
    stop('lake', 'main_activity', 75),
    stop('lunch', 'food', 60),
    stop('museum', 'main_activity', 90),
  ]
  const transportSegments = [{ duration: 12 }, { duration: 18 }]

  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 0, input('12:45', '15:45'), transportSegments),
    12 * 60 + 45,
  )
  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 1, input('12:45', '15:45'), transportSegments),
    14 * 60 + 12,
  )
  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 2, input('12:45', '15:45'), transportSegments),
    15 * 60 + 30,
  )
})

test('凌晨長時段的時間軸從 06:00 起算，不把 03:00 直接塞入日間景點', () => {
  const stops = [
    stop('bridge', 'main_activity', 60),
    stop('garden', 'main_activity', 60),
  ]

  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 0, input('03:00', '13:00')),
    6 * 60,
  )
  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 1, input('03:00', '13:00')),
    7 * 60 + 18,
  )
})

test('短凌晨窗維持使用者原始起點，不硬切到 06:00', () => {
  const stops = [stop('late', 'main_activity', 60)]

  assert.equal(
    getEstimatedArrivalMinutesForStop(stops, 0, input('03:00', '06:00')),
    3 * 60,
  )
})

test('餐期插入位置選擇最接近餐期起點的站間位置', () => {
  const stops = [
    stop('a', 'main_activity', 75),
    stop('b', 'main_activity', 75),
    stop('c', 'main_activity', 75),
  ]

  assert.equal(estimateOffsetBeforeInsertion(stops, 0), 0)
  assert.equal(estimateOffsetBeforeInsertion(stops, 1), 93)
  assert.equal(estimateOffsetBeforeInsertion(stops, 2), 186)
  assert.equal(findMealWindowInsertionIndex(stops, input('10:30', '18:30'), 12 * 60), 1)
  assert.equal(findMealWindowInsertionIndex(stops, input('12:45', '09:45'), 11 * 60), 0)
})

test('可用性 slot 依行程容量切成 early / middle / late', () => {
  const stops = [
    stop('a', 'main_activity', 75),
    stop('b', 'main_activity', 75),
    stop('c', 'main_activity', 75),
  ]

  assert.equal(getRequiredAvailabilitySlotForStop(stops, 0, input('12:00', '18:00')), 'early')
  assert.equal(getRequiredAvailabilitySlotForStop(stops, 1, input('12:00', '18:00')), 'early')
  assert.equal(getRequiredAvailabilitySlotForStop(stops, 2, input('12:00', '18:00')), 'middle')
})

test('整案抵達時間與逐站 offset 保持一致', () => {
  const plan = {
    stops: [
      stop('a', 'main_activity', 75),
      stop('b', 'food', 60),
      stop('c', 'main_activity', 75),
    ],
    transportSegments: [{ duration: 10 }, { duration: 20 }],
  }

  assert.deepEqual(getEstimatedPlanArrivalMinutes(plan, input('12:45', '18:45')), [
    12 * 60 + 45,
    14 * 60 + 10,
    15 * 60 + 30,
  ])
  assert.equal(estimateOffsetBeforeStop(plan.stops, 2, plan.transportSegments), 165)
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
