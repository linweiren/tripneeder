import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dFixture, createDReplay } from './fixtures/context-aware-search-d.mjs'
import { searchFixture, loadSearchBaseline } from './fixtures/context-aware-search.mjs'
import { rankingProfiles } from './fixtures/context-aware-ranking.mjs'
import { classificationPlace } from './fixtures/candidate-classification.mjs'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const before = await loadSearchBaseline()
const after = await import('../../api/_lib/google-places.ts')
const observations = []
const rawCity = searchFixture.places.city
const city = intent => dFixture.cases.find(row => row.id === `${intent}-success`)
const cultureQuery = 'fixture 博物館 美術館 museum art gallery'
const activeCulture = () => dFixture.cases.find(r => r.environment === 'activity-loss' && r.intent === 'culture' && r.history === 'none')
const ids = selection => new Set(selection.promptCandidates.map(c => c.placeId))

function compare(base, result, input) {
  const legacy = result.requests.filter(r => r.stage !== 'supplement')
  assert.deepEqual(legacy, base.requests, 'Initial and all mandatory supplement requests/bodies/results remain identical')
  assert.deepEqual(result.plans.filter(p => p.queryLimit !== 1), base.plans)
  assert.ok(result.requests.length <= base.requests.length + 1)
  assert.ok(result.requests.filter(r => r.stage === 'supplement').length <= 1)
  assert.equal(result.costs.length, 1)
  const cost = result.costs[0]
  assert.equal(cost.total, result.requests.length)
  assert.equal(cost.legacyTotal, base.requests.length)
  assert.equal(cost.supplement, result.requests.filter(r => r.stage === 'supplement').length)
  assert.ok(result.requests.every(r => r.mask === searchFixture.fieldMasks[0]))
  const next = new Map(result.facts.map(c => [c.placeId, c]))
  for (const c of base.facts) assert.deepEqual(next.get(c.placeId), c, 'Existing legal IDs, scores, classification and slots are preserved')
  const selection = after.getPromptCandidateSelection(result.pool)
  assert.ok(selection.nearStops.every(c => c.distanceKm <= 2))
  assert.ok(selection.nearStops.length <= 12 && selection.foodStops.length <= 12 && selection.mainStops.length <= 18)
  assert.equal(ids(selection).size, selection.promptCandidates.length)
  assert.ok(selection.promptCandidates.every(c => c.openingHours?.isKnown && !c.openingHours.isNeverOpen && c.availabilitySlots.length))
  if (cost.supplementDecision !== 'accepted') {
    assert.deepEqual(result.facts, base.facts)
    assert.deepEqual(result.summary, base.summary, 'Rejected/skipped probe preserves the exact original Prompt')
    assert.equal(result.pools.at(-1)?.usableCandidateCount, base.pools.at(-1)?.usableCandidateCount)
  } else {
    const query = result.requests.find(r => r.stage === 'supplement').body.textQuery
    const matchesOwner = query.includes('museum art gallery') ? after.hasConfirmedCulturalPrimaryPurpose
      : query.includes('咖啡廳') ? c => c.role === 'food' && c.foodSubtype === 'cafe' : c => c.role === 'open_space'
    for (const c of before.getPromptCandidateSelection(base.pool).promptCandidates) {
      if (['main_activity', 'open_space', 'shopping'].includes(c.role) && !matchesOwner(c) ||
        c.role === 'food' && (getMealSuitability(c) === 'meal_likely' || input.tags.includes('food_first'))) {
        assert.ok(ids(selection).has(c.placeId), `Protected original Prompt candidate retained: ${c.placeId}`)
      }
    }
  }
  const oldDebug = new Map(base.pools.at(-1)?.candidates.map(c => [c.placeId, c]) ?? [])
  for (const c of result.pools.at(-1)?.candidates ?? []) {
    if (oldDebug.has(c.placeId)) assert.deepEqual(c.personalization, oldDebug.get(c.placeId).personalization)
  }
  return cost
}

