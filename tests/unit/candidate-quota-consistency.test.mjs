import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { loadQuotaBaseline, quotaFixture, mockQuotaSearch, quotaSummary } from './fixtures/candidate-quota-consistency.mjs'
import { getActivityPurpose } from '../../api/_lib/trip-activity-purpose.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'
import { snapshotAvailable, savedClassificationPipelines, placesFromSavedCandidates } from './fixtures/candidate-classification.mjs'
import { buildPreferenceProfile } from '../../src/services/personalization/preferenceProfile.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/_lib/google-places.ts')
const before = await loadQuotaBaseline()
const delivery = await import('../../api/generate-trip.ts')
const rows = []

async function compare(t, f, { allowSlotCorrections = false } = {}) {
  const requests = mockQuotaSearch(t, f.places)
  const options = { preferenceProfile: f.preferenceProfile }
  const oldPool = await before.getNearbyPlaceCandidates({ input: structuredClone(f.input) }, undefined, options)
  const oldRequests = requests.splice(0)
  const newPool = await after.getNearbyPlaceCandidates({ input: structuredClone(f.input) }, undefined, options)
  if (allowSlotCorrections) {
    const facts = pool => Object.fromEntries(Object.entries(pool).map(([key, list]) => [key,
      list.map(({ availabilitySlots, score, ...c }) => c).sort((a, b) => a.placeId.localeCompare(b.placeId))]))
    assert.deepEqual(facts(newPool), facts(oldPool), 'only availability and its existing score bonus may change')
    const slotBonus = slots => slots.length ? slots.length * 2 : 4
    for (const c of newPool.allCandidates) {
      const old = oldPool.allCandidates.find(p => p.placeId === c.placeId)
      assert.ok(Math.abs(c.score - old.score - slotBonus(c.availabilitySlots) + slotBonus(old.availabilitySlots)) < 1e-6)
    }
  } else assert.deepEqual(newPool, oldPool, 'quota correction must not change candidate facts, roles, scores, ordering or pools')
  assert.deepEqual(requests, oldRequests, 'no extra query, changed search body, field mask or paid request')
  // Compare quota selectors on identical facts when the later availability fix
  // intentionally changes slots. Its pipeline effects have separate regressions.
  const oldSummary = quotaSummary(before, allowSlotCorrections ? newPool : oldPool, f.input)
  const newSummary = quotaSummary(after, newPool, f.input)
  assert.equal(newSummary.aiPromptCharacters - oldSummary.aiPromptCharacters,
    newSummary.promptCharacters - oldSummary.promptCharacters, 'only candidate content changes the actual Prompt size')
  const row = { kind: f.kind, tags: f.input.tags, input: f.input, before: oldSummary, after: newSummary,
    searchCallsBefore: oldRequests.length, searchCallsAfter: requests.length,
    targetBefore: oldSummary.candidates.filter(c => c.placeId.startsWith('mixed-culture-') && c.sent).length,
    targetAfter: newSummary.candidates.filter(c => c.placeId.startsWith('mixed-culture-') && c.sent).length }
  rows.push(row)
  t.diagnostic(JSON.stringify({ kind: row.kind, tags: row.tags, targets: [row.targetBefore, row.targetAfter],
    candidates: [oldSummary.promptCount, newSummary.promptCount], characters: [oldSummary.promptCharacters, newSummary.promptCharacters],
    uses: [oldSummary.uses, newSummary.uses], searches: [row.searchCallsBefore, row.searchCallsAfter] }))
  const selection = after.getPromptCandidateSelection(newPool)
  assert.ok(selection.nearStops.length <= 12 && selection.foodStops.length <= 12 && selection.mainStops.length <= 18)
  assert.ok(newSummary.promptCount <= 42)
  assert.equal(new Set(selection.promptCandidates.map(c => c.placeId)).size, selection.promptCandidates.length)
  return { f, oldPool, newPool, oldSummary, newSummary, row, selection }
}

