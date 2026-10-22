import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

const [mode, kind = 'repair'] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(mode))
Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only',
  ENABLE_LOCAL_FALLBACK_REFILL: 'false', TRIP_CANDIDATE_DEBUG: 'false' })
if (mode === 'before') {
  // Override both shared modules, including every transitive consumer, in a
  // fresh process. No checkout, source mutation or partial handler-only baseline.
  const originals = new Map(['trip-plan-metrics', 'trip-quality-rules'].map(name => [
    new URL(`../../../api/_lib/${name}.ts`, import.meta.url).href,
    stripTypeScriptTypes(execFileSync('git', ['show', `cc4a9f2:api/_lib/${name}.ts`], { encoding: 'utf8' })),
  ]))
  registerHooks({ load(url, context, nextLoad) {
    return originals.has(url) ? { format: 'module', source: originals.get(url), shortCircuit: true } : nextLoad(url, context)
  } })
}
if (kind === 'handler') {
  process.argv[2] = 'duration-after'
  await import('./intent-candidate-grounding-replay.mjs')
} else {
  const { capturedDurationRepairFixture, bookedDurationFixture } = await import('./location-semantics.mjs')
  const { durationQualityFixture, mockDurationQuality } = await import('./stop-duration-quality.mjs')
  const api = await import('../../../api/generate-trip.ts')
  const { TripCandidateDebugSession } = await import('../../../api/_lib/trip-candidate-debug.ts')
  const metrics = await import('../../../api/_lib/trip-plan-metrics.ts')
  const { inferStopRhythmRole, getRequiredMealCoverageIssues } = await import('../../../api/_lib/trip-quality-rules.ts')
  const { getMinimumRequiredActualMinutes } = await import('../../../api/_lib/trip-planning-rules.ts')
  const cases = [
    ...['safe', 'balanced', 'explore'].map(style => [`capture-${style}`, capturedDurationRepairFixture(style)]),
    ...['safe', 'balanced', 'explore'].map(style => [`pressure-${style}`, durationQualityFixture('pressure', style)]),
    ...['two-stop', 'meal', 'early-close', 'late-lunch', 'outdoor-request', 'slow', 'transit'].map(name => [name, durationQualityFixture(name)]),
    ['booked-long', bookedDurationFixture()],
  ]
  const rows = []
  for (const [name, f] of cases) {
    const deny = () => { throw Error('Unmocked network forbidden') }
    mock.method(http, 'request', deny); mock.method(net, 'connect', deny)
    mock.method(net, 'createConnection', deny); mock.method(tls, 'connect', deny)
    const { counts, routeRequests } = mockDurationQuality({ mock }, f)
    const original = structuredClone(f.plan)
    const debug = new TripCandidateDebugSession(f.input)
    debug.recordCandidateSets(f.candidates)
    const semantics = f.plan.stops.map(s => ({ name: s.name, reference: metrics.getMaximumStopDuration(s),
      weight: metrics.getStopStretchWeight(s), role: inferStopRhythmRole(s) }))
    const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
      new Set(), 'location-semantics-fixed', f.crossPlanUsed ?? new Set(), debug)
    assert.ok(result.plan, `${name}: ${result.issues}`)
    const issues = await api.getDeliveryPlanIssues(result.plan, f.input, 'location-semantics-final', { candidates: f.candidates })
    assert.deepEqual(issues, [], name)
    assert.deepEqual(getRequiredMealCoverageIssues(result.plan, f.input), [], name)
    assert.deepEqual(f.plan, original, `${name}: input unchanged`)
    rows.push({ name, result, semantics, issues, counts, routeRequests,
      actual: metrics.getPlanActualDuration(result.plan), minimum: getMinimumRequiredActualMinutes(f.input),
      coverage: metrics.getPlanActualDuration(result.plan) / 300,
      quality: debug.buildReport([result.plan]).qualityDiagnostics })
    mock.restoreAll(); mock.timers.reset()
  }
  process.stdout.write(JSON.stringify(rows))
}