test('Search D: all 169 fixed design cases run through original collection, ranking and Prompt', async t => {
  assert.equal(dFixture.cases.length, 169)
  for (const row of dFixture.cases) await t.test(row.id, async sub => {
    const replay = createDReplay(sub, row), profile = rankingProfiles()[row.history ?? 'none']
    const base = await replay(before, profile), result = await replay(after, profile)
    assert.deepEqual(base.facts, row.expected.facts.map(i => dFixture.facts[i]))
    assert.equal(base.requests.length, row.expected.summary.totalCalls)
    assert.deepEqual(base.requests, row.expected.requests.map(r => ({ stage: r.stage, body: dFixture.bodies[r.bodyRef],
      mask: dFixture.masks[r.maskRef], ids: r.ids })))
    const cost = compare(base, result, row.input)
    observations.push({ id: row.id, environment: row.environment, intent: row.intent, history: row.history,
      input: row.input, before: { summary: base.summary, facts: base.facts, requests: base.requests },
      after: { summary: result.summary, facts: result.facts, requests: result.requests, cost } })
  })
})

test('Search D: already visible comparable themes are sufficient; do not buy 2→12 or 8→16 by default', async t => {
  for (const intent of ['culture', 'coffee', 'outdoor']) await t.test(intent, async sub => {
    const result = await createDReplay(sub, city(intent))(after)
    assert.equal(result.costs[0].supplementDecision, 'already_covered')
    assert.equal(result.requests.length, 5)
  })
})

test('Search D: culture gap adds one useful venue while retaining all 12 existing activity representatives and meals', async t => {
  for (const history of ['none', 'coffee']) await t.test(history, async sub => {
    const row = activeCulture(), replay = createDReplay(sub, row), profile = rankingProfiles()[history]
    const base = await replay(before, profile), result = await replay(after, profile)
    compare(base, result, row.input)
    assert.equal(result.costs[0].supplementDecision, 'accepted')
    assert.equal(result.requests.length, 6)
    assert.equal(result.summary.poolUses.culture, 1)
    assert.equal(result.summary.promptUses.culture, 1)
    assert.equal(result.summary.promptUses.activity, 13)
    const selected = ids(after.getPromptCandidateSelection(result.pool))
    assert.ok(Array.from({ length: 12 }, (_, i) => `unique${i}`).every(id => selected.has(id)))
    assert.equal(result.summary.promptUses.mealLikely, base.summary.promptUses.mealLikely)
  })
})

test('Search D: actual missing-theme queries reject empty, wrong, illegal, low-quality, HTTP error and timeout results', async t => {
  for (const [name, raw, error, httpFailure] of [
    ['empty', []], ['wrong', [rawCity.meal0]], ['illegal', [rawCity['bad-hours'], rawCity['bad-closed']]],
    ['low-quality', [{ ...rawCity.culture0, rating: 1, location: { latitude: 22.636, longitude: 120.3 } }]],
    ['far', [{ ...rawCity.culture0, location: { latitude: 22.672, longitude: 120.3 } }]],
    ['timeout', [], true], ['http-503', [], false, true],
  ]) await t.test(name, async sub => {
    const row = { ...activeCulture(), id: `active-${name}`, overrides: { [cultureQuery]: raw }, supplementError: error, httpFailure }
    const replay = createDReplay(sub, row), base = await replay(before), result = await replay(after)
    compare(base, result, row.input)
    assert.equal(result.requests.length, 6)
    assert.notEqual(result.costs[0].supplementDecision, 'accepted')
    assert.deepEqual(result.summary, base.summary)
  })
})

test('Search D: mixed missing cafe bulk would displace valuable activities and is rejected', async t => {
  const row = dFixture.cases.find(r => r.id === 'mixed-coffee-empty'), replay = createDReplay(t, row)
  const base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  assert.equal(result.requests.length, 6)
  assert.equal(result.requests.at(-1).body.textQuery, '咖啡廳 cafe')
  assert.equal(result.costs[0].supplementDecision, 'shortlist_not_improved_or_protected_candidates_lost')
  assert.deepEqual(result.summary.groups, base.summary.groups)
})

