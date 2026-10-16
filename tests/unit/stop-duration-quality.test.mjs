import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { durationQualityFixture, mockDurationQuality, durationReplayDigest } from './fixtures/stop-duration-quality.mjs'

process.env.NODE_ENV = 'production'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
const { repairAndValidatePlanForDelivery, getDeliveryPlanIssues } = await import('../../api/generate-trip.ts')
const { TripCandidateDebugSession } = await import('../../api/_lib/trip-candidate-debug.ts')
const { getPlanActualDuration } = await import('../../api/_lib/trip-plan-metrics.ts')

async function deliver(t, kind = 'pressure', style = 'explore') {
  const f = durationQualityFixture(kind, style)
  const { counts, routeRequests } = mockDurationQuality(t, f)
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordCandidateSets(f.candidates)
  const source = structuredClone(f.plan)
  const result = await repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(),
    'duration-test', f.crossPlanUsed, debug)
  assert.ok(result.plan)
  assert.equal(result.routesFailed, false)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, f.input, 'duration-final', { candidates: f.candidates }), [])
  assert.deepEqual(f.plan, source)
  assert.equal(result.plan.title, source.title)
  assert.equal(result.plan.type, style)
  assert.ok(routeRequests.every(body => !('departureTime' in body) && !('routingPreference' in body)))
  const report = debug.buildReport([result.plan]).qualityDiagnostics
  return { f, result, counts, report, decisions: report.transitions.filter(t => t.phase.startsWith('duration-redistribution:')) }
}

for (const style of ['safe', 'balanced', 'explore']) test(`${style}: restores 30 cultural minutes with the same 300-minute itinerary`, async t => {
  const { result, counts, decisions, f } = await deliver(t, 'pressure', style)
  assert.deepEqual(result.plan.stops.map(s => s.duration), [90, 45, 93, 60])
  assert.equal(getPlanActualDuration(result.plan), 300)
  assert.deepEqual(result.plan.stops.map(s => [s.id, s.placeId, s.type]), f.plan.stops.map(s => [s.id, s.placeId, s.type]))
  assert.equal(result.plan.transportSegments.reduce((n, s) => n + s.duration, 0), 12)
  assert.deepEqual(counts, { places: 4, routes: 3, ai: 0 })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].phase, 'duration-redistribution:accepted')
  const before = [75, 45, 123, 45], after = [90, 45, 93, 60]
  assert.deepEqual(decisions[0].changes.map(s => s.durationDelta), [15, -30, 15])
  t.diagnostic(JSON.stringify({ style, before, after, actual: 300, calls: counts }))
})

test('earlier closing rejects the entire comparison using cached Details and its 30-minute buffer', async t => {
  const { result, counts, decisions } = await deliver(t, 'early-close')
  assert.deepEqual(result.plan.stops.map(s => s.duration), [75, 45, 123, 45])
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].phase, 'duration-redistribution:rejected')
  assert.match(decisions[0].context.reason, /closing_buffer/)
  assert.deepEqual(counts, { places: 4, routes: 3, ai: 0 })
})

for (const kind of ['fallback', 'fallback-early-close']) test(`${kind}: applies only after the existing diversity fallback finishes`, async t => {
  const { result, decisions, report } = await deliver(t, kind)
  assert.deepEqual(result.plan.stops.map(s => s.duration), kind === 'fallback' ? [90, 45, 93, 60] : [75, 45, 123, 45])
  assert.equal(decisions.length, 1)
  const fallback = report.transitions.findIndex(t => t.phase === 'fallback:activity-diversity-selected')
  const allocation = report.transitions.findIndex(t => t.phase.startsWith('duration-redistribution:'))
  assert.ok(fallback >= 0 && allocation > fallback)
})

for (const [kind, expected] of [
  ['two-stop', [66, 150]], ['meal', [55, 60, 70, 45]], ['slow', [75, 45, 123, 45]],
  ['unknown-receivers', [75, 45, 123, 45]], ['ambiguous-donor', [75, 45, 123, 45]],
  ['outdoor-request', [75, 45, 123, 45]],
]) test(`${kind}: leaves an ineligible or necessary original allocation intact`, async t => {
  const { result, decisions, report } = await deliver(t, kind)
  assert.deepEqual(result.plan.stops.map(s => s.duration), expected)
  assert.equal(decisions.length, 0)
  assert.equal(result.plan.stops.length, expected.length)
  if (kind === 'two-stop') assert.equal(getPlanActualDuration(result.plan), 225)
  if (kind === 'ambiguous-donor') assert.equal(report.final[0].stops[2].themes.culture.status, 'insufficient_evidence')
})

test('transit timing cannot be reused for a changed timetable; keeps the original without a new query', async t => {
  const { result, decisions, counts } = await deliver(t, 'transit')
  assert.deepEqual(result.plan.stops.map(s => s.duration), [75, 45, 123, 45])
  assert.match(decisions[0].context.reason, /route_timing_not_reusable/)
  assert.deepEqual(counts, { places: 4, routes: 3, ai: 0 })
})

test('a legal optional diversity choice is retained when no capacity restoration is needed', async t => {
  const { result, decisions } = await deliver(t, 'fallback-legal')
  assert.deepEqual(result.plan.stops.map(s => s.duration), [90, 45, 90, 60])
  assert.equal(result.plan.stops[2].name, '愛河')
  assert.equal(decisions.length, 0)
})

test('restoration that pushes the original lunch to after 13:00 is rejected', async t => {
  const { result, decisions } = await deliver(t, 'late-lunch')
  assert.deepEqual(result.plan.stops.map(s => s.duration), [75, 45, 123, 45])
  assert.equal(decisions.length, 1)
  assert.match(decisions[0].context.reason, /required_meal_window/)
})

