import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

import { buildPreferenceProfile } from '../../src/services/personalization/preferenceProfile.js'
import {
  getPersonalizationCandidateBoost,
  getPersonalizedCandidateScore,
} from '../../api/_lib/personalization-candidate-boost.ts'

const eventServiceUrl = new URL('../../src/services/personalization/personalizationEventsService.ts', import.meta.url)
// The production builder is pure; replace only its browser Supabase dependency to avoid I/O.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === eventServiceUrl.href) {
      if (specifier === '../auth/supabaseClient') {
        return { url: 'data:text/javascript,export const supabase = null', shortCircuit: true }
      }
      if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
let buildStopPersonalizationEvent
try {
  ;({ buildStopPersonalizationEvent } = await import(eventServiceUrl.href))
} finally {
  hooks.deregister()
}

const NOW = '2026-09-18T12:00:00.000Z'

test('real navigation builder produces four signals and ranks Thai above unseen Japanese', (t) => {
  const profile = navigationProfile(repeatTypes(15, ['thai_restaurant', 'restaurant']))
  const thai = candidate(['thai_restaurant', 'restaurant'])
  const japanese = candidate(['japanese_restaurant', 'restaurant'])
  const originalProfile = structuredClone(profile)
  const originalCandidates = structuredClone([thai, japanese])
  const a = getPersonalizedCandidateScore(90, thai, profile)
  const b = getPersonalizedCandidateScore(90, japanese, profile)

  assert.equal(profile.sampleCount, 15)
  assert.deepEqual(profile.googleTypeScores, { thai_restaurant: 15, restaurant: 15 })
  assert.deepEqual(profile.candidateRoleScores, { food: 30 })
  assert.deepEqual(profile.foodSubtypeScores, { restaurant: 30 })
  assert.deepEqual(profile.stopTypeScores, { food: 30 })
  assert.equal(a.boost.confidence, 1)
  assert.equal(b.boost.confidence, 1)
  assertNear(a.boost.bonus, 2.45)
  assertNear(b.boost.bonus, 2.30)
  assert.ok(a.boost.bonus > b.boost.bonus)
  assert.ok(a.finalScore > b.finalScore)
  for (const result of [a, b]) {
    for (const match of ['candidateRole:food', 'foodSubtype:restaurant', 'stopType:food']) {
      assert.ok(result.boost.matchedSignals.includes(match))
    }
  }
  assert.ok(a.boost.matchedSignals.includes('googleType:thai_restaurant'))
  assert.ok(!b.boost.matchedSignals.includes('googleType:japanese_restaurant'))
  assert.deepEqual(profile, originalProfile)
  assert.deepEqual([thai, japanese], originalCandidates)

  t.diagnostic(JSON.stringify({ a, b }))
})

test('full profile with Thai and Japanese history preserves both specific matches', (t) => {
  const profile = navigationProfile([
    ...repeatTypes(8, ['thai_restaurant', 'restaurant']),
    ...repeatTypes(7, ['japanese_restaurant', 'restaurant']),
  ])
  const thai = getPersonalizationCandidateBoost(candidate(['thai_restaurant', 'restaurant']), profile)
  const japanese = getPersonalizationCandidateBoost(candidate(['japanese_restaurant', 'restaurant']), profile)
  const fallback = getPersonalizationCandidateBoost(candidate(['restaurant']), profile)

  assertNear(thai.bonus, 2.42)
  assertNear(japanese.bonus, 2.41)
  assertNear(fallback.bonus, 2.30)
  assert.ok(thai.bonus > fallback.bonus)
  assert.ok(japanese.bonus > fallback.bonus)
  assert.ok(thai.matchedSignals.includes('googleType:thai_restaurant'))
  assert.ok(japanese.matchedSignals.includes('googleType:japanese_restaurant'))
  t.diagnostic(JSON.stringify({ thai, japanese, fallback }))
})

test('full restaurant-only history does not arbitrarily distinguish Thai and Japanese', (t) => {
  const profile = navigationProfile(repeatTypes(15, ['restaurant']))
  const thai = getPersonalizedCandidateScore(90, candidate(['thai_restaurant', 'restaurant']), profile)
  const japanese = getPersonalizedCandidateScore(90, candidate(['japanese_restaurant', 'restaurant']), profile)

  assert.deepEqual(thai, japanese)
  assert.equal(thai.boost.bonus, 2.49)
  assert.equal(thai.finalScore, 92.5)
  t.diagnostic(JSON.stringify({ thai, japanese }))
})

