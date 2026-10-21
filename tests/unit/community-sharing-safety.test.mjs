import test from 'node:test'
import assert from 'node:assert/strict'

import { deduplicateAndValidateSharedTrips, sanitizeSharedPlan } from '../../src/services/community/communityData.js'

const plan = {
  id: 'plan-1', type: 'balanced', title: 'Trip', subtitle: '', summary: '', totalTime: 60,
  budget: 1000, transportMode: 'car', stops: [{ id: 's1', name: 'Cafe', type: 'food', description: '', address: '', duration: 60, lat: 25, lng: 121 }],
  transportSegments: [], rainBackup: [{ id: 'r1', lat: 25, lng: 121 }], rainTransportSegments: [],
}

test('public plan removes precise stop coordinates before sharing', () => {
  const safe = sanitizeSharedPlan(plan)
  assert.equal('lat' in safe.stops[0], false)
  assert.equal('lng' in safe.stops[0], false)
  assert.equal('lat' in safe.rainBackup[0], false)
})

test('feed validation drops malformed records and duplicate ids', () => {
  const valid = { id: 'share-1', plan, author_display_name: 'Traveler', created_at: '2026-10-21', like_count: 0, comment_count: 0, view_count: 0, liked_by_me: false, reward_awarded: false, is_owner: false, tags: [], input: null }
  const result = deduplicateAndValidateSharedTrips([valid, valid, { id: 'broken', plan: {} }])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'share-1')
})
