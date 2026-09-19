import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPreferenceProfile } from '../../src/services/personalization/preferenceProfile.js'

const NOW = '2026-09-18T12:00:00.000Z'

test('open_maps has lower influence than start_navigation', () => {
  const profile = buildPreferenceProfile([
    stopEvent('open_maps', 'open-place', 'Cafe Open', ['cafe'], NOW),
    stopEvent('start_navigation', 'nav-place', 'Cafe Nav', ['restaurant'], NOW),
  ], { referenceTime: NOW })

  assert.equal(profile.stopTypeScores.food, 3)
  assert.equal(profile.googleTypeScores.cafe, 1)
  assert.equal(profile.googleTypeScores.restaurant, 2)
  assert.equal(profile.preferredPlaces[0].placeId, 'nav-place')
})

test('favorite_plan is stronger than one navigation but stop-level weight does not grow linearly', () => {
  const favoriteProfile = buildPreferenceProfile([
    {
      eventType: 'favorite_plan',
      inputCategory: 'food',
      inputTags: ['food_first'],
      createdAt: NOW,
      eventSnapshot: {
        stops: [
          favoriteStop('p1', 'Cafe 1'),
          favoriteStop('p2', 'Cafe 2'),
          favoriteStop('p3', 'Cafe 3'),
          favoriteStop('p4', 'Cafe 4'),
          favoriteStop('p5', 'Cafe 5'),
          favoriteStop('p6', 'Cafe 6'),
        ],
      },
    },
  ], { referenceTime: NOW })
  const navigationProfile = buildPreferenceProfile([
    stopEvent('start_navigation', 'nav-place', 'Cafe Nav', ['cafe'], NOW),
  ], { referenceTime: NOW })

  assert.equal(favoriteProfile.categoryScores.food, 3)
  assert.equal(favoriteProfile.stopTypeScores.food, 3)
  assert.equal(navigationProfile.stopTypeScores.food, 2)
  assert.ok(favoriteProfile.stopTypeScores.food > navigationProfile.stopTypeScores.food)
  assert.ok(favoriteProfile.stopTypeScores.food < 6)
  assert.equal(favoriteProfile.preferredPlaces[0].score, 0.5)
})

test('multiple googleTypes split one event weight instead of multiplying it', () => {
  const profile = buildPreferenceProfile([
    stopEvent(
      'open_maps',
      'multi-type-place',
      'Gallery Cafe',
      ['cafe', 'restaurant', 'tourist_attraction', 'museum'],
      NOW,
    ),
  ], { referenceTime: NOW })
  const totalGoogleTypeScore = Object.values(profile.googleTypeScores)
    .reduce((sum, score) => sum + score, 0)

  assert.equal(totalGoogleTypeScore, 1)
  assert.equal(profile.googleTypeScores.cafe, 0.25)
  assert.equal(profile.googleTypeScores.museum, 0.25)
})

test('older events decay below newer events', () => {
  const profile = buildPreferenceProfile([
    stopEvent('open_maps', 'old-place', 'Old Cafe', ['cafe'], '2026-08-19T12:00:00.000Z'),
    stopEvent('open_maps', 'new-place', 'New Museum', ['museum'], NOW),
  ], { referenceTime: NOW })

  assert.ok(profile.googleTypeScores.cafe < profile.googleTypeScores.museum)
  assert.equal(profile.googleTypeScores.museum, 1)
})

test('empty events return an empty profile', () => {
  const profile = buildPreferenceProfile([], { referenceTime: NOW })

  assert.deepEqual(profile, {
    sampleCount: 0,
    updatedAt: null,
    categoryScores: {},
    tagScores: {},
    stopTypeScores: {},
    googleTypeScores: {},
    candidateRoleScores: {},
    foodSubtypeScores: {},
    preferredPlaces: [],
  })
})

test('legacy events with missing metadata do not throw', () => {
  const profile = buildPreferenceProfile([
    {
      eventType: 'open_maps',
      placeId: 'legacy-place',
      placeName: 'Legacy Place',
      createdAt: NOW,
    },
    {
      eventType: 'favorite_plan',
      eventSnapshot: { stops: [{ name: 'No metadata stop' }] },
      createdAt: NOW,
    },
  ], { referenceTime: NOW })

  assert.equal(profile.sampleCount, 2)
  assert.equal(profile.preferredPlaces[0].placeId, 'legacy-place')
  assert.deepEqual(profile.googleTypeScores, {})
})

test('same events produce the same profile', () => {
  const events = [
    stopEvent('open_maps', 'same-place', 'Same Cafe', ['cafe', 'food'], NOW),
    {
      eventType: 'favorite_plan',
      inputCategory: 'date',
      inputTags: ['photo_first', 'short_distance'],
      createdAt: NOW,
      eventSnapshot: {
        stops: [
          favoriteStop('same-place', 'Same Cafe'),
          favoriteStop('museum-place', 'Museum'),
        ],
      },
    },
  ]

  assert.deepEqual(
    buildPreferenceProfile(events, { referenceTime: NOW }),
    buildPreferenceProfile(events, { referenceTime: NOW }),
  )
})

function stopEvent(eventType, placeId, placeName, googleTypes, createdAt) {
  return {
    eventType,
    placeId,
    placeName,
    stopType: 'food',
    googleTypes,
    candidateRole: 'food',
    foodSubtype: 'cafe',
    inputCategory: 'food',
    inputTags: ['food_first'],
    createdAt,
  }
}

function favoriteStop(placeId, name) {
  return {
    id: placeId,
    name,
    type: 'food',
    placeId,
    googleTypes: ['cafe', 'restaurant'],
    candidateRole: 'food',
    foodSubtype: 'cafe',
  }
}
