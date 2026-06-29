import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatRainBackupRecommendations,
  getRainBackupCandidatePool,
  isIndoorCandidate,
} from '../../api/_lib/google-places.ts'
import {
  getRainBackupQualityIssues,
  getRainBackupValidationInput,
  repairRainBackupStops,
  shouldRequestRainBackup,
} from '../../api/generate-trip-details.ts'

test('戶外與不確定分類不會進雨備池', () => {
  for (const types of [
    ['park'],
    ['tourist_attraction'],
    ['natural_feature'],
    ['outdoor'],
    ['hiking_area'],
    [],
  ]) {
    assert.equal(isIndoorCandidate(candidate(types.join('-') || 'unknown', types)), false)
  }

  const outdoor = candidate('outdoor', ['park'])
  const pool = getRainBackupCandidatePool(candidateCollection([outdoor]))
  assert.deepEqual(pool.allCandidates, [])
})

test('explicit outdoor 與 park 即使混有 indoor type 仍排除，tourist_attraction + museum 保留', () => {
  assert.equal(isIndoorCandidate(candidate('outdoor-museum', ['outdoor', 'museum'])), false)
  assert.equal(isIndoorCandidate(candidate('park-museum', ['park', 'museum'])), false)
  assert.equal(
    isIndoorCandidate(candidate('tourist-museum', ['tourist_attraction', 'museum'])),
    true,
  )
})

test('museum、mall、bookstore、cafe 可進雨備池，未知營業時間不可進', () => {
  const indoorCandidates = [
    candidate('museum', ['museum', 'tourist_attraction']),
    candidate('mall', ['shopping_mall'], 'shopping'),
    candidate('bookstore', ['book_store']),
    candidate('cafe', ['cafe'], 'food'),
  ]

  indoorCandidates.forEach((item) => assert.equal(isIndoorCandidate(item), true))

  const unknownHours = candidate('unknown-hours', ['museum'])
  delete unknownHours.openingHours
  const pool = getRainBackupCandidatePool(
    candidateCollection([...indoorCandidates, unknownHours]),
  )

  assert.deepEqual(
    pool.allCandidates.map((item) => item.placeId),
    ['museum', 'mall', 'bookstore', 'cafe'],
  )

  const promptCandidates = formatRainBackupRecommendations(
    candidateCollection([...indoorCandidates, candidate('park', ['park'])]),
  )
  assert.match(promptCandidates, /indoor=true, rainySuitable=true/)
  assert.match(promptCandidates, /types="museum,tourist_attraction"/)
  assert.doesNotMatch(promptCandidates, /name="park"/)
})

test('03:00→12:00 雨備從主方案 scheduleStartTime 06:00 驗證並使用相同 coverage basis', () => {
  const tripInput = input('03:00', '12:00')
  const plan = tripPlan([
    stop('one', 135),
    stop('two', 135),
  ], '06:00')

  assert.equal(getRainBackupValidationInput(plan, tripInput).startTime, '06:00')
  assert.equal(getRainBackupValidationInput({ ...plan, scheduleStartTime: undefined }, tripInput).startTime, '06:00')
  assert.deepEqual(getRainBackupQualityIssues(plan, tripInput), [])
})

test('Places 刪掉一站後可用未使用的 indoor candidate 補足至少兩站', () => {
  const remaining = stop('museum', 80)
  const repaired = repairRainBackupStops(
    [remaining],
    [
      candidate('museum', ['museum']),
      candidate('bookstore', ['book_store']),
      candidate('park', ['park']),
    ],
    input('09:00', '13:00'),
    'safe',
  )

  assert.equal(repaired.length >= 2, true)
  assert.equal(repaired.some((item) => item.placeId === 'bookstore'), true)
  assert.equal(repaired.some((item) => item.placeId === 'park'), false)
})

test('重複 placeId 去除後仍會嘗試補足', () => {
  const repaired = repairRainBackupStops(
    [stop('museum', 60, 'rain-1'), stop('museum', 60, 'rain-2')],
    [candidate('museum', ['museum']), candidate('mall', ['shopping_mall'], 'shopping')],
    input('09:00', '13:00'),
    'balanced',
  )

  assert.equal(repaired.length >= 2, true)
  assert.equal(repaired.filter((item) => item.placeId === 'museum').length, 1)
  assert.equal(repaired.some((item) => item.placeId === 'mall'), true)
})