test('Search D: mixed missing cafe can accept a useful non-displacing supplement', async t => {
  const row = { ...dFixture.cases.find(r => r.id === 'mixed-coffee-empty'), overrides: {
    '咖啡廳 甜點店 cafe dessert': [], '咖啡廳 cafe': [rawCity.newcafe0],
  } }, replay = createDReplay(t, row)
  const base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  assert.equal(result.summary.promptUses.cafe, 1)
  assert.equal(result.summary.promptUses.culture, base.summary.promptUses.culture)
  assert.equal(result.summary.promptUses.activity, base.summary.promptUses.activity)
  assert.equal(result.requests.length, 6)
})

test('Search D: coffee and outdoor gaps accept a quality option without losing other activity or dining IDs', async t => {
  for (const [intent, oldQuery, query, candidate, use] of [
    ['coffee', '咖啡廳 甜點店 cafe dessert', '咖啡廳 cafe', rawCity.newcafe0, 'cafe'],
    ['outdoor', '公園 戶外休閒 parks outdoor', '公園 步道 park trail', rawCity.newpark0, 'outdoor'],
  ]) await t.test(intent, async sub => {
    const baselinePlaces = [...Array.from({ length: 12 }, (_, i) => classificationPlace(`coffee-main-${i}`,
      `地方書店${i}`, ['book_store'], '測試路1號', { location: { latitude: 22.627, longitude: 120.3 } })),
      ...Array.from({ length: 8 }, (_, i) => rawCity[`meal${i}`])]
    const row = { ...city(intent), overrides: { [oldQuery]: [], [query]: [candidate] },
      ...(intent === 'coffee' ? { responder: body => body.textQuery === query ? [candidate] : baselinePlaces } : {}) }
    const replay = createDReplay(sub, row), base = await replay(before), result = await replay(after)
    compare(base, result, row.input)
    assert.equal(base.summary.promptUses[use], 0)
    assert.equal(result.summary.promptUses[use], 1)
    assert.equal(result.requests.length, 6)
    assert.equal(result.costs[0].supplementDecision, 'accepted')
    const selected = ids(after.getPromptCandidateSelection(result.pool))
    const oldSelection = before.getPromptCandidateSelection(base.pool)
    assert.ok(oldSelection.promptCandidates.filter(c => ['main_activity', 'open_space', 'shopping'].includes(c.role))
      .every(c => selected.has(c.placeId)))
    assert.equal(result.summary.promptUses.mealLikely, base.summary.promptUses.mealLikely)
    observations.push({ id: `focused-${intent}-gap`, before: { summary: base.summary, requests: base.requests },
      after: { summary: result.summary, requests: result.requests, cost: result.costs[0] } })
  })
})

test('Search D: even one cafe is rejected when Prompt trimming would lose an existing main activity', async t => {
  const row = { ...city('coffee'), overrides: { '咖啡廳 甜點店 cafe dessert': [], '咖啡廳 cafe': [rawCity.newcafe0] } }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  assert.equal(result.costs[0].supplementDecision, 'shortlist_not_improved_or_protected_candidates_lost')
  assert.equal(result.requests.length, base.requests.length + 1)
  assert.deepEqual(result.summary, base.summary)
})

test('Search D: a poor existing theme option does not suppress a useful comparable replacement', async t => {
  const weak = { ...rawCity.culture0, rating: 1, location: { latitude: 22.636, longitude: 120.3 } }
  const row = { ...activeCulture(), overrides: { 'fixture attractions': [weak, ...Array.from({ length: 12 }, (_, i) =>
    classificationPlace(`weak-reference-${i}`, `地方書店${i}`, ['book_store'], '測試路1號'))],
  [cultureQuery]: [rawCity.culture1] } }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  assert.equal(base.summary.promptUses.culture, 1)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  assert.equal(result.requests.length, base.requests.length + 1)
  assert.ok(after.getPromptCandidateSelection(result.pool).promptCandidates.some(c => c.placeId === 'culture1'))
})

