import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTripPlanDetailsResponse } from '../../src/services/ai/tripPlanPrompt.ts'

const skeletonPlan = {
  id: 'safe',
  type: 'safe',
  title: '原始方案',
  subtitle: '保留骨架',
  summary: '主行程已在生成階段驗證',
  totalTime: 120,
  budget: 300,
  transportMode: 'scooter',
  stops: [
    {
      id: 'stop-1',
      name: '原始景點',
      type: 'main_activity',
      description: '',
      address: '原始地址',
      duration: 60,
      placeId: 'place-1',
      lat: 22.1,
      lng: 120.1,
    },
    {
      id: 'stop-2',
      name: '原始餐廳',
      type: 'food',
      description: '',
      address: '原始餐廳地址',
      duration: 45,
      placeId: 'place-2',
      lat: 22.2,
      lng: 120.2,
    },
  ],
  transportSegments: [
    {
      fromStopId: 'stop-1',
      toStopId: 'stop-2',
      mode: 'scooter',
      duration: 15,
      label: '原始交通',
    },
  ],
  rainBackup: [],
  rainTransportSegments: [],
}

test('詳情 parser 只套用增量描述，不覆蓋已驗證主方案資料', () => {
  const detailText = JSON.stringify({
    plan: {
      stops: [
        { id: 'stop-1', description: '補上景點描述' },
        { id: 'stop-2', description: '補上餐廳描述' },
      ],
      transportSegments: [
        { fromStopId: 'stop-1', toStopId: 'stop-2', label: '沿湖輕鬆騎' },
      ],
      rainBackup: [],
      rainTransportSegments: [],
    },
  })

  const plan = parseTripPlanDetailsResponse(detailText, skeletonPlan)

  assert.equal(plan.id, 'safe')
  assert.equal(plan.title, '原始方案')
  assert.equal(plan.stops[0].name, '原始景點')
  assert.equal(plan.stops[0].placeId, 'place-1')
  assert.equal(plan.stops[0].description, '補上景點描述')
  assert.equal(plan.transportSegments[0].duration, 15)
  assert.equal(plan.transportSegments[0].label, '沿湖輕鬆騎')
  assert.equal(plan.isDetailComplete, true)
})
