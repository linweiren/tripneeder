import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mealReliabilityFixture } from './fixtures/meal-reliability.mjs'
import { FIXED_NOW, mockMatrix } from './fixtures/supplement-quality.mjs'

process.env.NODE_ENV = 'production'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
const api = await import('../../api/generate-trip.ts')
const { TripCandidateDebugSession, createTripCandidateDebugSession } = await import('../../api/_lib/trip-candidate-debug.ts')

async function deliver(t, kind) {
  const f = mealReliabilityFixture(kind), source = structuredClone(f.plan)
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  for (const key of ['info', 'warn', 'debug', 'error']) t.mock.method(console, key, () => {})
  t.mock.method(globalThis, 'fetch', () => { throw Error('No live fetch permitted') })
  const routes = mockMatrix(t, f), request = https.request, counts = { places: 0, routes: 0 }
  t.mock.method(https, 'request', function (url, ...args) {
    const host = new URL(url).hostname
    if (host === 'places.googleapis.com') counts.places++
    else if (host === 'routes.googleapis.com') counts.routes++
    else throw Error(`Unexpected network boundary: ${host}`)
    return request.call(this, url, ...args)
  })
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordCandidateSets(f.candidates)
  debug.recordAiOutput([f.plan], 'fixed-ai-response-not-recovered-real-json')
  const grounded = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
  debug.recordPlanTransition(f.plan, grounded, 'grounding:fixed')
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates,
    new Set(), 'meal-diagnostics', f.crossUsed ?? new Set(), debug)
  assert.ok(result.plan)
  assert.equal(result.routesFailed, false)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input, 'meal-diagnostics-final', { candidates: f.candidates }), [])
  const callsBeforeReport = { ...counts }, lengthBeforeReport = routes.length
  const q = debug.buildReport([result.plan]).qualityDiagnostics
  assert.deepEqual(counts, callsBeforeReport)
  assert.equal(routes.length, lengthBeforeReport)
  assert.deepEqual(f.plan, source)
  return { f, grounded, result, q, meal: q.final[0].meals, counts }
}

for (const [kind, name, duration, category] of [
  ['sketch-safe', '草圖', 60, 'refreshment_hint_only'],
  ['thisball', 'ThisBALL', 60, 'insufficient_evidence'],
  ['explore-coffee', '草圖', 66, 'refreshment_hint_only'],
]) test(`${kind}: identifies the observed meal identity without asserting menu verification`, async t => {
  const { meal } = await deliver(t, kind), window = meal.windows[0]
  assert.equal(window.id, 'lunch')
  assert.equal(window.numericalLegality, 'satisfied')
  assert.equal(window.evidenceCategory, category)
  assert.equal(window.countedStops.length, 1)
  assert.ok(window.countedStops[0].name.includes(name))
  assert.equal(window.countedStops[0].duration, duration)
  assert.equal(window.menuServiceEvidence, 'unknown')
  assert.equal(meal.requirement.basis, 'existing_effective_window_can_fit_minimum_meal')
  assert.equal(meal.requirement.explicitFormalMealIntent, 'unknown')
})

for (const [kind, opening] of [['better-candidate', 'fits'], ['closed-alternative', 'does_not_fit'],
  ['unknown-hours-alternative', 'unknown']]) test(`${kind}: candidate availability never implies full replacement feasibility`, async t => {
  const { meal, result } = await deliver(t, kind)
  const comparison = meal.windows[0].candidateComparison
  assert.equal(comparison.higherHintCandidateCount, 1)
  assert.equal(comparison.higherHintCandidates[0].sameSlotOpeningChecks[0].status, opening)
  assert.equal(comparison.higherHintCandidates[0].mealSuitability, 'meal_likely')
  assert.equal(comparison.sameSlotOpeningCompatibleCount, opening === 'fits' ? 1 : 0)
  assert.equal(comparison.fullReplacementFeasibility, 'unknown')
  assert.equal(comparison.higherHintCandidates[0].menuServiceEvidence, 'unknown')
  assert.ok(result.plan.stops.some(s => s.name.includes('草圖')))
})

