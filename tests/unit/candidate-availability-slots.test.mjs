import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { writeFileSync } from 'node:fs'
import { classificationInput, classificationPlace, snapshotAvailable, savedClassificationPipelines,
  placesFromSavedCandidates } from './fixtures/candidate-classification.mjs'
import { mockQuotaSearch, quotaFixture, quotaSummary } from './fixtures/candidate-quota-consistency.mjs'
import { mockIntegrationNetwork } from './fixtures/candidate-classification-integration.mjs'
import { getRequiredAvailabilitySlotForStop } from '../../api/_lib/trip-timeline.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/_lib/google-places.ts')
const delivery = await import('../../api/generate-trip.ts')
const original = execFileSync('git', ['show', '2605e17e:api/_lib/google-places.ts'],
  { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
const source = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
  const url = specifier.startsWith('.')
    ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../api/_lib/google-places.ts', import.meta.url)).href
    : specifier
  return `from ${quote}${url}${quote}`
})
const before = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const observations = []

// Explicit dated opening periods, including next-day minutes. Each window must
// support the entire visit on its own; a sum across closed gaps is never valid.
function periods(...ranges) {
  const point = minutes => ({ day: Math.floor(minutes / 1440) % 7,
    hour: Math.floor(minutes % 1440 / 60), minute: minutes % 60,
    date: { year: 2026, month: 10, day: 4 + Math.floor(minutes / 1440) } })
  return { periods: ranges.map(([open, close]) => ({ open: point(open), close: point(close) })) }
}

function place(id, types = ['restaurant', 'food'], hours, distanceKm = 1) {
  const name = types.includes('museum') ? `${id}博物館` : types.includes('park') ? `${id}公園` : `${id}餐廳`
  return classificationPlace(id, name, types, '高雄市文化路1號', {
    ...(hours ? { currentOpeningHours: hours } : {}),
    location: { latitude: 22.6 + distanceKm / 111.19492664455873, longitude: 120.3 },
  })
}

async function compare(t, kind, places, overrides = {}) {
  const input = classificationInput({ startTime: '10:00', endTime: '12:00', ...overrides })
  const requests = mockQuotaSearch(t, places)
  const oldPool = await before.getNearbyPlaceCandidates({ input })
  const oldRequests = requests.splice(0)
  const newPool = await after.getNearbyPlaceCandidates({ input })
  assert.deepEqual(requests, oldRequests, 'slot correction adds no search query or paid field')
  const facts = pool => pool.allCandidates.map(({ score, availabilitySlots, ...candidate }) => candidate)
    .sort((a, b) => a.placeId.localeCompare(b.placeId))
  assert.deepEqual(facts(newPool), facts(oldPool), 'whole-trip legality, identity and classification stay unchanged')
  assert.deepEqual(newPool.firstStopCandidates.map(c => c.placeId).sort(), oldPool.firstStopCandidates.map(c => c.placeId).sort())
  for (const c of newPool.allCandidates) {
    const old = oldPool.allCandidates.find(p => p.placeId === c.placeId)
    const slotBonus = slots => slots.length ? slots.length * 2 : 4
    assert.ok(Math.abs(c.score - old.score - slotBonus(c.availabilitySlots) + slotBonus(old.availabilitySlots)) < 1e-6,
      'only the existing slot bonus may change the score')
  }
  const row = { kind, input, searchCalls: [oldRequests.length, requests.length],
    before: quotaSummary(before, oldPool, input), after: quotaSummary(after, newPool, input),
    slots: newPool.allCandidates.map(c => ({ placeId: c.placeId,
      before: oldPool.allCandidates.find(p => p.placeId === c.placeId).availabilitySlots, after: c.availabilitySlots })) }
  observations.push(row)
  t.diagnostic(JSON.stringify({ kind, prompt: [row.before.promptCount, row.after.promptCount],
    uses: [row.before.uses, row.after.uses], searches: row.searchCalls, slots: row.slots }))
  return { input, oldPool, newPool, row, selection: after.getPromptCandidateSelection(newPool) }
}

