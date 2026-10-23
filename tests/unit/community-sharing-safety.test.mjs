import test from 'node:test'
import assert from 'node:assert/strict'

import { deduplicateAndValidateSharedTrips, sanitizeSharedPlan } from '../../src/services/community/communityData.js'

const plan = {
  id: 'plan-1', type: 'balanced', title: 'Trip', subtitle: '', summary: '', totalTime: 60,
  budget: 1000, transportMode: 'car', stops: [{ id: 's1', name: 'Cafe', type: 'food', description: '', address: '1 Private Road', googleMapsUrl: 'https://maps.example/place/1', placeId: 'private-place-id', duration: 60, lat: 25, lng: 121 }],
  transportSegments: [], rainBackup: [{ id: 'r1', address: '2 Private Road', googleMapsUrl: 'https://maps.example/place/2', placeId: 'private-rain-place', lat: 25, lng: 121 }], rainTransportSegments: [],
}

test('public plan removes precise coordinates, addresses, and direct place links before sharing', () => {
  const safe = sanitizeSharedPlan(plan)
  assert.equal(safe.stops[0].lat, undefined)
  assert.equal(safe.stops[0].lng, undefined)
  assert.equal(safe.stops[0].address, '')
  assert.equal(safe.stops[0].googleMapsUrl, undefined)
  assert.equal(safe.stops[0].placeId, undefined)
  assert.equal(safe.rainBackup[0].lat, undefined)
  assert.equal(safe.rainBackup[0].lng, undefined)
  assert.equal(safe.rainBackup[0].address, '')
  assert.equal(safe.rainBackup[0].googleMapsUrl, undefined)
  assert.equal(safe.rainBackup[0].placeId, undefined)
})

test('feed validation drops malformed records and duplicate ids', () => {
  const valid = { id: 'share-1', plan, author_display_name: 'Traveler', created_at: '2026-10-21', like_count: 0, comment_count: 0, view_count: 0, liked_by_me: false, reward_awarded: false, is_owner: false, tags: [], input: null }
  const result = deduplicateAndValidateSharedTrips([valid, valid, { id: 'broken', plan: {} }])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'share-1')
})

test('public plan removes original private trip input and origin fields', () => {
  const safe = sanitizeSharedPlan({ ...plan, input: { tags: ['private'] }, origin: { lat: 25, lng: 121 } })
  assert.equal(JSON.stringify(safe).includes('private'), false)
  assert.equal(JSON.stringify(safe).includes('origin'), false)
})