for (const [kind, hint, reason] of [['safety-to-cafe', 'refreshment_likely', 'necessarySafetyReplacements'],
  ['optional-to-uncertain', 'uncertain', 'optionalFoodReplacements']]) test(`${kind}: reports relative meal evidence loss through existing repair hooks`, async t => {
  const { grounded, result, q, meal } = await deliver(t, kind)
  assert.equal(meal.windows[0].countedStops[0].mealSuitability, hint)
  assert.equal(api.getFoodPurposeImpact(grounded, result.plan.stops)[reason], 1)
  const change = q.transitions.find(s => s.phase.startsWith('repair:') && s.changes.some(c => c.higherMealHintLost))
  assert.ok(change)
  assert.ok(change.mealWindows.some(w => w.higherMealHintLost))
  assert.equal(change.changes.find(c => c.higherMealHintLost).beforeFoodPurpose, 'meal')
})

test('existing optional meal-purpose protection is unaffected', async t => {
  const { meal, q } = await deliver(t, 'optional-meal-protected')
  assert.equal(meal.windows[0].evidenceCategory, 'higher_meal_hint_unverified')
  assert.equal(q.transitions.some(s => s.changes.some(c => c.higherMealHintLost)), false)
})

test('actual diversity fallback records the restored meal identity without calling it an evidence downgrade', async t => {
  const { q, result, f } = await deliver(t, 'fallback-meal')
  const fallback = q.transitions.find(s => s.phase === 'fallback:activity-diversity-selected')
  assert.ok(fallback)
  assert.ok(fallback.mealWindows.length)
  assert.equal(fallback.mealWindows[0].higherMealHintLost, false)
  assert.equal(fallback.mealWindows[0].afterCountedStops[0].placeId, f.food.placeId)
  assert.ok(result.plan.stops.some(s => s.placeId === f.food.placeId))
})

test('only uncertain food still passes the original rule and is labelled insufficient evidence', async t => {
  const { meal, q } = await deliver(t, 'uncertain-only')
  assert.equal(meal.windows[0].numericalLegality, 'satisfied')
  assert.equal(meal.windows[0].evidenceCategory, 'insufficient_evidence')
  assert.equal(meal.windows[0].countedStops[0].mealSuitability, 'uncertain')
  assert.equal(q.stages[0].meals.windows[0].candidateComparison.sameSlotOpeningCompatibleCount, null)
})

test('a cafe can carry stronger dining evidence without claiming verified service', () => {
  const f = mealReliabilityFixture()
  const cafe = { ...f.plan.stops[1], googleTypes: ['cafe', 'chinese_restaurant', 'restaurant'], foodSubtype: 'cafe' }
  const plan = { ...f.plan, scheduleStartTime: '11:00', stops: [cafe], transportSegments: [] }
  const window = new TripCandidateDebugSession(f.input).buildReport([plan]).qualityDiagnostics.final[0].meals.windows[0]
  assert.equal(window.countedStops[0].foodSubtype, 'cafe')
  assert.equal(window.evidenceCategory, 'higher_meal_hint_unverified')
  assert.equal(window.menuServiceEvidence, 'unknown')
})

test('explicit no_full_meals stays distinct from absent meal windows and does not force a meal', async t => {
  const { meal, result } = await deliver(t, 'no-full')
  assert.equal(meal.requirement.status, 'user_no_full_meals')
  assert.equal(meal.requirement.basis, 'explicit_no_full_meals_tag')
  assert.deepEqual(meal.windows, [])
  assert.equal(result.plan.stops.some(s => s.type === 'food'), false)
})

test('culture and coffee can retain an independent meal without redefining their purposes', async t => {
  const { q, meal } = await deliver(t, 'independent-meal')
  assert.equal(meal.windows[0].evidenceCategory, 'higher_meal_hint_unverified')
  assert.equal(meal.windows[0].countedStops[0].foodSubtype, 'restaurant')
  assert.equal(q.final[0].stops.filter(s => s.type === 'food').length, 2)
  assert.equal(q.final[0].themeCoverage.culture.status, 'confirmed')
  assert.equal(q.final[0].themeCoverage.coffee.status, 'confirmed')
})