test('雨備有兩個餐飲站時以可用非餐飲 indoor candidate 替換', () => {
  const repaired = repairRainBackupStops(
    [
      { ...stop('cafe', 80), type: 'food' },
      { ...stop('restaurant', 80), type: 'food' },
    ],
    [
      candidate('cafe', ['cafe'], 'food'),
      candidate('restaurant', ['restaurant', 'meal_takeaway'], 'food'),
      candidate('museum', ['museum']),
    ],
    input('09:00', '13:00'),
    'safe',
  )

  assert.equal(repaired.length, 2)
  assert.equal(repaired.filter((item) => item.type === 'food').length, 1)
  assert.equal(repaired.some((item) => item.placeId === 'museum'), true)
})

test('補站仍保留 30 分鐘 closing buffer', () => {
  const closesWithoutBuffer = candidate('closes-too-soon', ['museum'])
  closesWithoutBuffer.openingHours = knownHours([[9 * 60, 11 * 60 + 39]])

  const repaired = repairRainBackupStops(
    [stop('existing', 60)],
    [closesWithoutBuffer],
    input('09:00', '13:00'),
    'safe',
  )

  assert.deepEqual(repaired, [])
})

test('超過八小時仍不產生雨備，early-morning waiting period 不計入門檻', () => {
  assert.equal(shouldRequestRainBackup(input('07:00', '16:00')), false)
  assert.equal(shouldRequestRainBackup(input('03:00', '12:00')), true)
})

test('雨備不足時會先補救，沒有合格 indoor candidate 才回空', () => {
  const repaired = repairRainBackupStops(
    [stop('only', 60)],
    [candidate('park', ['park']), candidateWithoutKnownHours('museum', ['museum'])],
    input('09:00', '13:00'),
    'explore',
  )

  assert.deepEqual(repaired, [])
})

test('雨備品質仍限制為 2～4 站', () => {
  const oneStopIssues = getRainBackupQualityIssues(
    tripPlan([stop('one', 180)], '09:00'),
    input('09:00', '13:00'),
  )
  const fiveStopIssues = getRainBackupQualityIssues(
    tripPlan(
      ['one', 'two', 'three', 'four', 'five'].map((placeId) => stop(placeId, 45)),
      '09:00',
    ),
    input('09:00', '13:00'),
  )

  assert.equal(oneStopIssues.includes('雨天備案站點數不足'), true)
  assert.equal(fiveStopIssues.includes('雨天備案站點數超過四站'), true)
})

function input(startTime, endTime) {
  return {
    startTime,
    endTime,
    tags: [],
    category: 'explore',
    location: { name: '高雄', lat: 22.63, lng: 120.3 },
  }
}

function tripPlan(rainBackup, scheduleStartTime) {
  return {
    id: 'safe',
    type: 'safe',
    title: '雨備測試',
    subtitle: '',
    summary: '',
    totalTime: 0,
    budget: 0,
    transportMode: 'scooter',
    stops: [],
    transportSegments: [],
    rainBackup,
    rainTransportSegments: [],
    scheduleStartTime,
  }
}

function stop(placeId, duration, id = `rain-${placeId}`) {
  return {
    id,
    name: placeId,
    type: 'main_activity',
    description: '雨天備案測試地點與停留說明。',
    address: `${placeId} address`,
    duration,
    placeId,
    googleMapsUrl: `https://example.com/${placeId}`,
  }
}

function candidate(placeId, types, role = 'main_activity') {
  return {
    name: placeId,
    address: `${placeId} address`,
    placeId,
    googleMapsUrl: `https://example.com/${placeId}`,
    types,
    role,
    openingHours: knownHours([[0, 24 * 60]]),
  }
}

function candidateWithoutKnownHours(placeId, types) {
  const item = candidate(placeId, types)
  delete item.openingHours
  return item
}

function candidateCollection(items) {
  return {
    firstStopCandidates: items,
    otherCandidates: items,
    allCandidates: items,
  }
}

function knownHours(ranges) {
  return {
    windows: ranges.map(([start, end]) => ({
      openAt: dateAtTripMinute(start),
      closeAt: dateAtTripMinute(end),
    })),
    source: 'regular',
    utcOffsetMinutes: 0,
    isKnown: true,
    isNeverOpen: false,
  }
}

function dateAtTripMinute(totalMinutes) {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(midnight + totalMinutes * 60 * 1000)
}
