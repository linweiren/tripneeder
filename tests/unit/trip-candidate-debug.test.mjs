import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TripCandidateDebugSession,
  createTripCandidateDebugSession,
  isTripCandidateDebugEnabled,
  writeTripCandidateDebugReport,
} from '../../api/_lib/trip-candidate-debug.ts'

const input = {
  category: 'explore',
  startTime: '10:00',
  endTime: '18:00',
  tags: [],
  location: { name: '仁武', lat: 22.7, lng: 120.35 },
}

const candidate = {
  name: '仁武測試公園',
  address: '高雄市仁武區測試路 1 號',
  placeId: 'place-park',
  googleMapsUrl: 'https://example.com/place-park',
  distanceKm: 1.2,
  rating: 4.6,
  reviewCount: 321,
  types: ['park', 'tourist_attraction'],
  role: 'open_space',
  score: 91.2,
  availabilitySlots: ['early', 'middle'],
  openingHours: {
    windows: [],
    source: 'regular',
    isKnown: true,
    isNeverOpen: false,
  },
}

const plan = {
  id: 'safe',
  type: 'safe',
  title: '仁武散步',
  subtitle: '測試候選行程',
  summary: '測試摘要',
  totalTime: 90,
  budget: 100,
  transportMode: 'scooter',
  stops: [
    {
      id: 'safe-1',
      name: candidate.name,
      type: 'main_activity',
      description: '',
      address: candidate.address,
      duration: 90,
      placeId: candidate.placeId,
    },
  ],
  transportSegments: [],
  rainBackup: [],
  rainTransportSegments: [],
}

test('debug flag 關閉或 production 時不產生 report，也不改 API response schema', () => {
  assert.equal(isTripCandidateDebugEnabled({ NODE_ENV: 'development' }), false)
  assert.equal(
    isTripCandidateDebugEnabled({ NODE_ENV: 'production', TRIP_CANDIDATE_DEBUG: 'true' }),
    false,
  )
  assert.equal(createTripCandidateDebugSession(input, { NODE_ENV: 'development' }), null)

  const response = { plans: [plan], warnings: [] }
  const before = structuredClone(response)
  let appendCount = 0
  const report = writeTripCandidateDebugReport(null, response.plans, new Map(), 'completed', {
    env: { NODE_ENV: 'development' },
    append: () => { appendCount += 1 },
  })

  assert.equal(report, null)
  assert.equal(appendCount, 0)
  assert.deepEqual(response, before)
  assert.deepEqual(Object.keys(response).sort(), ['plans', 'warnings'])
})

test('debug report 含 query、候選數、score、AI 選點與 final stops，且不改推薦結果', () => {
  const session = new TripCandidateDebugSession(input)
  session.recordQueryPlan({
    phase: 'initial',
    queries: ['仁武 attractions', '公園 戶外休閒 parks outdoor'],
    requestedQueryCount: 7,
    queryLimit: 6,
    truncated: true,
  })
  session.recordQueryResult({
    phase: 'initial',
    query: '仁武 attractions',
    rawPlaceCount: 12,
  })
  session.recordQueryResult({
    phase: 'initial',
    query: '公園 戶外休閒 parks outdoor',
    rawPlaceCount: 8,
  })
  session.recordCandidatePool({
    rawCandidateCount: 15,
    usableCandidateCount: 1,
    candidates: [
      {
        name: candidate.name,
        placeId: candidate.placeId,
        types: candidate.types,
        role: candidate.role,
        score: candidate.score,
        distanceKm: candidate.distanceKm,
        rating: candidate.rating,
        reviewCount: candidate.reviewCount,
        openingHoursKnown: true,
        availabilitySlotCount: 2,
        availabilitySlots: candidate.availabilitySlots,
        excluded: false,
        exclusionReason: null,
      },
    ],
  })
  session.recordCandidateSets({
    firstStopCandidates: [candidate],
    otherCandidates: [candidate],
    allCandidates: [candidate],
  })
  session.recordAiInput({
    nearStops: [candidate],
    foodStops: [],
    mainStops: [candidate],
    fallbackStops: [candidate],
    promptCandidates: [candidate, candidate],
  })
  session.recordAiOutput([plan], 'initial-ai-output')
  session.recordValidation(
    plan,
    {
      validatedPlan: plan,
      invalidCount: 0,
      firstStopInvalid: false,
      validationPerformed: true,
      issues: [],
    },
    'final-parse',
  )
  session.recordRepair(plan, plan, [], 'final-repair')

  const plansBeforeReport = structuredClone([plan])
  let written = ''
  const report = writeTripCandidateDebugReport(session, [plan], new Map(), 'completed', {
    env: { NODE_ENV: 'development', TRIP_CANDIDATE_DEBUG: 'true' },
    append: (_path, content) => { written += content },
  })

  assert.ok(report)
  assert.equal(report.queryLayer.batches[0].truncated, true)
  assert.equal(report.queryLayer.batches[0].results[0].rawPlaceCount, 12)
  assert.equal(report.candidatePool.rawCandidateCount, 15)
  assert.equal(report.candidatePool.usableCandidateCount, 1)
  assert.equal(report.candidatePool.candidates[0].score, 91.2)
  assert.equal(report.aiInput.uniqueCandidateCount, 1)
  assert.equal(report.aiOutput[0].plans[0].stops[0].name, candidate.name)
  assert.equal(report.resultLayer.finalDeliveryPlans[0].stops[0].name, candidate.name)
  assert.equal(report.aiInput.sameCandidatePoolForAllPlans, true)
  assert.match(written, /trip-candidate-debug-report/)
  assert.deepEqual([plan], plansBeforeReport)
})
