import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { TripCandidateDebugSession, createTripCandidateDebugSession } from '../../api/_lib/trip-candidate-debug.ts'
import { repairPlanForDelivery } from '../../api/generate-trip.ts'
import { fixture, mockMatrix, FIXED_NOW } from './fixtures/supplement-quality.mjs'

// Direct repair replays must not append to the developer's existing local logs.
process.env.NODE_ENV = 'production'

const input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00', endTime: '15:00',
  tags: [], location: { name: '高雄中央公園', lat: 22.6, lng: 120.3 } }
function stop(id, name, types, duration = 60, type = 'main_activity') {
  return { id, placeId: id, name, googleTypes: types, types, duration, type, description: 'AI text is not activity evidence',
    address: '', googleMapsUrl: 'https://example.com', role: type === 'food' ? 'food' : 'main_activity',
    openingHours: { isKnown: true, isNeverOpen: false, windows: [] }, availabilitySlots: ['middle'] }
}
const museum = stop('museum', '地方文物館', ['museum'])
const cafe = stop('cafe', '咖啡廳', ['cafe'], 45, 'food')
const park = stop('park', '中央公園', ['park'], 120)
const bay = stop('bay', '愛河灣', ['tourist_attraction'], 150)
function plan(stops, type = 'safe', extra = {}) {
  return { id: type, type, title: '', subtitle: '', summary: '', budget: 0, transportMode: 'scooter',
    totalTime: 0, stops: structuredClone(stops), transportSegments: [], rainBackup: [], rainTransportSegments: [], ...extra }
}
function session(candidates = [museum, cafe, park, bay], selected = candidates) {
  const debug = new TripCandidateDebugSession(input)
  debug.recordCandidateSets({ allCandidates: candidates, firstStopCandidates: candidates, otherCandidates: candidates })
  debug.recordAiInput({ nearStops: [], foodStops: [], mainStops: [], fallbackStops: [], promptCandidates: selected })
  return debug
}
const report = (debug, plans) => debug.buildReport(plans).qualityDiagnostics

test('eligible culture and coffee do not imply AI selection or itinerary feasibility; ambiguous art stays inconclusive', () => {
  const debug = session()
  const ignored = plan([cafe, park])
  debug.recordAiOutput([ignored], 'initial-ai-output')
  const q = report(debug, [ignored])
  assert.deepEqual(q.intent.explicitPositiveThemes, ['culture', 'coffee'])
  assert.equal(q.candidateThemes[0].eligiblePoolConfirmedCount, 1)
  assert.equal(q.candidateThemes[0].promptConfirmedCount, 1)
  assert.equal(q.candidateThemes[0].fullItineraryFeasibility, 'unknown')
  assert.equal(q.stages[0].themeCoverage.culture.status, 'insufficient_evidence')
  assert.equal(q.final[0].themeCoverage.coffee.status, 'confirmed')
  const art = stop('art', '城市光廊', ['park', 'tourist_attraction'])
  const ambiguous = report(session([art]), [plan([art])]).final[0]
  assert.equal(ambiguous.themeCoverage.culture.status, 'insufficient_evidence')
  assert.equal(ambiguous.themeCoverage.coffee.status, 'not_matched')
})

test('unobserved, unavailable and unexposed candidates remain distinguishable', () => {
  const unseen = report(new TripCandidateDebugSession(input), [])
  assert.equal(unseen.candidateThemes[0].eligiblePoolConfirmedCount, null)
  assert.equal(unseen.candidateThemes[0].promptConfirmedCount, null)
  const unavailable = session([cafe], [cafe]) // closed museum excluded by existing candidate filtering
  unavailable.recordCandidatePool({ rawCandidateCount: 2, usableCandidateCount: 1, candidates: [{
    ...museum, types: ['museum'], excluded: true, exclusionReason: 'closed', availabilitySlots: [],
  }] })
  const q = report(unavailable, [])
  assert.equal(q.candidateThemes[0].eligiblePoolConfirmedCount, 0)
  assert.equal(q.candidateThemes[0].promptConfirmedCount, 0)
  assert.equal(q.candidateThemes[0].fullItineraryFeasibility, 'unknown')
  assert.equal(report(session([museum, cafe], [cafe]), []).candidateThemes[0].promptConfirmedCount, 0)
  const duplicates = report(session([museum, cafe], [museum, museum, cafe]), []).candidateThemes[0]
  assert.equal(duplicates.promptConfirmedCount, 1)
  assert.equal(duplicates.promptConfirmedEntryCount, 2)
})

