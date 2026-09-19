import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getPersonalizationBoostCap,
  getPersonalizationCandidateBoost,
  getPersonalizedCandidateScore,
} from '../../api/_lib/personalization-candidate-boost.ts'
import { loadServerPreferenceProfile } from '../../api/_lib/server-personalization-profile.ts'
import { buildPreferenceProfile } from '../../src/services/personalization/preferenceProfile.js'

test('empty profile leaves final score unchanged', () => {
  const profile = buildPreferenceProfile([])
  const result = getPersonalizedCandidateScore(90, makeCandidate(), profile)

  assert.equal(result.finalScore, 90)
  assert.equal(result.boost.bonus, 0)
})

test('sampleCount 1 boost is weaker than sampleCount 15', () => {
  const candidate = makeCandidate()
  const smallProfile = makeProfile(1)
  const fullProfile = makeProfile(15)

  assert.ok(
    getPersonalizationCandidateBoost(candidate, smallProfile).bonus
      < getPersonalizationCandidateBoost(candidate, fullProfile).bonus,
  )
})

test('boost never exceeds cap', () => {
  const boost = getPersonalizationCandidateBoost(makeCandidate({
    types: ['cafe', 'restaurant', 'bakery', 'food', 'point_of_interest'],
  }), {
    sampleCount: 30,
    updatedAt: '2026-09-18T12:00:00.000Z',
    categoryScores: {},
    tagScores: {},
    stopTypeScores: { food: 999 },
    googleTypeScores: {
      cafe: 999,
      restaurant: 999,
      bakery: 999,
      food: 999,
      point_of_interest: 999,
    },
    candidateRoleScores: { food: 999 },
    foodSubtypeScores: { cafe: 999 },
    preferredPlaces: [],
  })

  assert.equal(getPersonalizationBoostCap(), 3)
  assert.ok(boost.bonus <= 3)
})

test('matching many googleTypes does not multiply without bound', () => {
  const candidate = makeCandidate({
    types: ['cafe', 'restaurant', 'bakery', 'food', 'point_of_interest', 'store'],
    role: undefined,
    foodSubtype: undefined,
  })
  const profile = {
    sampleCount: 15,
    updatedAt: '2026-09-18T12:00:00.000Z',
    categoryScores: {},
    tagScores: {},
    stopTypeScores: {},
    googleTypeScores: {
      cafe: 20,
      restaurant: 20,
      bakery: 20,
      food: 20,
      point_of_interest: 20,
      store: 20,
    },
    candidateRoleScores: {},
    foodSubtypeScores: {},
    preferredPlaces: [],
  }
  const boost = getPersonalizationCandidateBoost(candidate, profile)

  assert.ok(boost.bonus > 0)
  assert.ok(boost.bonus < 1.5)
  assert.equal(
    boost.matchedSignals.filter((signal) => signal.startsWith('googleType:')).length,
    3,
  )
})

test('role, stopType, and foodSubtype matches stay bounded', () => {
  const boost = getPersonalizationCandidateBoost(makeCandidate(), makeProfile(15))

  assert.ok(boost.bonus > 0)
  assert.ok(boost.bonus <= 3)
  assert.ok(boost.matchedSignals.includes('candidateRole:food'))
  assert.ok(boost.matchedSignals.includes('stopType:food'))
  assert.ok(boost.matchedSignals.includes('foodSubtype:cafe'))
})

test('preference match can slightly overtake nearby base score', () => {
  const profile = makeProfile(15)
  const matching = getPersonalizedCandidateScore(90, makeCandidate(), profile)
  const unmatched = getPersonalizedCandidateScore(91, makeCandidate({
    types: ['museum'],
    role: 'main_activity',
    foodSubtype: undefined,
  }), profile)

  assert.ok(matching.finalScore > unmatched.finalScore)
  assert.ok(matching.finalScore <= 93)
  assert.equal(unmatched.finalScore, 91)
})

test('large base score gap is not overturned', () => {
  const profile = makeProfile(15)
  const matching = getPersonalizedCandidateScore(90, makeCandidate(), profile)
  const strongBase = getPersonalizedCandidateScore(100, makeCandidate({
    types: ['museum'],
    role: 'main_activity',
    foodSubtype: undefined,
  }), profile)

  assert.ok(matching.finalScore < strongBase.finalScore)
})

test('server profile loader query failure falls back to empty profile', async () => {
  const profile = await loadServerPreferenceProfile(makeFailingSupabase(), 'user-1')

  assert.equal(profile.sampleCount, 0)
  assert.deepEqual(profile.googleTypeScores, {})
})

test('server profile loader tolerates malformed legacy events', async () => {
  const profile = await loadServerPreferenceProfile(makeRowsSupabase([
    {
      event_type: 'open_maps',
      google_types: 'not-an-array',
      event_snapshot: { stops: [{ name: 'legacy stop' }] },
      created_at: '2026-09-18T12:00:00.000Z',
    },
  ]), 'user-1')

  assert.equal(profile.sampleCount, 1)
  assert.deepEqual(profile.googleTypeScores, {})
})

test('candidate boost is deterministic', () => {
  const candidate = makeCandidate()
  const profile = makeProfile(15)

  assert.deepEqual(
    getPersonalizationCandidateBoost(candidate, profile),
    getPersonalizationCandidateBoost(candidate, profile),
  )
})

function makeCandidate(overrides = {}) {
  return {
    name: 'User Preferred Cafe',
    address: 'Taipei',
    placeId: 'preferred-cafe',
    googleMapsUrl: 'https://maps.example/preferred-cafe',
    types: ['cafe', 'restaurant'],
    role: 'food',
    foodSubtype: 'cafe',
    score: 90,
    ...overrides,
  }
}

function makeProfile(sampleCount) {
  return {
    sampleCount,
    updatedAt: '2026-09-18T12:00:00.000Z',
    categoryScores: {},
    tagScores: {},
    stopTypeScores: { food: 18 },
    googleTypeScores: { cafe: 18, restaurant: 12 },
    candidateRoleScores: { food: 18 },
    foodSubtypeScores: { cafe: 18 },
    preferredPlaces: [],
  }
}

function makeFailingSupabase() {
  return makeRowsSupabase(null, { message: 'query failed' })
}

function makeRowsSupabase(rows, error = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: rows, error }),
          }),
        }),
      }),
    }),
  }
}