test('meal boundaries, effective starts and cross-day occurrences reuse existing rules', () => {
  const f = mealReliabilityFixture()
  for (const [startTime, endTime, scheduledStart, expected] of [
    ['10:59', '11:01', '10:59', []], ['12:50', '13:30', '12:50', []],
    ['12:50', '13:35', '12:50', ['lunch:660']], ['13:00', '15:00', '13:00', []],
    ['16:00', '21:00', '18:00', ['dinner:1020']], ['23:30', '12:30', '11:00', ['lunch:2100']],
    ['12:50', '12:49', '12:50', ['lunch:660', 'dinner:1020', 'lunch:2100']],
  ]) {
    const input = { ...f.input, startTime, endTime }
    const debug = new TripCandidateDebugSession(input)
    const plan = { ...f.plan, scheduleStartTime: scheduledStart, stops: [f.plan.stops[1]], transportSegments: [] }
    const meal = debug.buildReport([plan]).qualityDiagnostics.final[0].meals
    assert.deepEqual(meal.windows.map(w => w.windowKey), expected)
    assert.equal(meal.requirement.status, expected.length ? 'required_windows' : 'no_required_window')
    if (expected.length === 1) assert.equal(meal.windows[0].numericalLegality, 'satisfied')
  }
})

test('stage and fallback comparisons do not mislabel discarded downgrades as the final choice', () => {
  const f = mealReliabilityFixture('independent-meal')
  const before = { ...f.plan, scheduleStartTime: '11:00', stops: [f.plan.stops[1]], transportSegments: [] }
  const coffee = { ...f.plan.stops.at(-1), id: before.stops[0].id }
  const after = { ...before, stops: [coffee] }
  for (const phase of ['grounding', 'repair', 'fallback']) {
    const debug = new TripCandidateDebugSession(f.input)
    debug.recordCandidateSets(f.candidates)
    debug.recordAiOutput([before], 'fixed-ai')
    debug.recordPlanTransition(before, after, phase, { disposition: 'provisional' })
    const q = debug.buildReport([before]).qualityDiagnostics
    assert.equal(q.transitions[0].mealWindows[0].higherMealHintLost, true)
    assert.equal(q.transitions[0].context.disposition, 'provisional')
    assert.equal(q.final[0].meals.windows[0].evidenceCategory, 'higher_meal_hint_unverified')
  }
})

test('same-identity evidence updates are visible, while a no-longer-required meal is distinguished', () => {
  const f = mealReliabilityFixture('independent-meal')
  const before = { ...f.plan, scheduleStartTime: '11:00', stops: [f.plan.stops[1]], transportSegments: [] }
  const after = { ...before, stops: [{ ...before.stops[0], googleTypes: ['cafe'], foodSubtype: 'cafe' }] }
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordPlanTransition(before, after, 'grounding-evidence', { disposition: 'provisional' })
  const q = debug.buildReport([after]).qualityDiagnostics
  assert.equal(q.transitions[0].changes[0].kind, 'meal_evidence_changed')
  assert.equal(q.transitions[0].mealWindows[0].higherMealHintLost, true)
  const shifted = { ...before, scheduleStartTime: '13:00' }
  debug.recordPlanTransition(before, shifted, 'schedule-shift')
  const last = debug.buildReport([shifted]).qualityDiagnostics.transitions.at(-1).mealWindows[0]
  assert.equal(last.afterNumericalLegality, 'not_required')
  assert.equal(last.higherMealHintLost, false)
})