for (const tags of [[], ['food_first']]) {
  const mode = tags.length ? 'food_first' : 'explore'
  test(`culture quota regression 10→2: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('dense', tags))
    assert.equal(r.row.targetBefore, 2)
    assert.equal(r.row.targetAfter, 10)
    assert.equal(r.oldSummary.promptCount, 36)
    assert.equal(r.newSummary.promptCount, 36)
    assert.equal(r.selection.mainStops.length, 18)
    assert.deepEqual(r.newSummary.groups.nearStops, r.oldSummary.groups.nearStops)
    assert.deepEqual(r.newSummary.groups.foodStops, r.oldSummary.groups.foodStops)
    for (const id of ['mixed-park-0', 'mixed-park-1', 'mixed-mall-0', 'mixed-mall-1', 'mixed-book-0', 'mixed-book-1']) {
      assert.ok(r.selection.promptCandidates.some(c => c.placeId === id), 'existing other-purpose representatives remain available')
    }
  })
  test(`pure culture control keeps ranking and selection: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('dense-pure', tags))
    assert.equal(r.row.targetBefore, 10)
    assert.equal(r.row.targetAfter, 10)
    assert.deepEqual(r.newSummary, r.oldSummary)
  })
  test(`sparse culture quota regression 5→2: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('sparse', tags))
    assert.equal(r.row.targetBefore, 2)
    assert.equal(r.row.targetAfter, 5)
    assert.equal(r.newSummary.promptCount, 8)
    assert.equal(r.newSummary.uses.food, 3)
  })
  test(`sparse pure culture control: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('sparse-pure', tags))
    assert.deepEqual(r.newSummary, r.oldSummary)
    assert.equal(r.row.targetAfter, 5)
  })
  test(`real cafes, restaurants and ambiguous mixed venues keep dining quota: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('dining', tags))
    assert.deepEqual(r.newSummary, r.oldSummary)
    assert.equal(r.selection.foodStops.length, 12)
    assert.equal(r.selection.foodStops.filter(c => c.foodSubtype === 'cafe').length, tags.length ? 6 : 7)
    assert.equal(r.selection.foodStops.filter(c => c.foodSubtype === 'restaurant').length, tags.length ? 6 : 5)
    for (const c of r.newPool.allCandidates.filter(c => c.placeId !== 'first-museum')) {
      assert.equal(c.role, 'food')
      assert.equal(after.hasConfirmedCulturalPrimaryPurpose(c), false)
    }
  })
  test(`first-stop competition is unchanged and culture still competes for 18 main slots: ${mode}`, async t => {
    const r = await compare(t, quotaFixture('city-near', tags))
    assert.deepEqual(r.newSummary.groups.nearStops, r.oldSummary.groups.nearStops)
    assert.deepEqual(r.newSummary.groups.foodStops, r.oldSummary.groups.foodStops)
    assert.equal(r.row.targetBefore, 2)
    assert.equal(r.row.targetAfter, 12)
    assert.ok(r.row.targetAfter < 24, 'do not force all cultural venues into the shortlist')
    assert.equal(r.selection.mainStops.length, 18)
    assert.ok(r.selection.nearStops.every(c => c.distanceKm <= 2))
  })
}

test('address-only cafe subtype cannot impose a cafe quota on confirmed primary culture', async t => {
  const r = await compare(t, quotaFixture('address'))
  assert.equal(r.row.targetBefore, 2)
  assert.equal(r.row.targetAfter, 5)
  assert.ok(r.newPool.allCandidates.filter(c => c.placeId.startsWith('mixed-culture-')).every(c =>
    c.role === 'main_activity' && c.foodSubtype === 'cafe' && c.types.length === 1))
})

test('ancillary bakery/dessert evidence uses the same primary cultural purpose exception', async t => {
  const r = await compare(t, quotaFixture('dessert-culture'))
  assert.equal(r.row.targetBefore, 2)
  assert.equal(r.row.targetAfter, 10)
  assert.ok(r.newPool.allCandidates.filter(c => c.placeId.startsWith('mixed-culture-')).every(c =>
    c.role === 'main_activity' && c.foodSubtype === 'dessert'))
})

test('historical personalization changes neither its score calculation nor the cultural quota exception', async t => {
  const f = quotaFixture('dense')
  f.kind = 'dense-personalized'
  f.preferenceProfile = buildPreferenceProfile(Array.from({ length: 15 }, () => ({
    eventType: 'start_navigation', googleTypes: ['museum'], candidateRole: 'main_activity', stopType: 'main_activity',
  })))
  const r = await compare(t, f)
  assert.equal(r.row.targetBefore, 2)
  assert.equal(r.row.targetAfter, 10)
  assert.ok(r.newPool.allCandidates.filter(c => c.placeId.startsWith('mixed-culture-')).every(c => c.score > 99.4))
})

test('default main_activity with uncertain evidence keeps the existing cafe fallback', async t => {
  const r = await compare(t, quotaFixture('default-main'))
  assert.deepEqual(r.newSummary, r.oldSummary)
  assert.equal(r.row.targetAfter, 2)
  assert.ok(r.newPool.allCandidates.filter(c => c.placeId.startsWith('mixed-culture-')).every(c =>
    c.role === 'main_activity' && !after.hasConfirmedCulturalPrimaryPurpose(c)))
})

for (const kind of ['suburb', 'night', 'night-short']) {
  test(`${kind}: retain distance, opening and slot semantics while fixing culture quota`, async t => {
    const r = await compare(t, quotaFixture(kind), { allowSlotCorrections: kind === 'night-short' })
    assert.equal(r.row.targetBefore, 2)
    assert.equal(r.row.targetAfter, 5)
    assert.ok(!r.selection.nearStops.some(c => c.placeId.startsWith('mixed-culture-')))
    if (kind === 'suburb') assert.ok(r.selection.mainStops.every(c => c.distanceKm > 5 && c.distanceKm <= 10))
    if (kind === 'night-short') {
      assert.equal(r.selection.foodStops.length, 0)
      assert.equal(r.selection.nearStops.length, 3)
      assert.ok(r.newPool.allCandidates.filter(c => c.role === 'food').every(c =>
        JSON.stringify(c.availabilitySlots) === JSON.stringify(['early', 'middle'])))
      assert.equal(r.newSummary.uses.food, 3, 'legal short-night food now arrives through the near pool')
    }
  })
}

test('culture quota exception never admits closed, unknown-hours or insufficient-buffer venues', async t => {
  const r = await compare(t, quotaFixture('illegal'))
  assert.equal(r.row.targetAfter, 5)
  for (const id of ['closed-culture', 'unknown-culture', 'closing-culture']) {
    assert.ok(!r.newPool.allCandidates.some(c => c.placeId === id))
    assert.ok(!r.selection.promptCandidates.some(c => c.placeId === id))
  }
})

test('newly visible culture keeps its purpose through actual Prompt formatter and Grounding, without meal promotion', async t => {
  const r = await compare(t, quotaFixture('dense'))
  const prompt = after.formatNearbyRecommendations(r.newPool)
  const anchor = r.selection.nearStops[0]
  const make = (c, type, duration) => ({ id: c.placeId, name: c.name, address: c.address,
    placeId: c.placeId, type, duration, description: '' })
  const cultures = r.selection.mainStops.filter(c => c.placeId.startsWith('mixed-culture-'))
  assert.equal(cultures.length, 10)
  for (const c of cultures) {
    assert.ok(prompt.split('\n').some(line => line.includes(`placeId="${c.placeId}"`) && line.includes('role=main_activity')))
    const plan = { id: 'explore', type: 'explore', stops: [make(anchor, 'food', 60), make(c, 'main_activity', 75)],
      transportSegments: [], rainBackup: [], rainTransportSegments: [] }
    const grounded = delivery.applyCandidateGroundingToPlan(plan, r.newPool)
    const stop = grounded.stops[1]
    assert.equal(stop.placeId, c.placeId)
    assert.equal(stop.candidateRole, 'main_activity')
    assert.equal(stop.type, 'main_activity')
    assert.equal(stop.duration, 75)
    assert.equal(getActivityPurpose(stop), 'culture')
    assert.deepEqual(stop.googleTypes, c.types)
    assert.equal(stop.foodSubtype, 'cafe')
  }
  const activity = delivery.applyCandidateGroundingToPlan({ id: 'explore', type: 'explore',
    stops: [make(anchor, 'food', 60), make(cultures[0], 'main_activity', 75)],
    transportSegments: [], rainBackup: [], rainTransportSegments: [] }, r.newPool).stops[1]
  const cultureOnly = { id: 'explore', type: 'explore', stops: [activity], transportSegments: [] }
  assert.ok(getRequiredMealCoverageIssues(cultureOnly, r.f.input).length > 0)
  const withMeal = delivery.ensureMealStopForTrip(cultureOnly.stops, r.f.input, r.newPool, new Set([activity.placeId]))
  const meal = withMeal.find(s => s.type === 'food')
  assert.ok(meal)
  assert.ok(!after.hasConfirmedCulturalPrimaryPurpose(r.newPool.allCandidates.find(c => c.placeId === meal.placeId)))
  assert.deepEqual(getRequiredMealCoverageIssues({ ...cultureOnly, stops: withMeal }, r.f.input), [])
})

test('saved Central Park quota selectors stay stable on identical current candidate facts', {
  skip: !snapshotAvailable() && 'Optional preserved investigation snapshot unavailable',
}, async t => {
  const snapshot = savedClassificationPipelines().find(p => p.city === '高雄')
  const r = await compare(t, { kind: 'saved-central-park', input: snapshot.input, places: placesFromSavedCandidates(snapshot.candidates) },
    { allowSlotCorrections: true })
  assert.equal(r.newSummary.promptCount, 42)
  assert.deepEqual(r.newSummary, r.oldSummary)
})

test.after(() => {
  for (const tags of [[], ['food_first']]) {
    const mixed = rows.find(r => r.kind === 'dense' && String(r.tags) === String(tags))
    const pure = rows.find(r => r.kind === 'dense-pure' && String(r.tags) === String(tags))
    if (mixed && pure) {
      const facts = r => r.after.candidates.filter(c => c.placeId.startsWith('mixed-culture-'))
        .map(c => ({ placeId: c.placeId, role: c.role, score: c.score, rank: c.rank }))
      assert.deepEqual(facts(mixed), facts(pure), 'ancillary cafe metadata must not change primary role, score or rank')
      assert.deepEqual(mixed.after.groups, pure.after.groups, 'both controls compete for the same existing places in each block')
    }
  }
  if (process.env.QUOTA_AUDIT_OUTPUT) writeFileSync(process.env.QUOTA_AUDIT_OUTPUT,
    JSON.stringify({ head: '5cf6aaf', evidence: 'Fixed Places mocks, unchanged baseline source; actual score/sort/selector/formatter/Grounding; no live services', rows }, null, 2) + '\n')
})
