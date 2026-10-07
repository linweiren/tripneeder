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
    2,
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

test('concentrated Thai history distinguishes Thai from unseen Japanese with identical base metadata', () => {
  for (const genericPrefix of [[], ['establishment', 'point_of_interest', 'food', 'store']]) {
    const profile = googleOnlyHistory(Array.from({ length: 15 }, () => [
      ...genericPrefix, 'thai_restaurant', 'restaurant',
    ]))
    const thai = googleOnlyCandidate(['thai_restaurant', 'restaurant'])
    const japanese = googleOnlyCandidate(['japanese_restaurant', 'restaurant'])
    const thaiResult = getPersonalizedCandidateScore(90, thai, profile)
    const japaneseResult = getPersonalizedCandidateScore(90, japanese, profile)

    assert.equal(profile.googleTypeScores.thai_restaurant, 15)
    assert.equal(profile.googleTypeScores.restaurant, 15)
    assert.ok(thaiResult.boost.bonus > japaneseResult.boost.bonus)
    assert.ok(thaiResult.finalScore > japaneseResult.finalScore)
    assert.ok(japaneseResult.boost.bonus > 0, 'restaurant retains a soft fallback')
    assert.ok(!japaneseResult.boost.matchedSignals.includes('googleType:japanese_restaurant'))
  }
})

test('generic-only Google types are neutral even in a legacy profile', () => {
  const genericTypes = ['establishment', 'point_of_interest', 'food', 'store']
  const profile = googleOnlyHistory(Array.from({ length: 15 }, () => genericTypes))
  const legacyProfile = {
    ...profile,
    googleTypeScores: Object.fromEntries(genericTypes.map((type) => [type, 999])),
  }
  const candidate = googleOnlyCandidate(genericTypes)
  const originalTypes = [...candidate.types]

  assert.deepEqual(profile.googleTypeScores, {})
  for (const currentProfile of [profile, legacyProfile]) {
    const result = getPersonalizedCandidateScore(90, candidate, currentProfile)
    assert.equal(result.boost.bonus, 0)
    assert.deepEqual(result.boost.matchedSignals, [])
    assert.equal(result.finalScore, 90)
  }
  assert.deepEqual(candidate.types, originalTypes)
})

test('restaurant-only history preserves coarse soft influence for both coarse and fine candidates', () => {
  const profile = googleOnlyHistory(Array.from({ length: 15 }, () => ['restaurant']))
  const coarse = getPersonalizationCandidateBoost(googleOnlyCandidate(['restaurant']), profile)
  const fine = getPersonalizationCandidateBoost(
    googleOnlyCandidate(['japanese_restaurant', 'restaurant']), profile,
  )

  assert.equal(coarse.bonus, 1.07)
  assert.equal(fine.bonus, coarse.bonus)
})

test('fine plus coarse matches and an additional weaker fine match never dilute the signal', () => {
  for (const restaurantScore of [1, 100]) {
    const profile = {
      ...googleOnlyHistory(Array.from({ length: 15 }, () => ['thai_restaurant', 'restaurant'])),
      googleTypeScores: { thai_restaurant: 15, restaurant: restaurantScore, seafood_restaurant: 1 },
    }
    const fine = getPersonalizationCandidateBoost(googleOnlyCandidate(['thai_restaurant']), profile)
    const fineCoarse = getPersonalizationCandidateBoost(
      googleOnlyCandidate(['thai_restaurant', 'restaurant']), profile,
    )
    const additionalFine = getPersonalizationCandidateBoost(
      googleOnlyCandidate(['thai_restaurant', 'restaurant', 'seafood_restaurant']), profile,
    )
    const coarse = getPersonalizationCandidateBoost(googleOnlyCandidate(['restaurant']), profile)

    assert.ok(fineCoarse.bonus >= fine.bonus)
    assert.ok(additionalFine.bonus >= fineCoarse.bonus)
    assert.ok(fineCoarse.bonus >= coarse.bonus)
  }
})

