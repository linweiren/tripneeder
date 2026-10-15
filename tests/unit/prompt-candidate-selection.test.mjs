import test from 'node:test'
import assert from 'node:assert/strict'

import { getPromptCandidateSelection } from '../../api/_lib/google-places.ts'
import { TripCandidateDebugSession } from '../../api/_lib/trip-candidate-debug.ts'

const knownOpeningHours = {
  windows: [],
  source: 'regular',
  isKnown: true,
  isNeverOpen: false,
}

let generatedCandidateId = 0

function makeCandidate(overrides = {}) {
  generatedCandidateId += 1
  const placeId = overrides.placeId ?? `place-${generatedCandidateId}`
  return {
    name: overrides.name ?? placeId,
    address: overrides.address ?? '高雄市測試路 1 號',
    placeId,
    googleMapsUrl: `https://example.com/${placeId}`,
    distanceKm: 1,
    rating: 4.5,
    reviewCount: 100,
    types: ['tourist_attraction'],
    role: 'main_activity',
    score: 80,
    openingHours: knownOpeningHours,
    availabilitySlots: ['early', 'middle'],
    ...overrides,
  }
}

function makeDiversePool() {
  const cafes = Array.from({ length: 12 }, (_, index) =>
    makeCandidate({
      placeId: `cafe-${index + 1}`,
      name: `高分咖啡 ${index + 1}`,
      types: ['cafe', 'restaurant'],
      role: 'food',
      foodSubtype: index % 2 === 0 ? 'cafe' : 'dessert',
      score: 120 - index,
    }),
  )
  const restaurants = Array.from({ length: 4 }, (_, index) =>
    makeCandidate({
      placeId: `restaurant-${index + 1}`,
      name: index === 3 ? '仁武市場在地食堂' : `在地餐廳 ${index + 1}`,
      types: ['restaurant', 'food'],
      role: 'food',
      foodSubtype: 'restaurant',
      score: 90 - index,
    }),
  )
  const genericActivities = Array.from({ length: 18 }, (_, index) =>
    makeCandidate({
      placeId: `attraction-${index + 1}`,
      name: `高分熱門景點 ${index + 1}`,
      score: 110 - index,
    }),
  )
  const bucketActivities = [
    makeCandidate({
      placeId: 'local-market',
      name: '仁武傳統市場',
      types: ['market'],
      role: 'shopping',
      score: 70,
    }),
    makeCandidate({
      placeId: 'local-old-street',
      name: '仁武眷村生活老街',
      types: ['tourist_attraction'],
      score: 69,
    }),
    makeCandidate({
      placeId: 'outdoor-park',
      name: '仁武河濱公園',
      types: ['park'],
      role: 'open_space',
      score: 68,
    }),
    makeCandidate({
      placeId: 'outdoor-scenic',
      name: '觀音湖風景區',
      types: ['scenic_spot'],
      role: 'open_space',
      score: 67,
    }),
    makeCandidate({
      placeId: 'shopping-mall',
      name: '仁武生活商場',
      types: ['shopping_mall'],
      role: 'shopping',
      score: 66,
    }),
    makeCandidate({
      placeId: 'culture-museum',
      name: '仁武地方文化館',
      types: ['museum'],
      score: 65,
    }),
    makeCandidate({
      placeId: 'culture-gallery',
      name: '仁武藝文展覽館',
      types: ['art_gallery'],
      score: 64,
    }),
  ]

  return [...cafes, ...restaurants, ...genericActivities, ...bucketActivities]
}

test('prompt shortlist 保留高分候選，同時保底 local、outdoor、shopping、culture 與 non-cafe food', () => {
  const otherCandidates = makeDiversePool()
  const selection = getPromptCandidateSelection({
    firstStopCandidates: [],
    otherCandidates,
    allCandidates: otherCandidates,
  })

  const foodCafeDessertCount = selection.foodStops.filter((candidate) =>
    ['cafe', 'dessert'].includes(candidate.foodSubtype),
  ).length
  const selectedIds = new Set(selection.promptCandidates.map((candidate) => candidate.placeId))

  assert.equal(foodCafeDessertCount, 7)
  assert.ok(selection.foodStops.some((candidate) => candidate.foodSubtype === 'restaurant'))
  assert.ok(selectedIds.has('cafe-1'), '原本最高分 cafe 應保留')
  assert.ok(selectedIds.has('attraction-1'), '原本最高分 activity 應保留')
  assert.ok(selectedIds.has('local-market'))
  assert.ok(
    selection.promptCandidates.filter((candidate) =>
      /(市場|老街|眷村|文化|生活)/.test(`${candidate.name} ${candidate.address}`),
    ).length >= 2,
    '合格 local 候選存在時，AI input 至少保留兩個 local 代表',
  )
  assert.ok(selectedIds.has('outdoor-park'))
  assert.ok(selectedIds.has('outdoor-scenic'))
  assert.ok(selectedIds.has('shopping-mall'))
  assert.ok(selectedIds.has('culture-museum'))
  assert.ok(selectedIds.has('culture-gallery'))
})

