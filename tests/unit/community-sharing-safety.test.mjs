import test from 'node:test'
import assert from 'node:assert/strict'

import { deduplicateAndValidateSharedTrips, getSharedPlanSignature, isShareablePlan, sanitizeSharedPlan } from '../../src/services/community/communityData.js'
import { loadPlanForDetail, savePlanForDetail } from '../../src/utils/tripPlanStorage.js'

const plan = {
  id: 'plan-1', type: 'balanced', title: 'Trip', subtitle: '', summary: '', totalTime: 60,
  budget: 1000, transportMode: 'car', stops: [{ id: 's1', name: 'Cafe', type: 'food', description: '', address: '1 Private Road', googleMapsUrl: 'https://maps.example/place/1', placeId: 'private-place-id', duration: 60, lat: 25, lng: 121 }],
  transportSegments: [], rainBackup: [{ id: 'r1', address: '2 Private Road', googleMapsUrl: 'https://maps.example/place/2', placeId: 'private-rain-place', lat: 25, lng: 121 }], rainTransportSegments: [],
}

test('public plan uses an explicit allowlist and removes private coordinates, text, and unknown fields', () => {
  const safe = sanitizeSharedPlan({ ...plan, privatePreference: 'secret', summary: 'private profile', stops: [{ ...plan.stops[0], description: 'my private note', secret: 'hidden' }] })
  assert.equal(safe.stops[0].lat, undefined)
  assert.equal(safe.stops[0].lng, undefined)
  assert.equal(safe.stops[0].address, '')
  assert.equal(safe.stops[0].googleMapsUrl, undefined)
  assert.equal(safe.stops[0].placeId, undefined)
  assert.equal(safe.stops[0].description, '')
  assert.equal('secret' in safe.stops[0], false)
  assert.equal('privatePreference' in safe, false)
  assert.equal(safe.summary, '')
  assert.equal(safe.rainBackup[0].lat, undefined)
  assert.equal(safe.rainBackup[0].lng, undefined)
  assert.equal(safe.rainBackup[0].address, '')
  assert.equal(safe.rainBackup[0].googleMapsUrl, undefined)
  assert.equal(safe.rainBackup[0].placeId, undefined)
})

test('feed validation drops malformed records and duplicate ids', () => {
  const valid = { id: 'share-1', plan: { ...plan, isDetailComplete: true, rainBackup: [{ id: 'r1', name: 'Rainy Cafe', type: 'food', duration: 30 }] }, author_display_name: 'Traveler', created_at: '2026-10-21', like_count: 0, comment_count: 0, view_count: 0, liked_by_me: false, reward_awarded: false, is_owner: false, tags: [], input: null, privateExtra: 'must not survive' }
  const result = deduplicateAndValidateSharedTrips([valid, valid, { id: 'broken', plan: {} }])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'share-1')
  assert.equal('privateExtra' in result[0], false)
  assert.equal(result[0].input, null)
})

test('feed rejects malformed optional googleTypes instead of throwing', () => {
  const baseRow = { id: 'share-types', plan: { ...plan, isDetailComplete: true, rainBackup: [{ id: 'rain', name: 'Rain', type: 'food', duration: 30 }] }, author_display_name: 'Traveler', created_at: '2026-10-21', like_count: 0, comment_count: 0, view_count: 0, tags: [] }
  assert.deepEqual(deduplicateAndValidateSharedTrips([{ ...baseRow, plan: { ...baseRow.plan, stops: [{ ...baseRow.plan.stops[0], googleTypes: { unexpected: true } }] } }]), [])
  assert.equal(deduplicateAndValidateSharedTrips([{ ...baseRow, plan: { ...baseRow.plan, stops: [{ ...baseRow.plan.stops[0], googleTypes: ['cafe'] }] } }]).length, 1)
})

test('public plan keeps validated transit segment timing', () => {
  const twoStopPlan = {
    ...plan,
    stops: [plan.stops[0], { ...plan.stops[0], id: 's2', name: 'Park' }],
    rainBackup: [{ id: 'rain', name: 'Rain', type: 'food', duration: 30 }],
    transportSegments: [{ fromStopId: 's1', toStopId: 's2', mode: 'car', duration: 17, label: 'Driving' }],
  }
  const safe = sanitizeSharedPlan(twoStopPlan)
  assert.deepEqual(safe.transportSegments, [{ fromStopId: 'shared-main-1', toStopId: 'shared-main-2', mode: 'car', publicTransitType: undefined, duration: 17, label: '開車' }])
  assert.equal(isShareablePlan({ ...twoStopPlan, isDetailComplete: true }), true)
  assert.equal(isShareablePlan({ ...twoStopPlan, isDetailComplete: true, transportSegments: [{ mode: 'car', duration: 17 }] }), false)
})

test('public plan removes original private trip input and origin fields', () => {
  const safe = sanitizeSharedPlan({ ...plan, input: { tags: ['private'] }, origin: { lat: 25, lng: 121 } })
  assert.equal(JSON.stringify(safe).includes('private'), false)
  assert.equal(JSON.stringify(safe).includes('origin'), false)
})

test('public plan bounds stop arrays and rebuilds internal ids', () => {
  const safe = sanitizeSharedPlan({ ...plan, stops: Array.from({ length: 35 }, (_, index) => ({ ...plan.stops[0], id: `raw-${index}`, duration: 2000 })) })
  assert.equal(safe.stops.length, 30)
  assert.equal(safe.stops[0].id, 'shared-main-1')
  assert.equal(safe.stops[0].duration, 1440)
})

test('share signatures ignore private details and sanitization is idempotent', () => {
  const privateVariant = { ...plan, stops: [{ ...plan.stops[0], lat: 24, lng: 120, address: 'Private address', description: 'Preference note' }] }
  const publicVariant = { ...plan, stops: [{ ...plan.stops[0], lat: 25, lng: 121, address: 'Other address', description: 'Other note' }] }
  assert.equal(getSharedPlanSignature(privateVariant), getSharedPlanSignature(publicVariant))
  assert.deepEqual(sanitizeSharedPlan(sanitizeSharedPlan(privateVariant)), sanitizeSharedPlan(privateVariant))
})

test('only completed plans with required bounded fields can be shared', () => {
  const completed = { ...plan, isDetailComplete: true, rainBackup: [{ id: 'rain-1', name: 'Rainy Cafe', type: 'food', duration: 45 }] }
  assert.equal(isShareablePlan(completed), true)
  assert.equal(isShareablePlan({ ...completed, isDetailComplete: false }), false)
  assert.equal(isShareablePlan({ ...completed, title: ' ' }), false)
  assert.equal(isShareablePlan({ ...completed, stops: [] }), false)
  assert.equal(isShareablePlan({ ...completed, stops: [{ ...plan.stops[0], duration: Number.NaN }] }), false)
})

test('shared detail cache is keyed by both share id and plan id', () => {
  const originalStorage = globalThis.sessionStorage
  const values = new Map()
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
  }
  try {
    savePlanForDetail({ ...plan, title: 'Share A' }, null, 'share-a')
    savePlanForDetail({ ...plan, title: 'Share B' }, null, 'share-b')
    assert.equal(loadPlanForDetail('plan-1', 'share-a')?.title, 'Share A')
    assert.equal(loadPlanForDetail('plan-1', 'share-b')?.title, 'Share B')
    assert.equal(loadPlanForDetail('different-plan-id', 'share-a'), null)
  } finally {
    if (originalStorage === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = originalStorage
  }
})