test('an unseen subtype alone has zero bonus and leaves the base score intact', () => {
  const profile = googleOnlyHistory(Array.from({ length: 15 }, () => ['thai_restaurant', 'restaurant']))
  const result = getPersonalizedCandidateScore(90, googleOnlyCandidate(['japanese_restaurant']), profile)

  assert.equal(result.boost.bonus, 0)
  assert.equal(result.finalScore, 90)
  assert.deepEqual(result.boost.matchedSignals, [])
})

test('missing and empty candidate metadata safely yield a neutral Google signal', () => {
  const profile = googleOnlyHistory(Array.from({ length: 15 }, () => ['thai_restaurant', 'restaurant']))
  for (const types of [undefined, null, [], ['', '  ']]) {
    const result = getPersonalizedCandidateScore(90, googleOnlyCandidate(types), profile)
    assert.equal(result.boost.bonus, 0)
    assert.equal(result.finalScore, 90)
  }
})

test('mixed Thai and art museum history gives both interests a bounded soft bonus', () => {
  const profile = googleOnlyHistory([
    ...Array.from({ length: 8 }, () => ['thai_restaurant', 'restaurant']),
    ...Array.from({ length: 7 }, () => ['art_museum', 'museum']),
  ])
  const thai = getPersonalizationCandidateBoost(
    googleOnlyCandidate(['thai_restaurant', 'restaurant']), profile,
  )
  const art = getPersonalizationCandidateBoost(googleOnlyCandidate(['art_museum', 'museum']), profile)
  const museum = getPersonalizationCandidateBoost(googleOnlyCandidate(['museum']), profile)

  for (const boost of [thai, art]) {
    assert.ok(boost.bonus > 0)
    assert.ok(boost.bonus <= getPersonalizationBoostCap())
  }
  assert.ok(art.bonus > museum.bonus)
  assert.ok(thai.matchedSignals.includes('googleType:thai_restaurant'))
  assert.ok(art.matchedSignals.includes('googleType:art_museum'))
})

test('Top-2 exact matching stays monotone, bounded, and ignores extra weaker or unseen types', () => {
  const scoreValues = [0, 0.01, 0.1, 1, 8, 15, 30, 60, 999]
  for (const firstScore of scoreValues) {
    for (const secondScore of scoreValues) {
      const profile = {
        ...googleOnlyHistory(Array.from({ length: 15 }, () => ['cafe'])),
        googleTypeScores: {
          cafe: firstScore,
          bakery: secondScore,
          dessert_shop: Math.min(firstScore, secondScore),
        },
      }
      const boost = (types) => getPersonalizationCandidateBoost(googleOnlyCandidate(types), profile)
      const single = boost(['cafe'])
      const pair = boost(['cafe', 'bakery'])
      const triple = boost(['cafe', 'bakery', 'dessert_shop'])
      const noisyMetadata = boost([
        ' cafe ', 'bakery', 'cafe', 'dessert_shop', 'unseen_type',
        'establishment', 'point_of_interest', 'food', 'store',
      ])

      assert.ok(pair.bonus >= single.bonus)
      assert.ok(pair.bonus >= 0 && pair.bonus <= 1.35)
      assert.ok(pair.rawSignal >= 0 && pair.rawSignal <= 0.45)
      assert.equal(triple.bonus, pair.bonus)
      assert.equal(triple.rawSignal, pair.rawSignal)
      assert.deepEqual(noisyMetadata, triple)
      assert.ok(pair.matchedSignals.length <= 2)
    }
  }
})

function googleOnlyCandidate(types) {
  return makeCandidate({ types, role: undefined, foodSubtype: undefined })
}

function googleOnlyHistory(typeLists) {
  return buildPreferenceProfile(typeLists.map((googleTypes, index) => ({
    eventType: 'start_navigation',
    placeId: `place-${index}`,
    googleTypes,
    createdAt: '2026-09-18T12:00:00.000Z',
  })), { referenceTime: '2026-09-18T12:00:00.000Z' })
}

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