test('prompt shortlist 不加入未知或不可用候選，並跨 first-stop、food、activity 依 placeId 去重', () => {
  const sharedCafe = makeCandidate({
    placeId: 'shared-cafe',
    name: '第一站咖啡',
    types: ['cafe'],
    role: 'food',
    foodSubtype: 'cafe',
    score: 120,
  })
  const unknownHours = makeCandidate({
    placeId: 'unknown-hours-market',
    name: '未知營業時間市場',
    types: ['market'],
    role: 'shopping',
    score: 130,
    openingHours: { ...knownOpeningHours, isKnown: false },
  })
  const neverOpen = makeCandidate({
    placeId: 'never-open-museum',
    name: '未營業博物館',
    types: ['museum'],
    score: 129,
    openingHours: { ...knownOpeningHours, isNeverOpen: true },
  })
  const noAvailability = makeCandidate({
    placeId: 'no-availability-park',
    name: '無可用時段公園',
    types: ['park'],
    role: 'open_space',
    score: 128,
    availabilitySlots: [],
  })
  const validPark = makeCandidate({
    placeId: 'valid-park',
    name: '可用公園',
    types: ['park'],
    role: 'open_space',
    score: 80,
  })

  const selection = getPromptCandidateSelection({
    firstStopCandidates: [sharedCafe, sharedCafe],
    otherCandidates: [
      unknownHours,
      neverOpen,
      noAvailability,
      sharedCafe,
      { ...sharedCafe, name: '重複咖啡資料' },
      validPark,
    ],
    allCandidates: [unknownHours, neverOpen, noAvailability, sharedCafe, validPark],
  })
  const ids = selection.promptCandidates.map((candidate) => candidate.placeId)

  assert.equal(ids.filter((placeId) => placeId === sharedCafe.placeId).length, 1)
  assert.ok(ids.includes(validPark.placeId))
  assert.ok(!ids.includes(unknownHours.placeId))
  assert.ok(!ids.includes(neverOpen.placeId))
  assert.ok(!ids.includes(noAvailability.placeId))
  assert.equal(new Set(ids).size, ids.length)
})

test('candidate debug report 會標示分桶後更平均的 AI input', () => {
  const allCandidates = makeDiversePool()
  const selection = getPromptCandidateSelection({
    firstStopCandidates: [],
    otherCandidates: allCandidates,
    allCandidates,
  })
  const session = new TripCandidateDebugSession({
    category: 'explore',
    startTime: '13:00',
    endTime: '18:00',
    tags: [],
    location: { name: '仁武', lat: 22.7, lng: 120.35 },
  })

  session.recordCandidatePool({
    rawCandidateCount: allCandidates.length,
    usableCandidateCount: allCandidates.length,
    candidates: allCandidates.map((candidate) => ({
      name: candidate.name,
      placeId: candidate.placeId,
      types: candidate.types,
      role: candidate.role,
      score: candidate.score,
      distanceKm: candidate.distanceKm,
      rating: candidate.rating,
      reviewCount: candidate.reviewCount,
      openingHoursKnown: true,
      availabilitySlotCount: candidate.availabilitySlots.length,
      availabilitySlots: candidate.availabilitySlots,
      excluded: false,
      exclusionReason: null,
      firstStopRejectionReason: null,
    })),
  })
  session.recordCandidateSets({ firstStopCandidates: [], otherCandidates: allCandidates, allCandidates })
  session.recordAiInput(selection)

  const report = session.buildReport([])
  const sentToAi = report.candidatePool.candidates.filter((candidate) => candidate.sentToAi)
  const sentCafeCount = sentToAi.filter((candidate) => candidate.buckets.includes('cafe')).length

  assert.equal(report.aiInput.uniqueCandidateCount, selection.promptCandidates.length)
  assert.equal(sentCafeCount, 7)
  assert.ok(sentToAi.some((candidate) => candidate.buckets.includes('local_lifestyle')))
  assert.ok(sentToAi.some((candidate) => candidate.buckets.includes('outdoor')))
  assert.ok(sentToAi.some((candidate) => candidate.buckets.includes('shopping')))
  assert.ok(sentToAi.some((candidate) => candidate.types.includes('museum')))
})

test('candidate debug report includes first-stop rejection breakdown', () => {
  const session = new TripCandidateDebugSession({
    category: 'explore',
    startTime: '23:00',
    endTime: '01:00',
    tags: [],
    location: { name: '高雄市仁武區', lat: 22.69, lng: 120.33 },
  })

  session.recordCandidatePool({
    rawCandidateCount: 5,
    usableCandidateCount: 0,
    candidates: [
      debugCandidate('far', 'distance_over_2km'),
      debugCandidate('unknown', 'unknown_opening_hours'),
      debugCandidate('no-overlap', 'no_opening_overlap'),
      debugCandidate('buffer', 'closing_buffer'),
      debugCandidate('short', 'minimum_visit_duration'),
    ],
  })

  const report = session.buildReport([])

  assert.deepEqual(report.candidatePool.firstStopRejectionBreakdown, {
    distance_over_2km: 1,
    unknown_opening_hours: 1,
    no_opening_overlap: 1,
    closing_buffer: 1,
    minimum_visit_duration: 1,
  })
})

function debugCandidate(placeId, firstStopRejectionReason) {
  return {
    name: placeId,
    placeId,
    types: ['restaurant'],
    role: 'food',
    score: null,
    distanceKm: 1,
    rating: null,
    reviewCount: null,
    openingHoursKnown: firstStopRejectionReason !== 'unknown_opening_hours',
    availabilitySlotCount: 0,
    availabilitySlots: [],
    excluded: true,
    exclusionReason: firstStopRejectionReason,
    firstStopRejectionReason,
  }
}
