import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLAN_IDS,
  formatMinutesAsTime,
  getAllowedTripMinutes,
  getCoverageBasisMinutes,
  getMealInsertionTargetMinutes,
  getMinimumRequiredActualMinutes,
  getOpeningHoursSearchStartMinutes,
  getRequiredMealWindows,
  getTargetCoverageRatio,
  getTripWindowOverlapMinutes,
  getVisitMealWindowOverlapMinutes,
  isStopAlignedWithMealWindow,
  parseTimeToMinutes,
} from '../../api/_lib/trip-planning-rules.ts'

test('固定方案 ID 維持 safe / balanced / explore', () => {
  assert.deepEqual(PLAN_IDS, ['safe', 'balanced', 'explore'])
})

test('時間格式可解析、可跨日、可包回 24 小時', () => {
  assert.equal(parseTimeToMinutes('23:45'), 1425)
  assert.equal(parseTimeToMinutes('24:00'), null)
  assert.equal(parseTimeToMinutes('12:60'), null)
  assert.equal(formatMinutesAsTime(24 * 60 + 15), '00:15')
  assert.equal(formatMinutesAsTime(-15), '23:45')
  assert.equal(getAllowedTripMinutes(input('12:45', '09:45')), 21 * 60)
})

test('凌晨長時間窗只把 06:00 後計入有效覆蓋基礎', () => {
  assert.equal(getCoverageBasisMinutes(input('04:45', '23:45')), 17 * 60 + 45)
  assert.equal(getOpeningHoursSearchStartMinutes(4 * 60 + 45, 23 * 60 + 45), 6 * 60)
})

test('凌晨短時間窗不被硬平移到 06:00', () => {
  assert.equal(getCoverageBasisMinutes(input('03:00', '06:00')), 3 * 60)
  assert.equal(getOpeningHoursSearchStartMinutes(3 * 60, 6 * 60), 3 * 60)
})

test('覆蓋率門檻與補長目標維持現行策略', () => {
  assert.equal(getMinimumRequiredActualMinutes(input('12:45', '14:45')), 84)
  assert.equal(getMinimumRequiredActualMinutes(input('12:45', '22:45')), 480)
  assert.equal(getMinimumRequiredActualMinutes(input('12:45', '09:45')), 882)
  assert.equal(getTargetCoverageRatio(2 * 60), 0.9)
  assert.equal(getTargetCoverageRatio(10 * 60), 0.85)
  assert.equal(getTargetCoverageRatio(21 * 60), 0.8)
})

test('餐期需求只要與使用者時間窗有重疊就啟用', () => {
  assert.deepEqual(
    getRequiredMealWindows(input('12:45', '14:45')).map((meal) => meal.id),
    ['lunch'],
  )
  assert.deepEqual(
    getRequiredMealWindows(input('10:30', '12:00')).map((meal) => meal.id),
    ['lunch'],
  )
  assert.deepEqual(
    getRequiredMealWindows(input('12:00', '22:45')).map((meal) => meal.id),
    ['lunch', 'dinner'],
  )
  assert.deepEqual(
    getRequiredMealWindows(input('12:45', '09:45')).map((meal) => meal.id),
    ['lunch', 'dinner'],
  )
  assert.deepEqual(
    getRequiredMealWindows(input('13:00', '15:00')).map((meal) => meal.id),
    [],
  )
})

test('餐飲只要與餐期有重疊即對齊', () => {
  const dinner = getRequiredMealWindows(input('12:00', '22:45')).find(
    (meal) => meal.id === 'dinner',
  )
  assert.ok(dinner)
  assert.equal(getMealInsertionTargetMinutes(dinner), 18 * 60)
  assert.equal(getVisitMealWindowOverlapMinutes(16 * 60 + 46, 60, dinner), 46)
  assert.equal(isStopAlignedWithMealWindow(16 * 60 + 46, 60, dinner), true)
  assert.equal(isStopAlignedWithMealWindow(15 * 60, 60, dinner), false)
  assert.equal(isStopAlignedWithMealWindow(16 * 60 + 59, 1, dinner), false)
  assert.equal(isStopAlignedWithMealWindow(18 * 60 + 59, 1, dinner), true)
})

test('跨日餐期重疊以最大重疊量判斷', () => {
  assert.equal(getTripWindowOverlapMinutes(input('23:00', '01:00'), 23 * 60 + 30, 24 * 60), 30)
  assert.equal(getTripWindowOverlapMinutes(input('23:00', '01:00'), 0, 30), 30)
})

test('cross-day required meal windows keep their real timeline occurrence', () => {
  const meals = getRequiredMealWindows(input('14:30', '11:30'))

  assert.deepEqual(
    meals.map((meal) => meal.id),
    ['dinner', 'lunch'],
  )
  assert.equal(meals[0].start, 17 * 60)
  assert.equal(meals[1].start, 24 * 60 + 11 * 60)
  assert.equal(getMealInsertionTargetMinutes(meals[1]), 24 * 60 + 12 * 60)
  assert.equal(
    getVisitMealWindowOverlapMinutes(24 * 60 + 10 * 60 + 45, 45, meals[1]),
    30,
  )
  assert.equal(isStopAlignedWithMealWindow(24 * 60 + 10 * 60 + 45, 45, meals[1]), true)
})

function input(startTime, endTime, tags = []) {
  return { startTime, endTime, tags }
}