for (const tags of [[], ['food_first']]) {
  test(`availability regression: 120 minutes with 40-minute slots retains legal 45-minute food, tags=${tags}`, async t => {
    const r = await compare(t, `short-food-${tags}`, [place('short-food')], { tags })
    assert.deepEqual(r.oldPool.allCandidates[0].availabilitySlots, [])
    assert.equal(r.row.before.promptCount, 0)
    assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early', 'middle'])
    assert.equal(r.row.after.promptCount, 1)
    assert.equal(r.newPool.allCandidates[0].score, r.oldPool.allCandidates[0].score)
    assert.match(after.formatNearbyRecommendations(r.newPool), /role=food.*bestSlots="early,middle"/)
  })
}

test('availability regression: a continuous visit may cross a slot boundary without crossing a closing gap', async t => {
  const r = await compare(t, 'continuous-cross-slot', [place('continuous', ['restaurant', 'food'], periods([630, 705]))])
  assert.deepEqual(r.oldPool.allCandidates[0].availabilitySlots, [])
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early'])
  assert.equal(after.isCandidateOpenForVisit(r.newPool.allCandidates[0], 630, 45), true)
  assert.equal(after.isCandidateOpenForVisit(r.newPool.allCandidates[0], 631, 45), false)
})

test('availability regression: a 60-minute activity trip retains the unchanged 40-minute minimum', async t => {
  const r = await compare(t, 'short-activity', [place('short-activity', ['museum'])], { endTime: '11:00' })
  assert.deepEqual(r.oldPool.allCandidates[0].availabilitySlots, [])
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early'])
  assert.equal(r.row.after.promptCount, 1)
})

test('three-hour continuous food control keeps all slots, score and Prompt', async t => {
  const r = await compare(t, 'three-hour-control', [place('three-hour')], { endTime: '13:00' })
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early', 'middle', 'late'])
  assert.deepEqual(r.row.after, r.row.before)
})

test('a 40-minute whole trip admits a 40-minute activity but cannot admit 45-minute food', async t => {
  const r = await compare(t, 'shortest-minimum', [place('minimum-activity', ['park']), place('minimum-food')], { endTime: '10:40' })
  assert.deepEqual(r.newPool.allCandidates.map(c => c.placeId), ['minimum-activity'])
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early'])
  assert.equal(r.row.before.promptCount, 0)
  assert.equal(r.row.after.promptCount, 1)
})

test('unknown opening hours and never-open venues cannot gain slots or Prompt eligibility', async t => {
  const unknown = place('unknown-hours')
  unknown.currentOpeningHours = undefined
  const r = await compare(t, 'unknown-hours', [unknown, place('never-open', ['restaurant'], { periods: [] })])
  assert.equal(r.newPool.allCandidates.length, 0)
  assert.equal(r.row.after.promptCount, 0)
})

test('whole-trip and closing-buffer limits reject only-40-minute food, but retain legal 40-minute activity', async t => {
  const hours = periods([680, 780])
  const r = await compare(t, 'minimum-boundaries', [place('food-40', ['restaurant'], hours),
    place('activity-40', ['museum'], hours), place('activity-39', ['museum'], periods([681, 780])),
    place('food-44', ['restaurant'], periods([600, 674])),
    place('food-45', ['restaurant'], periods([600, 675]))])
  assert.deepEqual(r.newPool.allCandidates.map(c => c.placeId).sort(), ['activity-40', 'food-45'])
  assert.deepEqual(r.newPool.allCandidates.find(c => c.placeId === 'activity-40').availabilitySlots, ['late'])
  const food = r.newPool.allCandidates.find(c => c.placeId === 'food-45')
  assert.deepEqual(food.availabilitySlots, ['early'])
  assert.equal(after.isCandidateOpenForVisit(food, 600, 45), true)
  assert.equal(after.isCandidateOpenForVisit(food, 601, 45), false)
  assert.equal(after.isCandidateOpenForVisit(food, 600, 46), false)
})