test('real art museum history distinguishes art from unseen history museum without food signals', (t) => {
  const profile = navigationProfile(repeatTypes(15, ['art_museum', 'museum']), 'main_activity')
  const art = getPersonalizedCandidateScore(90, candidate(['art_museum', 'museum'], 'main_activity'), profile)
  const history = getPersonalizedCandidateScore(90, candidate(['history_museum', 'museum'], 'main_activity'), profile)

  assert.deepEqual(profile.foodSubtypeScores, {})
  assert.deepEqual(profile.candidateRoleScores, { main_activity: 30 })
  assert.deepEqual(profile.stopTypeScores, { main_activity: 30 })
  assertNear(art.boost.bonus, 1.98)
  assertNear(history.boost.bonus, 1.83)
  assert.ok(art.finalScore > history.finalScore)
  assert.ok(!history.boost.matchedSignals.includes('googleType:history_museum'))
  t.diagnostic(JSON.stringify({ art, history }))
})

test('city park history gives a specific bonus only through its exact matches', (t) => {
  const profile = navigationProfile(repeatTypes(15, ['city_park', 'park']), 'open_space')
  const city = getPersonalizedCandidateScore(90, candidate(['city_park', 'park'], 'open_space'), profile)
  const national = getPersonalizedCandidateScore(90, candidate(['national_park', 'park'], 'open_space'), profile)
  const park = getPersonalizedCandidateScore(90, candidate(['park'], 'open_space'), profile)
  const coarseProfile = navigationProfile(repeatTypes(15, ['park']), 'open_space')

  assert.deepEqual(profile.googleTypeScores, { city_park: 15, park: 15 })
  assert.deepEqual(profile.candidateRoleScores, { open_space: 30 })
  assert.deepEqual(profile.stopTypeScores, { main_activity: 30 })
  assertNear(city.boost.bonus, 1.98)
  assertNear(national.boost.bonus, 1.83)
  assert.deepEqual(national, park)
  assert.ok(city.finalScore > national.finalScore)
  assert.deepEqual(
    getPersonalizedCandidateScore(90, candidate(['city_park', 'park'], 'open_space'), coarseProfile),
    getPersonalizedCandidateScore(90, candidate(['national_park', 'park'], 'open_space'), coarseProfile),
  )
  t.diagnostic(JSON.stringify({ city, national, park }))
})

test('unmatched park_and_ride history does not influence exact park matching', () => {
  const profile = navigationProfile([
    ...repeatTypes(8, ['park']),
    ...repeatTypes(7, ['park_and_ride']),
  ], 'open_space')
  const park = candidate(['park'], 'open_space')
  const unrelatedTypeRemoved = { ...profile, googleTypeScores: { park: profile.googleTypeScores.park } }

  assert.deepEqual(
    getPersonalizationCandidateBoost(park, profile),
    getPersonalizationCandidateBoost(park, unrelatedTypeRemoved),
  )
})

test('Latin American history does not lower an exact American restaurant match', (t) => {
  const american = candidate(['american_restaurant', 'restaurant'])
  const control = navigationProfile([
    ...repeatTypes(15, american.types),
    ...repeatTypes(15, ['japanese_restaurant', 'restaurant']),
  ])
  const latin = navigationProfile([
    ...repeatTypes(15, american.types),
    ...repeatTypes(15, ['latin_american_restaurant', 'restaurant']),
  ])
  const before = getPersonalizationCandidateBoost(american, control)
  const after = getPersonalizationCandidateBoost(american, latin)

  assert.deepEqual(after, before)
  assert.ok(!after.matchedSignals.includes('googleType:latin_american_restaurant'))
  t.diagnostic(JSON.stringify({ before, after }))
})