test('stage transitions locate theme loss in grounding, repair and fallback without treating attempts as delivery', () => {
  for (const phase of ['grounding', 'repair', 'fallback']) {
    const debug = session()
    const before = plan([museum, cafe])
    const after = plan([{ ...park, id: museum.id }, cafe])
    debug.recordAiOutput([before], 'initial-ai-output')
    const attemptId = debug.beginRepairAttempt(before, 'test-attempt')
    debug.recordPlanTransition(before, after, phase, { attemptId, disposition: 'provisional' })
    const q = report(debug, [after])
    const delta = q.transitions[0]
    assert.equal(q.stages[delta.beforeStage].themeCoverage.culture.status, 'confirmed')
    assert.equal(q.stages[delta.afterStage].themeCoverage.culture.status, 'insufficient_evidence')
    assert.equal(delta.changes[0].kind, 'replaced')
    assert.equal(delta.context.disposition, 'provisional')
    assert.equal(q.final[0].context.disposition, 'selected')
  }
})

test('only Safe has confirmed cultural venue coverage; no generated activity prose proves experience depth', () => {
  const q = report(session(), [plan([museum, cafe]), plan([cafe, park], 'balanced'), plan([cafe, bay], 'explore')])
  assert.deepEqual(q.final.map(p => p.themeCoverage.culture.status), ['confirmed', 'insufficient_evidence', 'insufficient_evidence'])
  assert.ok(q.final.every(p => p.themeCoverage.culture.experienceDepth === 'unknown'))
  assert.ok(q.final.flatMap(p => p.stops).every(s => s.activityEvidence.status === 'unknown'))
})

test('earliest bay150 vs reference90, park120, coffee45→66 and request10→effective11 are explicit', () => {
  const debug = session()
  const before = plan([cafe, bay], 'explore')
  const after = plan([{ ...cafe, duration: 66 }, bay], 'explore', { scheduleStartTime: '11:00' })
  debug.recordAiOutput([before], 'initial-ai-output')
  debug.recordPlanTransition(before, after, 'coverage-existing', { reason: 'minimum_required_actual_minutes' })
  const q = report(debug, [after, plan([park])])
  assert.equal(q.earliestVisible.find(s => s.placeId === 'bay').duration, 150)
  assert.equal(q.earliestVisible.find(s => s.placeId === 'cafe').duration, 45)
  const finalBay = q.final[0].stops[1]
  assert.equal(finalBay.durationReference.maximum, 90)
  assert.equal(finalBay.durationReference.hardLimit, false)
  assert.equal(finalBay.exceedsReference, true)
  assert.equal(finalBay.activityEvidence.status, 'unknown')
  assert.equal(q.final[1].stops[0].durationReference.maximum, 120)
  assert.equal(q.transitions[0].changes[0].durationDelta, 21)
  assert.equal(q.transitions[0].context.reason, 'minimum_required_actual_minutes')
  assert.equal(q.final[0].startDelayMinutes, 60)
  assert.equal(q.final[0].requestedEndTime, '15:00')
})

test('observed cafe lunches from both runs pass the existing rule but do not verify formal meals', () => {
  for (const [duration, start] of [[66, '11:00'], [60, '12:04']]) {
    const q = report(session(), [plan([{ ...cafe, duration }], 'explore', { scheduleStartTime: start })]).final[0]
    assert.deepEqual(q.meals.requestedWindows, ['lunch'])
    assert.deepEqual(q.meals.existingRuleIssues, [])
    assert.deepEqual(q.stops[0].meal.satisfiesExistingMealWindows, ['lunch'])
    assert.equal(q.stops[0].meal.classificationHint, 'refreshment_likely')
    assert.equal(q.stops[0].meal.suitability, 'uncertain')
    assert.equal(q.meals.formalMealServiceVerified, 'unknown')
  }
  const dining = stop('meal', '午餐餐廳', ['restaurant'], 60, 'food')
  const unknown = stop('unknown', '未知用途', [], 60, 'food')
  const debug = session([dining, cafe, unknown])
  debug.recordPlanTransition(plan([dining]), plan([{ ...cafe, id: dining.id }]), 'grounding')
  const q = report(debug, [plan([unknown])])
  assert.equal(q.transitions[0].changes[0].beforeMealHint, 'meal_likely')
  assert.equal(q.transitions[0].changes[0].afterMealHint, 'refreshment_likely')
  assert.equal(q.final[0].stops[0].meal.suitability, 'unknown')
})