test('disjoint opening windows are never added together to meet a minimum visit', async t => {
  const r = await compare(t, 'disjoint', [place('split-food', ['restaurant'], periods([600, 665], [670, 735])),
    place('split-activity', ['museum'], periods([600, 665], [670, 735]))])
  assert.equal(r.newPool.allCandidates.length, 0)
  assert.equal(r.row.after.promptCount, 0)
})

test('a valid reopened window supports a cross-slot visit without using the earlier short period', async t => {
  const r = await compare(t, 'reopened', [place('reopened', ['restaurant'], periods([600, 665], [670, 745]))])
  const c = r.newPool.allCandidates[0]
  assert.deepEqual(c.availabilitySlots, ['middle'])
  assert.equal(after.isCandidateOpenForVisit(c, 600, 45), false)
  assert.equal(after.isCandidateOpenForVisit(c, 670, 45), true)
  assert.equal(after.isCandidateOpenForVisit(c, 671, 45), false)
})

test('slot end is an arrival boundary, not permission to assign an exact middle arrival to early', async t => {
  const r = await compare(t, 'boundary', [place('boundary', ['restaurant'], periods([660, 735]))], { endTime: '13:00' })
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['middle'])
  const stops = [{ type: 'main_activity', duration: 40 }, { type: 'food', duration: 45 }]
  assert.equal(getRequiredAvailabilitySlotForStop(stops, 1, r.input, [{ duration: 20 }]), 'middle')
})

for (const [startTime, endTime] of [['23:00', '01:00'], ['00:30', '02:00'], ['03:00', '05:00']]) {
  test(`short overnight/early-morning food is usable at its actual date: ${startTime}-${endTime}`, async t => {
    const r = await compare(t, `night-${startTime}`, [place(`night-${startTime}`)], { startTime, endTime })
    assert.deepEqual(r.oldPool.allCandidates[0].availabilitySlots, [])
    assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early', 'middle'])
    assert.equal(r.row.after.promptCount, 1)
  })
}

test('cross-midnight period keeps buffer and trip-end limits on the next day', async t => {
  const r = await compare(t, 'midnight-window', [place('midnight-window', ['restaurant'], periods([1410, 1485])),
    place('midnight-too-short', ['restaurant'], periods([1475, 1560]))], { startTime: '23:00', endTime: '01:00' })
  assert.equal(r.newPool.allCandidates.length, 1)
  const c = r.newPool.allCandidates[0]
  assert.deepEqual(c.availabilitySlots, ['early'])
  assert.equal(after.isCandidateOpenForVisit(c, 1410, 45), true)
  assert.equal(after.isCandidateOpenForVisit(c, 1411, 45), false)
})

test('long dawn active-start adjustment and short dawn control keep their existing timelines', async t => {
  const r = await compare(t, 'active-dawn', [place('dawn-food'),
    place('dawn-closed', ['restaurant'], periods([180, 360]))], { startTime: '03:00', endTime: '08:00' })
  assert.equal(r.newPool.allCandidates.length, 1)
  assert.deepEqual(r.newPool.allCandidates[0].availabilitySlots, ['early', 'middle'])
})

test('sparse suburban candidate gains Prompt eligibility without becoming a first stop', async t => {
  const r = await compare(t, 'suburb', [place('far-food', ['restaurant'], undefined, 8)])
  assert.equal(r.newPool.firstStopCandidates.length, 0)
  assert.equal(r.row.before.promptCount, 0)
  assert.equal(r.row.after.promptCount, 1)
  assert.equal(r.selection.foodStops.length, 1)
})