test('Search D: accepted candidate survives original grounding, separate lunch and final validation', async t => {
  const row = { ...activeCulture(), input: { ...activeCulture().input, startTime: '11:00', endTime: '13:30' } }
  const result = await createDReplay(t, row)(after)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  const selection = after.getPromptCandidateSelection(result.pool)
  const culture = selection.promptCandidates.find(c => after.hasConfirmedCulturalPrimaryPurpose(c))
  const restaurant = selection.promptCandidates.find(c => c.role === 'food' && c.foodSubtype === 'restaurant')
  assert.ok(culture && restaurant)
  const delivery = await import('../../api/generate-trip.ts')
  const asStop = c => ({ id: c.placeId, placeId: c.placeId, name: c.name, address: c.address, type: 'food', duration: 45, description: '' })
  const plan = delivery.applyCandidateGroundingToPlan({ id: 'safe', type: 'safe', stops: [asStop(culture), asStop(restaurant)],
    rainBackup: [], transportSegments: [{ fromStopId: culture.placeId, toStopId: restaurant.placeId, duration: 5, mode: 'scooter' }] }, result.pool)
  assert.equal(plan.stops[0].type, 'main_activity')
  assert.deepEqual(await delivery.getDeliveryPlanIssues(plan, row.input, 'search-d-accepted-lunch', { candidates: result.pool }), [])
})

test('Search D: rejected/duplicate probe cannot corrupt a baseline place in the shared Details cache', async t => {
  const row = { ...activeCulture(), overrides: { [cultureQuery]: [{ ...rawCity.meal0, currentOpeningHours: undefined }] } }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  const meal = result.pool.allCandidates.find(c => c.placeId === 'meal0')
  const validated = await after.validateStopsWithPlaces({ id: 'safe', type: 'safe', stops: [{ id: 'meal', placeId: meal.placeId,
    name: meal.name, address: meal.address, type: 'food', duration: 45 }], transportSegments: [] }, row.input.location)
  assert.equal(validated.invalidCount, 0)
})

test('Search D: near-24 legacy path is not truncated to pay for a probe', async t => {
  const far = Array.from({ length: 12 }, (_, i) => classificationPlace(`far-main-${i}`, `地方書店${i}`, ['book_store'], '測試路1號', {
    location: { latitude: 22.627, longitude: 120.3 },
  }))
  const meals = Array.from({ length: 6 }, (_, i) => ({ ...rawCity[`meal${i}`], id: `far-meal-${i}`,
    location: { latitude: 22.627, longitude: 120.3 } }))
  const anchors = Array.from({ length: 4 }, (_, i) => ({ ...rawCity.cafe0, id: `anchor-${i}` }))
  const row = { ...activeCulture(), input: { ...activeCulture().input, startTime: '17:00', endTime: '20:00', tags: ['indoor_first'] },
    responder: (body, stage) => stage === 'initial' ? [rawCity['bad-hours']]
      : stage === 'supplement' ? [rawCity.culture0] : body.locationBias.circle.radius === 2000 ? anchors : [...far, ...meals] }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  compare(base, result, row.input)
  assert.equal(base.requests.length, 22)
  assert.equal(result.requests.length, 23)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  assert.equal(result.costs[0].firstStop, 5)
  assert.equal(result.costs[0].gap, 11)
  observations.push({ id: 'focused-22-to-23', before: { summary: base.summary, requests: base.requests },
    after: { summary: result.summary, requests: result.requests, cost: result.costs[0] } })
})

test.after(() => {
  if (process.env.CONTEXT_SEARCH_D_AUDIT_OUTPUT) fs.writeFileSync(process.env.CONTEXT_SEARCH_D_AUDIT_OUTPUT,
    JSON.stringify({ baseline: searchFixture.baseline, production: 'Search D; no hard 24 cap', paidPlacesCalls: 0, observations }, null, 2) + '\n')
})
