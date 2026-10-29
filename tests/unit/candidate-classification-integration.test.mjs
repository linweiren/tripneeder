import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { CULTURE_REPLAYS, integrationFixture, mockIntegrationNetwork, stopObservation } from './fixtures/candidate-classification-integration.mjs'
import { getActivityPurpose, compareOriginalActivities } from '../../api/_lib/trip-activity-purpose.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const places = await import('../../api/_lib/google-places.ts')
const api = await import('../../api/generate-trip.ts')
const observations = []

async function replay(t, kind, tags = [], { style = 'explore', variant = '', crossUsed = new Set() } = {}) {
  const f = integrationFixture(kind, tags, style, variant)
  const calls = mockIntegrationNetwork(t, f)
  const candidates = await places.getNearbyPlaceCandidates({ input: structuredClone(f.input) })
  if (kind === 'bar-default-role') candidates.allCandidates.find(c => c.placeId === f.target.id).role = 'main_activity'
  const candidate = candidates.allCandidates.find(c => c.placeId === f.target.id)
  const selection = places.getPromptCandidateSelection(candidates)
  const grounded = api.applyCandidateGroundingToPlan(structuredClone(f.plan), candidates)
  const validation = await places.validateStopsWithPlaces(grounded, f.input.location, f.input)
  const delivered = await api.repairAndValidatePlanForDelivery(grounded, f.input, candidates,
    new Set(), 'classification-integration', crossUsed)
  const finalIssues = delivered.plan ? await api.getDeliveryPlanIssues(delivered.plan, f.input,
    'classification-integration-final', { candidates }) : delivered.issues
  const targetStopId = f.plan.stops.find(s => s.id.endsWith('-stop-1')).id
  const groundedTarget = grounded.stops.find(s => s.id === targetStopId)
  const finalTarget = delivered.plan?.stops.find(s => s.id === targetStopId)
  const row = { kind, tags, style, candidate: candidate && { role: candidate.role, types: candidate.types,
      foodSubtype: candidate.foodSubtype, mealSuitability: getMealSuitability(candidate) },
    sent: selection.promptCandidates.some(c => c.placeId === f.target.id),
    ai: stopObservation(f.plan.stops.find(s => s.id === targetStopId), getActivityPurpose),
    grounded: stopObservation(groundedTarget, getActivityPurpose),
    final: delivered.plan?.stops.map(s => stopObservation(s, getActivityPurpose)),
    placeIssues: validation.issues, finalIssues, routesFailed: delivered.routesFailed,
    calls: { searches: calls.searches.length, details: calls.details.length, routes: calls.routes.length },
    mealIssues: delivered.plan && getRequiredMealCoverageIssues(delivered.plan, f.input) }
  observations.push(row)
  t.diagnostic(JSON.stringify(row))
  return { f, candidates, candidate, calls, grounded, groundedTarget, validation, delivered, finalTarget, finalIssues, row }
}

function assertDelivered(r) {
  assert.ok(r.delivered.plan, JSON.stringify(r.delivered.issues))
  assert.equal(r.delivered.routesFailed, false)
  assert.deepEqual(r.finalIssues, [])
  assert.deepEqual(r.row.mealIssues, [])
}

for (const tags of [[], ['food_first']]) {
  const mode = tags.length ? 'food_first' : 'explore'
  for (const kind of CULTURE_REPLAYS) {
    test(`previous culture misclassification: ${kind}, ${mode}, Candidate → Grounding → Final`, async t => {
      const r = await replay(t, kind, tags)
      assertDelivered(r)
      assert.equal(r.candidate.role, 'main_activity')
      assert.ok(r.row.sent)
      assert.equal(r.groundedTarget.placeId, r.f.target.id)
      assert.equal(r.groundedTarget.type, 'main_activity')
      assert.equal(r.groundedTarget.duration, 75)
      assert.equal(r.finalTarget.placeId, r.f.target.id)
      assert.equal(r.finalTarget.type, 'main_activity')
      assert.equal(r.finalTarget.duration, 75)
      assert.equal(getActivityPurpose(r.finalTarget), 'culture')
      assert.equal(api.getOriginalActivityImpact(r.grounded, r.delivered.plan.stops).purposeChanges, 0)
      assert.deepEqual(r.finalTarget.googleTypes, r.candidate.types)
      assert.equal(r.finalTarget.foodSubtype, r.candidate.foodSubtype, 'keep ancillary evidence without converting purpose')
      assert.equal(r.delivered.plan.stops.filter(s => s.type === 'food').length, 1)
    })
  }
  for (const kind of ['restaurant', 'cafe', 'dessert', 'bar', 'ambiguous-mixed', 'museum-cafe-business',
    'wrong-id-restaurant-name', 'wrong-id-unsupported-alias']) {
    test(`real or unresolved dining remains food: ${kind}, ${mode}`, async t => {
      const r = await replay(t, kind, tags)
      assertDelivered(r)
      if (kind.startsWith('wrong-id-')) assert.equal(r.groundedTarget.placeId, r.f.meal.id)
      else assert.equal(r.candidate.role, 'food')
      assert.equal(r.groundedTarget.type, 'food')
      assert.equal(r.finalTarget.type, 'food')
      assert.ok(r.groundedTarget.duration >= 45 && r.groundedTarget.duration <= 90)
      assert.equal(r.groundedTarget.duration, ['cafe', 'dessert'].includes(kind) ? 75 : 60)
    })
  }
}

