import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCandidateSearchQueries,
  getFirstStopCandidates,
} from '../../api/_lib/google-places.ts'
import { selectSupplementalCandidate } from '../../api/generate-trip.ts'

test('跨夜到清晨的六個 query 名額保留深夜與清晨搜尋', () => {
  for (const [startTime, endTime] of [
    ['20:00', '06:00'],
    ['22:00', '06:00'],
  ]) {
    const queries = buildCandidateSearchQueries(input(startTime, endTime))

    assert.equal(queries.length, 6)
    assert.equal(queries.some((query) => query.includes('late night 24 hours')), true)
    assert.equal(queries.some((query) => query.includes('early morning')), true)
  }
})

test('清晨短窗與 active window 長窗保留原本時間語意', () => {
  const shortWindowQueries = buildCandidateSearchQueries(input('03:00', '06:00'))
  const activeWindowQueries = buildCandidateSearchQueries(input('03:00', '12:00'))
  const zeroWindowQueries = buildCandidateSearchQueries(input('06:00', '06:00'))

  assert.equal(shortWindowQueries.some((query) => query.includes('early morning')), true)
  assert.equal(activeWindowQueries.some((query) => query.includes('early morning')), true)
  assert.equal(zeroWindowQueries.some((query) => query.includes('early morning')), false)
})

test('第一站同時符合 2 公里、實際開始時間、最短停留與 closing buffer', () => {
  const candidates = [
    candidate('night-open', 1.4, [[19 * 60, 23 * 60 + 30]]),
    candidate('closes-too-soon', 1.2, [[19 * 60, 21 * 60]]),
    candidate('too-far', 2.1, [[19 * 60, 23 * 60 + 30]]),
    candidate('dawn-only', 1.1, [[24 * 60, 31 * 60]]),
    candidateWithoutKnownHours('unknown-hours', 1),
  ]

  assert.deepEqual(
    getFirstStopCandidates(candidates, input('20:00', '06:00')).map((item) => item.placeId),
    ['night-open'],
  )
  assert.deepEqual(
    getFirstStopCandidates(candidates, input('22:00', '06:00')).map((item) => item.placeId),
    ['night-open'],
  )
})

test('03:00→06:00 從 03:00 選第一站，03:00→12:00 從 06:00 選第一站', () => {
  const candidates = [
    candidate('overnight', 1, [[3 * 60, 5 * 60]]),
    candidate('morning', 1, [[6 * 60, 8 * 60]]),
  ]

  assert.deepEqual(
    getFirstStopCandidates(candidates, input('03:00', '06:00')).map((item) => item.placeId),
    ['overnight'],
  )
  assert.deepEqual(
    getFirstStopCandidates(candidates, input('03:00', '12:00')).map((item) => item.placeId),
    ['morning'],
  )
  assert.deepEqual(getFirstStopCandidates(candidates, input('06:00', '06:00')), [])
})

test('coverage supplemental selection 不把白天地點補到 04:00，並保留 closing buffer', () => {
  const candidates = [
    candidate('daytime', 1, [[11 * 60, 21 * 60]]),
    candidate('dawn-closes-too-soon', 1, [[24 * 60, 29 * 60 + 30]]),
    candidate('dawn-open', 1, [[24 * 60, 31 * 60]]),
    candidateWithoutKnownHours('unknown-hours', 1),
  ]

  const selected = selectSupplementalCandidate(candidates, new Set(), 28 * 60)

  assert.equal(selected?.placeId, 'dawn-open')
})

function input(startTime, endTime) {
  return {
    startTime,
    endTime,
    tags: [],
    category: 'explore',
    location: {
      name: '高雄',
      lat: 22.63,
      lng: 120.3,
    },
  }
}

function candidate(placeId, distanceKm, ranges) {
  return {
    name: placeId,
    address: `${placeId} address`,
    placeId,
    googleMapsUrl: `https://example.com/${placeId}`,
    distanceKm,
    role: 'main_activity',
    openingHours: {
      windows: ranges.map(([start, end]) => ({
        openAt: dateAtTripMinute(start),
        closeAt: dateAtTripMinute(end),
      })),
      source: 'regular',
      utcOffsetMinutes: 0,
      isKnown: true,
      isNeverOpen: false,
    },
  }
}

function candidateWithoutKnownHours(placeId, distanceKm) {
  return {
    name: placeId,
    address: `${placeId} address`,
    placeId,
    googleMapsUrl: `https://example.com/${placeId}`,
    distanceKm,
    role: 'main_activity',
  }
}

function dateAtTripMinute(totalMinutes) {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(midnight + totalMinutes * 60 * 1000)
}