test('real repair hooks identify the cafe coverage extension without modifying the long bay stay', async t => {
  process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture('legal-gap')
  const cafeStop = { ...f.plan.stops[0], ...cafe, lat: 22.6, lng: 120.3, distanceKm: 0, openingHours: f.plan.stops[0].openingHours }
  const bayStop = { ...f.plan.stops[1], ...bay, lat: 22.61, lng: 120.3, distanceKm: 1, openingHours: f.plan.stops[1].openingHours }
  f.input = { ...input }
  f.plan = plan([cafeStop, bayStop], 'explore', { scheduleStartTime: '11:00', transportSegments: [{
    fromStopId: 'cafe', toStopId: 'bay', mode: 'scooter', label: '', duration: 9 }] })
  f.candidates = { allCandidates: [cafeStop, bayStop], firstStopCandidates: [cafeStop, bayStop], otherCandidates: [cafeStop, bayStop] }
  f.routes = { 'cafe>bay': 9, 'bay>cafe': 9 }
  mockMatrix(t, f)
  const debug = session(f.candidates.allCandidates)
  debug.recordAiOutput([f.plan], 'earliest-existing-grounded-record')
  const result = await repairPlanForDelivery(f.plan, f.input, f.candidates, new Set(), { debugSession: debug })
  assert.deepEqual(result.plan.stops.map(s => s.duration), [66, 150])
  const q = report(debug, [result.plan])
  const stretch = q.transitions.find(s => s.phase === 'repair:coverage-existing-activities')
  assert.equal(stretch.changes[0].durationDelta, 21)
  assert.equal(stretch.coverageAddedMinutes, 21)
  assert.equal(stretch.context.reason, 'minimum_required_actual_minutes')
  assert.equal(q.earliestVisible.find(s => s.placeId === 'bay').duration, 150)
})

test('diagnostic snapshots detach mutable data and exclude prompts, tokens, history and AI descriptions', () => {
  const debug = session()
  const original = plan([museum, cafe])
  Object.assign(original, { token: 'SECRET_TOKEN', prompt: 'FULL_PROMPT', history: ['FULL_HISTORY'] })
  const before = structuredClone(original)
  debug.recordAiOutput([original], 'initial-ai-output')
  assert.deepEqual(original, before)
  original.stops[0].duration = 999
  const q = report(debug, [])
  assert.equal(q.stages[0].stops[0].duration, 60)
  assert.doesNotMatch(JSON.stringify(q), /SECRET_TOKEN|FULL_PROMPT|FULL_HISTORY|AI text is not activity evidence/)
  assert.equal(createTripCandidateDebugSession(input, { NODE_ENV: 'development' }), null)
  assert.equal(createTripCandidateDebugSession(input, { NODE_ENV: 'production', TRIP_CANDIDATE_DEBUG: 'true' }), null)
})

for (const scenario of ['positioning', 'missing-balanced', 'tail']) {
test(`fixed full generation (${scenario}): diagnostics off/on preserve delivery and calls`, t => {
  const outcomes = ['off', 'on'].map(mode => JSON.parse(execFileSync(process.execPath,
    ['--import', './tests/unit/register-ts-js-extension-loader.mjs', './tests/unit/fixtures/quality-diagnostics-replay.mjs', mode, scenario],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })))
  const [off, on] = outcomes
  assert.equal(on.response.plans.length, 3)
  assert.deepEqual(on.response, off.response)
  assert.deepEqual(on.events, off.events)
  assert.deepEqual(on.calls, off.calls)
  assert.ok(on.calls.ai > 0 && on.calls.places > 0 && on.calls.routes > 0)
  assert.equal(off.snapshots, 0)
  assert.equal(off.reports, 0)
  assert.equal(on.reports, 1)
  assert.ok(on.snapshots > 0)
  assert.ok(on.phases.includes(scenario === 'tail' ? 'stream-tail:grounding' : 'stream:grounding'))
  if (scenario === 'missing-balanced') {
    assert.equal(on.calls.ai, 2)
    assert.ok(on.phases.includes('refill:grounding'))
  }
  assert.ok(on.phases.includes('repair:coverage-existing-activities'))
  t.diagnostic(JSON.stringify({ calls: on.calls, stages: on.snapshots, reportBytes: on.reportBytes,
    reportBuildMs: on.reportBuildMs, generationMs: { off: off.elapsedMs, on: on.elapsedMs } }))
})
}