test('a default main_activity role is neither confirmed culture nor a veto of verified bar evidence', async t => {
  const r = await replay(t, 'bar-default-role')
  assertDelivered(r)
  assert.equal(r.candidate.role, 'main_activity')
  assert.equal(r.groundedTarget.type, 'food')
  assert.equal(r.finalTarget.type, 'food')
})

test('an uninformative default activity remains an activity, without invented culture or meal evidence', async t => {
  const r = await replay(t, 'default-main')
  assertDelivered(r)
  assert.equal(r.candidate.role, 'main_activity')
  assert.equal(r.finalTarget.type, 'main_activity')
  assert.equal(getActivityPurpose(r.finalTarget), 'activity')
})

test('AI food intent cannot promote a confirmed museum with ancillary cafe into a meal', async t => {
  const r = await replay(t, 'mixed-ai-food')
  assertDelivered(r)
  assert.equal(r.candidate.role, 'main_activity')
  assert.equal(r.candidate.foodSubtype, 'cafe')
  assert.equal(getMealSuitability(r.candidate), 'uncertain')
  assert.equal(r.groundedTarget.type, 'main_activity')
  assert.equal(r.finalTarget.type, 'main_activity')
  assert.equal(r.delivered.plan.stops.filter(s => s.type === 'food').length, 1)
})

test('a pure museum mislabelled by AI as food returns to cultural activity', async t => {
  const r = await replay(t, 'pure-museum-ai-food')
  assertDelivered(r)
  assert.equal(r.groundedTarget.type, 'main_activity')
  assert.equal(r.finalTarget.type, 'main_activity')
})

test('mixed culture cannot satisfy required meals when there is no separate dining candidate', async t => {
  const r = await replay(t, 'culture-only')
  assert.equal(r.candidate.role, 'main_activity')
  assert.equal(r.groundedTarget.type, 'main_activity')
  assert.ok(!r.delivered.plan || r.row.mealIssues.length)
  assert.ok(r.finalIssues.length)
})

for (const kind of ['closed-culture', 'closing-buffer']) {
  test(`${kind}: retain hours and 30-minute closing buffer with a safe cultural replacement`, async t => {
    const r = await replay(t, kind)
    assertDelivered(r)
    assert.ok(r.validation.issues.some(i => i.placeId === r.f.target.id || i.stopId === r.groundedTarget.id))
    if (kind === 'closing-buffer') {
      const issue = r.validation.issues.find(i => i.stopId === r.groundedTarget.id)
      assert.equal(issue.reason, 'outside_opening_hours')
      assert.equal(issue.leaveTime, '12:49', 'visit would finish before 13:00 closing')
      assert.ok(issue.openingWindows.some(w => w.includes('leaveBy=12:30')), 'the 30-minute buffer still rejects it')
    }
    assert.notEqual(r.finalTarget.placeId, r.f.target.id)
    assert.equal(r.finalTarget.type, 'main_activity')
    assert.equal(getActivityPurpose(r.finalTarget), 'culture')
  })
}

test('far culture is still excluded from first-stop candidates and fails the 2km gate before replacement', async t => {
  const r = await replay(t, 'far-first')
  assertDelivered(r)
  assert.ok(!r.candidates.firstStopCandidates.some(c => c.placeId === r.f.target.id))
  assert.ok(api.getFirstStopDistanceIssue(r.grounded, r.f.input, r.candidates))
  assert.equal(api.getFirstStopDistanceIssue(r.delivered.plan, r.f.input), null)
})

test('unknown museum hours are not repaired by its cultural classification', async t => {
  const r = await replay(t, 'unknown-hours')
  assert.equal(r.candidate, undefined)
  assert.ok(r.validation.issues.length)
  if (r.delivered.plan && !r.finalIssues.length) assert.notEqual(r.finalTarget?.placeId, r.f.target.id)
})

test('Routes failure cannot be masked by keeping a cultural role', async t => {
  const r = await replay(t, 'routes-failure')
  assert.equal(r.delivered.routesFailed, true)
})

for (const tags of [[], ['food_first']]) {
  test(`three plans preserve mixed cultural activities and use cultural alternatives, tags=${tags}`, async t => {
    const used = new Set()
    const rows = []
    const results = []
    for (const style of ['safe', 'balanced', 'explore']) {
      const r = await replay(t, 'diversity', tags, { style, crossUsed: used })
      assertDelivered(r)
      results.push(r)
      rows.push(r.delivered.plan.stops[0].placeId)
      r.delivered.plan.stops.forEach(s => used.add(s.placeId))
      t.mock.restoreAll()
      t.mock.timers.reset()
    }
    for (const r of results) {
      assert.equal(r.finalTarget.type, 'main_activity')
      assert.equal(getActivityPurpose(r.finalTarget), 'culture')
      assert.equal(compareOriginalActivities(r.f.plan.stops, r.delivered.plan.stops).purposeChanges, 0)
      assert.equal(compareOriginalActivities(r.f.plan.stops, r.delivered.plan.stops).retainedStayLoss, 0)
      assert.equal(r.delivered.plan.stops.filter(s => s.type === 'food').length, 1)
    }
    assert.notEqual(rows[0], rows[1], 'a comparable unused cultural alternative can compete')
    assert.equal(rows[2], rows[0], 'exhausted alternatives allow safe cultural reuse')
  })
}

test.after(() => {
  // Explicit opt-in audit output; ordinary tests do not mutate saved evidence.
  if (process.env.CLASSIFICATION_AUDIT_OUTPUT) writeFileSync(process.env.CLASSIFICATION_AUDIT_OUTPUT,
    JSON.stringify({ evidence: 'Fixed Places/Routes, handcrafted AI skeleton; no live services', observations }, null, 2) + '\n')
})