test('park, cafe, and garden matching is independent of similarly named learned types', (t) => {
  const cases = [
    { coarse: 'park', control: 'campground', similar: ['rv_park', 'city_park', 'national_park'], role: 'open_space' },
    { coarse: 'cafe', control: 'dessert_shop', similar: ['internet_cafe'], role: 'food', foodSubtype: 'cafe' },
    { coarse: 'garden', control: 'city_park', similar: ['beer_garden'], role: 'open_space' },
  ]
  for (const { coarse, control, similar, role, foodSubtype } of cases) {
    const place = candidate([coarse], role, foodSubtype)
    const controlProfile = navigationProfile([
      ...repeatTypes(15, [coarse]), ...repeatTypes(15, [control]),
    ], role, foodSubtype)
    const before = getPersonalizationCandidateBoost(place, controlProfile)
    for (const type of similar) {
      const profile = navigationProfile([
        ...repeatTypes(15, [coarse]), ...repeatTypes(15, [type]),
      ], role, foodSubtype)
      const after = getPersonalizationCandidateBoost(place, profile)
      assert.deepEqual(after, before, `${type} must not alter the exact ${coarse} match`)
      t.diagnostic(JSON.stringify({ coarse, type, before, after }))
    }
  }
})

test('unseen similarly named types get no inherited Google match in either direction', () => {
  const pairs = [
    ['american_restaurant', 'latin_american_restaurant', 'food'],
    ['park', 'rv_park', 'open_space'],
    ['park', 'city_park', 'open_space'],
    ['park', 'national_park', 'open_space'],
    ['cafe', 'internet_cafe', 'food'],
    ['garden', 'beer_garden', 'open_space'],
  ]
  for (const [first, second, role] of pairs) {
    for (const [learned, unseen] of [[first, second], [second, first]]) {
      const profile = navigationProfile(repeatTypes(15, [learned]), role)
      const empty = getPersonalizationCandidateBoost(candidate([], role), profile)
      const onlyUnseen = getPersonalizationCandidateBoost(candidate([unseen], role), profile)
      const withExact = getPersonalizationCandidateBoost(candidate([unseen, learned], role), profile)
      const onlyExact = getPersonalizationCandidateBoost(candidate([learned], role), profile)

      assert.deepEqual(onlyUnseen, empty)
      assert.deepEqual(withExact, onlyExact)
      assert.ok(!onlyUnseen.matchedSignals.some((signal) => signal.startsWith('googleType:')))
      assert.ok(withExact.bonus > onlyUnseen.bonus)
    }
  }
})

test('full profile with generic-only types preserves other signals but adds no Google signal', () => {
  const genericTypes = ['establishment', 'point_of_interest', 'food', 'store']
  const profile = navigationProfile(repeatTypes(15, genericTypes))
  const generic = getPersonalizationCandidateBoost(candidate(genericTypes), profile)
  const missingTypes = getPersonalizationCandidateBoost(candidate(undefined), profile)

  assert.deepEqual(profile.googleTypeScores, {})
  assert.deepEqual(generic, missingTypes)
  assert.ok(generic.bonus > 0)
  assert.ok(!generic.matchedSignals.some((signal) => signal.startsWith('googleType:')))
})

function assertNear(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 0.01 + Number.EPSILON, `${actual} should be close to ${expected}`)
}

function repeatTypes(count, types) {
  return Array.from({ length: count }, () => [...types])
}

function candidate(types, role = 'food', foodSubtype = role === 'food' ? 'restaurant' : undefined) {
  return {
    name: 'Same Candidate Metadata',
    address: 'Taipei',
    placeId: 'same-candidate',
    googleMapsUrl: 'https://maps.example/same-candidate',
    types,
    role,
    foodSubtype,
    score: 90,
  }
}

function navigationProfile(typeLists, role = 'food', foodSubtype = role === 'food' ? 'restaurant' : undefined) {
  const events = typeLists.map((types, index) => {
    const place = candidate(types, role, foodSubtype)
    const stop = {
      id: `stop-${index}`,
      name: place.name,
      type: role === 'food' ? 'food' : 'main_activity',
      description: 'Navigation regression fixture',
      address: place.address,
      duration: role === 'food' ? 45 : 60,
      placeId: `place-${index}`,
      googleTypes: [...types, 'establishment', 'point_of_interest', ...(role === 'food' ? ['food'] : [])],
      candidateRole: role,
      foodSubtype: place.foodSubtype,
    }
    const plan = {
      id: 'plan', type: 'balanced', title: 'Plan', subtitle: '', summary: '',
      totalTime: stop.duration, budget: 0, transportMode: 'scooter',
      stops: [stop], transportSegments: [], rainBackup: [], rainTransportSegments: [],
    }
    return {
      ...buildStopPersonalizationEvent({ userId: 'regression-user', eventType: 'start_navigation', stop, plan }),
      createdAt: NOW,
    }
  })
  return buildPreferenceProfile(events, { referenceTime: NOW })
}
