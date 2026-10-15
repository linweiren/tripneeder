import test from 'node:test'
import assert from 'node:assert/strict'

import {
  comparePlansByDisplayPriority,
  getCoverageRepairTargetMinutes,
  getPlanDisplayPriority,
  getPlanDiversityOffset,
  pickRotatedItem,
} from '../../api/_lib/trip-repair-strategy.ts'

test('方案顯示順序固定為 safe / balanced / explore，未知方案排最後', () => {
  assert.equal(getPlanDisplayPriority('safe'), 0)
  assert.equal(getPlanDisplayPriority('balanced'), 1)
  assert.equal(getPlanDisplayPriority('explore'), 2)
  assert.equal(getPlanDisplayPriority('custom'), 3)

  const sorted = [
    plan('explore'),
    plan('custom'),
    plan('safe'),
    plan('balanced'),
  ].sort(comparePlansByDisplayPriority)

  assert.deepEqual(sorted.map((item) => item.id), ['safe', 'balanced', 'explore', 'custom'])
})

test('補站目標使用最低覆蓋率與目標覆蓋率，且不超出排程容量', () => {
  assert.equal(getCoverageRepairTargetMinutes(input('12:45', '14:45')), 108)
  assert.equal(getCoverageRepairTargetMinutes(input('12:45', '22:45')), 510)
  assert.equal(getCoverageRepairTargetMinutes(input('12:45', '09:45')), 1008)
})

test('跨方案候選輪替依方案順序與 salt 推進', () => {
  assert.equal(getPlanDiversityOffset('safe'), 0)
  assert.equal(getPlanDiversityOffset('balanced'), 3)
  assert.equal(getPlanDiversityOffset('explore', 2), 8)
})

test('輪替選項可處理空陣列、負值與小數 offset', () => {
  assert.equal(pickRotatedItem([], 1), null)
  assert.equal(pickRotatedItem(['a', 'b', 'c'], 4), 'b')
  assert.equal(pickRotatedItem(['a', 'b', 'c'], -1), 'c')
  assert.equal(pickRotatedItem(['a', 'b', 'c'], 1.9), 'b')
})

function input(startTime, endTime, tags = []) {
  return { startTime, endTime, tags }
}

function plan(id) {
  return {
    id,
    title: id,
    description: '',
    stops: [],
    transportSegments: [],
    totalTime: '0 分鐘',
    totalCost: '0 元',
    tips: [],
  }
}