test('missing opening evidence and caller-seeded route hints cannot certify the comparison', async () => {
  const { getDurationRedistributionIssues } = await import('../../api/_lib/trip-stop-duration-quality.ts')
  const { createSupplementRouteContext, hasReusableStaticRouteTimings } = await import('../../api/_lib/trip-supplement-quality.ts')
  const f = durationQualityFixture('unfetched')
  const before = { ...f.plan, totalTime: 300, stops: f.plan.stops.map((s, i) => ({ ...s, duration: [75, 45, 123, 45][i] })) }
  const after = { ...before, stops: before.stops.map((s, i) => ({ ...s, duration: [90, 45, 93, 60][i] })) }
  assert.match(getDurationRedistributionIssues(before, after, f.input, f.candidates).join(','), /opening_hours/)
  const context = createSupplementRouteContext()
  before.transportSegments.forEach((s, i) => {
    const a = before.stops[i], b = before.stops[i + 1]
    context.memo.set(`${a.lat},${a.lng}>${b.lat},${b.lng}:${s.mode}`, Promise.resolve({ duration: s.duration, label: 'apparently real' }))
  })
  assert.equal(await hasReusableStaticRouteTimings(context, before), false)
  assert.equal(context.totalCalls, 0)
})

test('insufficient transferable excess does not arbitrarily favour one cultural activity', async t => {
  const { result, decisions } = await deliver(t, 'insufficient-excess')
  assert.deepEqual(result.plan.stops.map(s => s.duration), [60, 45, 113, 70])
  assert.equal(decisions.length, 0)
})

test('conflicting cultural evidence on a natural-feature candidate protects its duration', async () => {
  const { proposeStopDurationRedistribution, recordCapacityDurationLoss } = await import('../../api/_lib/trip-stop-duration-quality.ts')
  const f = durationQualityFixture('mixed-donor')
  const before = { ...f.plan, totalTime: 300,
    stops: f.plan.stops.map((s, i) => ({ ...s, duration: [75, 45, 123, 45][i] })) }
  const losses = new Map()
  recordCapacityDurationLoss(f.plan, before, losses)
  f.candidates.allCandidates[2].types = ['natural_feature', 'art_gallery']
  assert.equal(proposeStopDurationRedistribution(before, f.input, f.candidates, losses), null)
})

test('failed route evidence never adopts a duration comparison', async t => {
  const f = durationQualityFixture('route-failure')
  mockDurationQuality(t, f)
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordCandidateSets(f.candidates)
  const result = await repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'failed-route', new Set(), debug)
  assert.equal(result.routesFailed, true)
  assert.equal(debug.buildReport(result.plan ? [result.plan] : []).qualityDiagnostics.transitions
    .filter(t => t.phase === 'duration-redistribution:accepted').length, 0)
})

test('a later delivery pass cannot redistribute an already restored allocation again', async t => {
  const { f, result, report } = await deliver(t)
  const debug = new TripCandidateDebugSession(f.input)
  debug.recordCandidateSets(f.candidates)
  const again = await repairAndValidatePlanForDelivery(result.plan, f.input, f.candidates, new Set(), 'second-delivery', new Set(), debug)
  assert.deepEqual(again.plan.stops.map(s => s.duration), [90, 45, 93, 60])
  assert.equal(report.transitions.filter(t => t.phase === 'duration-redistribution:accepted').length, 1)
  assert.equal(debug.buildReport([again.plan]).qualityDiagnostics.transitions.filter(t => t.phase.startsWith('duration-redistribution:')).length, 0)
})

test('before/after fixed replays preserve every external call and all non-duration response content', t => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/stop-duration-quality-baseline.json', import.meta.url), 'utf8'))
  const rows = []
  for (const kind of ['pressure', 'early-close', 'fallback', 'fallback-early-close', 'fallback-legal',
    'two-stop', 'meal', 'slow', 'unknown-receivers', 'ambiguous-donor', 'late-lunch', 'transit', 'car', 'outdoor-request']) {
    const before = baseline.cases[kind]
    const after = JSON.parse(execFileSync(process.execPath,
      ['--disable-warning=ExperimentalWarning', '--import', './tests/unit/register-ts-js-extension-loader.mjs',
        './tests/unit/fixtures/stop-duration-quality-replay.mjs', 'current', kind],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 3 * 1024 * 1024 }))
    assert.deepEqual(after.counts, before.counts, kind)
    assert.equal(durationReplayDigest(after.routeRequests), before.routeRequestsSha256, kind)
    assert.deepEqual(after.issues, [])
    assert.deepEqual(before.issues, [])
    const stripDurations = result => ({ ...result, plan: { ...result.plan,
      stops: result.plan.stops.map(({ duration, ...stop }) => stop) } })
    assert.equal(durationReplayDigest(stripDurations(after.result)), before.nonDurationResultSha256, kind)
    const changed = ['pressure', 'fallback', 'car'].includes(kind)
    if (!changed) assert.deepEqual(after.result.plan.stops.map(s => s.duration), before.durations, kind)
    const decision = after.quality.transitions.filter(s => s.phase.startsWith('duration-redistribution:'))
    assert.ok(decision.length <= 1)
    rows.push({ kind, before: before.durations,
      after: after.result.plan.stops.map(s => s.duration), calls: after.counts,
      decision: decision[0]?.phase ?? 'not_triggered', reason: decision[0]?.context.reason })
  }
  t.diagnostic(JSON.stringify(rows))
})