test('preserved sparse deep-night fixture now includes legitimate food alongside cultural choices', async t => {
  const f = quotaFixture('night-short')
  const r = await compare(t, 'prior-night-short', f.places, f.input)
  assert.deepEqual(r.row.before.uses, { confirmedCulture: 5, food: 0, other: 0 })
  assert.deepEqual(r.row.after.uses, { confirmedCulture: 5, food: 3, other: 0 })
  assert.equal(r.row.after.promptCount, 8)
  assert.equal(r.newPool.firstStopCandidates.length, 3)
  assert.ok(r.newPool.allCandidates.filter(c => c.role === 'food').every(c =>
    JSON.stringify(c.availabilitySlots) === JSON.stringify(['early', 'middle'])))
})

test('actual saved Central Park pipeline keeps legal candidates and measures changed arrival hints and ranking', {
  skip: !snapshotAvailable() && 'Optional preserved investigation snapshot unavailable',
}, async t => {
  const snapshot = savedClassificationPipelines().find(p => p.city === '高雄')
  const r = await compare(t, 'saved-central-park', placesFromSavedCandidates(snapshot.candidates), snapshot.input)
  assert.equal(r.newPool.allCandidates.length, 93)
  assert.equal(r.newPool.firstStopCandidates.length, 19)
  assert.equal(r.row.before.promptCount, 42)
  assert.equal(r.row.after.promptCount, 42)
  assert.deepEqual(r.row.after.uses, r.row.before.uses)
  assert.deepEqual(r.row.searchCalls, [6, 6])
})

test('Prompt eligibility does not bypass exact arrival, transport, closing buffer or final delivery checks', async t => {
  const input = classificationInput({ startTime: '11:00', endTime: '13:00' })
  const anchor = place('validation-anchor', ['museum'])
  const food = place('validation-food', ['restaurant'], periods([660, 780]))
  const calls = mockIntegrationNetwork(t, { rawPlaces: [anchor, food] })
  const pool = await after.getNearbyPlaceCandidates({ input })
  assert.equal(after.getPromptCandidateSelection(pool).promptCandidates.length, 2)
  const makeStop = (p, type, duration) => ({ id: p.id, placeId: p.id, name: p.displayName.text,
    address: p.formattedAddress, type, duration, description: '' })
  const grounded = delivery.applyCandidateGroundingToPlan({ id: 'explore', type: 'explore',
    stops: [makeStop(anchor, 'main_activity', 40), makeStop(food, 'food', 45)], rainBackup: [],
    transportSegments: [{ fromStopId: anchor.id, toStopId: food.id, duration: 5, mode: 'scooter' }] }, pool)
  assert.deepEqual(await after.validatePlanOpeningHours(grounded, input), [])
  assert.deepEqual(await delivery.getDeliveryPlanIssues(grounded, input, 'availability', { candidates: pool }), [])
  const late = structuredClone(grounded)
  late.transportSegments[0].duration = 6
  assert.ok((await after.validatePlanOpeningHours(late, input)).some(i => i.stopId === food.id))
  assert.ok((await delivery.getDeliveryPlanIssues(late, input, 'availability-late', { candidates: pool })).length)
  const overflow = structuredClone(grounded)
  overflow.transportSegments[0].duration = 40
  assert.ok((await delivery.getDeliveryPlanIssues(overflow, input, 'availability-overflow', { candidates: pool }))
    .some(issue => issue.includes('超出可安排時間')), 'transport plus unchanged minimum visits cannot exceed the trip')
  assert.equal(calls.routes.length, 0)
  assert.equal(calls.details.length, 0, 'unchanged final hours checks reuse Places records already cached by search')
})

test.after(() => {
  if (process.env.AVAILABILITY_AUDIT_OUTPUT) writeFileSync(process.env.AVAILABILITY_AUDIT_OUTPUT,
    JSON.stringify({ baseline: '2605e17e', evidence: 'Fixed dated Places mocks; actual search, score, selector, formatter and validation',
      observations }, null, 2) + '\n')
})