test('missing evidence/pool observations, invalid time and free text remain explicitly unknown', () => {
  const f = mealReliabilityFixture()
  const plan = { ...f.plan, scheduleStartTime: '11:00', transportSegments: [], stops: [{ ...f.plan.stops[1],
    name: '用途未明', googleTypes: [], foodSubtype: undefined, candidateRole: undefined }] }
  const debug = new TripCandidateDebugSession({ ...f.input, customCategory: '不吃正餐 SECRET_RAW_TEXT' })
  const unseen = debug.buildReport([plan]).qualityDiagnostics.final[0].meals
  assert.equal(unseen.windows[0].evidenceCategory, 'insufficient_evidence')
  assert.equal(unseen.windows[0].candidateComparison.higherHintCandidateCount, null)
  assert.equal(unseen.requirement.customTextInterpretation, 'not_inferred')
  debug.recordCandidateSets({ allCandidates: [], otherCandidates: [], firstStopCandidates: [] })
  assert.equal(debug.buildReport([plan]).qualityDiagnostics.final[0].meals.windows[0].candidateComparison.higherHintCandidateCount, 0)
  const invalid = new TripCandidateDebugSession({ ...f.input, startTime: 'unknown' }).buildReport([plan])
  assert.equal(invalid.qualityDiagnostics.final[0].meals.requirement.status, 'unknown')
})

test('new meal data is detached, excludes secrets/prose/history and production cannot enable it', () => {
  const f = mealReliabilityFixture('better-candidate')
  Object.assign(f.plan.stops[1], { token: 'SECRET_TOKEN', description: 'SECRET_GENERATED_PROSE', history: ['SECRET_HISTORY'] })
  Object.assign(f.candidates.allCandidates.at(-1), { token: 'SECRET_TOKEN', prompt: 'SECRET_PROMPT' })
  const debug = new TripCandidateDebugSession({ ...f.input, customCategory: 'SECRET_RAW_TEXT' })
  debug.recordCandidateSets(f.candidates)
  debug.recordAiOutput([f.plan], 'fixed-ai')
  const q = debug.buildReport([f.plan]).qualityDiagnostics
  f.candidates.allCandidates.at(-1).types.push('later_mutation')
  assert.doesNotMatch(JSON.stringify(q), /SECRET_|later_mutation/)
  assert.equal(createTripCandidateDebugSession(f.input, { NODE_ENV: 'production', TRIP_CANDIDATE_DEBUG: 'true' }), null)
})

for (const kind of ['sketch-safe', 'thisball', 'independent-meal', 'no-full']) {
  test(`full generation ${kind}: off/on/production preserve final plans, every event and external calls`, t => {
    const [off, on, production] = ['off', 'on', 'production'].map(mode => JSON.parse(execFileSync(process.execPath,
      ['--disable-warning=ExperimentalWarning', '--import', './tests/unit/register-ts-js-extension-loader.mjs',
        './tests/unit/fixtures/meal-reliability-replay.mjs', mode, kind],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })))
    assert.equal(on.statusCode, 200)
    assert.equal(on.response.plans.length, 3)
    for (const other of [off, production]) {
      assert.deepEqual(other.response, on.response)
      assert.deepEqual(other.events, on.events)
      assert.deepEqual(other.calls, on.calls)
      assert.equal(other.snapshots, 0)
      assert.equal(other.reports, 0)
      assert.equal(other.quality, null)
    }
    assert.equal(on.reports, 1)
    assert.ok(on.snapshots > 0)
    assert.ok(on.calls.ai > 0 && on.calls.places > 0 && on.calls.routes > 0)
    assert.ok(on.quality.final.every(plan => kind === 'no-full' ? plan.meals.windows.length === 0
      : plan.meals.windows.some(window => window.numericalLegality === 'satisfied')))
    const { httpsEndpoints, ...summaryCalls } = on.calls
    assert.ok(Object.keys(httpsEndpoints).some(endpoint => endpoint.startsWith('unit-test.supabase.co/')))
    t.diagnostic(JSON.stringify({ kind, calls: summaryCalls, bytes: on.bytes, snapshots: on.snapshots,
      reportBuildMs: on.reportBuildMs, generationMs: { off: off.elapsedMs, on: on.elapsedMs },
      final: on.quality.final.map(plan => ({ type: plan.planType,
        evidence: plan.meals.windows.map(window => window.evidenceCategory) })) }))
  })
}
