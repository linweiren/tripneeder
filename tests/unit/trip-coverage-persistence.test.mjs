import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { withAcceptanceEvidence, captureAcceptanceDiagnostics, recordEvidenceDelivery } from '../../api/_lib/trip-acceptance-evidence.ts'
import { assessCoverageV2, createRemedyTrace, recordCoverageSearch, recordAiDurations,
  traceDurationPlan, getDurationTrace, getRemedyTimelineSignature } from '../../api/_lib/trip-coverage-v2.ts'
import { FIXED_NOW, fixture } from './fixtures/supplement-quality.mjs'

test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  t.mock.method(https, 'request', () => { throw new Error('Unexpected external API request') })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  t.mock.method(console, 'info', () => {})
  t.mock.method(console, 'warn', () => {})
})

// Exercise the real writeFileSync/JSON envelope and read it from disk after finish.
async function persist(t, coverage, { omit = false } = {}) {
  const root = fs.mkdtempSync(path.resolve('.coverage-v2-disk-'))
  t.after(() => {
    assert.equal(path.dirname(root), process.cwd())
    assert.ok(path.basename(root).startsWith('.coverage-v2-disk-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const previous = Object.fromEntries(['NODE_ENV', 'TRIP_CANDIDATE_DEBUG', 'TRIP_ACCEPTANCE_EVIDENCE_DIR']
    .map(key => [key, process.env[key]]))
  Object.assign(process.env, { NODE_ENV: 'development', TRIP_CANDIDATE_DEBUG: 'true', TRIP_ACCEPTANCE_EVIDENCE_DIR: root })
  try {
    await withAcceptanceEvidence({ input: {} }, { write() {}, json() {}, end() {}, status() { return this } }, async () => {
      captureAcceptanceDiagnostics({ version: 1, qualityDiagnostics: { version: 1 }, ...(omit ? {} : { coverageV2: coverage }) })
      recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const folders = fs.readdirSync(root)
  assert.equal(folders.length, 1)
  const folder = path.join(root, folders[0])
  const serialized = fs.readFileSync(path.join(folder, 'diagnostics.json'), 'utf8')
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files['diagnostics.json'], createHash('sha256').update(serialized).digest('hex'))
  return { saved: JSON.parse(serialized).data, serialized, manifest }
}

function sample(classification = 'C') {
  const f = fixture('city')
  f.plan.stops.forEach(stop => { stop.duration = classification === 'A' ? 110 : 90 })
  recordAiDurations(f.plan)
  recordCoverageSearch(f.candidates, [{ stage: 'initial', query: 'PRIVATE_LOCATION_SEARCH', radiusMeters: 5000,
    status: 'succeeded', count: 4, placeIds: ['PRIVATE_CANDIDATE'] }])
  const remedy = createRemedyTrace()
  remedy.supplementPasses.push({ scope: 'supplied_pool_up_to_three_candidates_two_positions',
    timelineSignature: getRemedyTimelineSignature(f.plan, f.input), pending: classification === 'B' ? 1 : 0,
    eligible: 2, compared: 4, stopReason: 'bounded_scope_evaluated' })
  if (classification === 'D') Object.assign(f.input, { category: 'other', customCategory: '想去博物館' })
  const shadow = assessCoverageV2(f.plan, f.input, f.candidates, remedy, { issues: [], routesFailed: false })
  assert.equal(shadow.classification, classification)
  return { f, remedy, shadow }
}
const row = (id, shadow) => ({ planId: id, shadow })

for (const classification of ['A', 'B', 'C', 'D']) test(`actual diagnostics.json readback preserves ${classification} and all three styles`, async t => {
  const { shadow } = sample(classification)
  const input = { final: ['safe', 'balanced', 'explore'].map(id => row(id, shadow)), attempts: [row('safe', shadow)] }
  const { saved, manifest } = await persist(t, input)
  assert.equal(manifest.status, 'complete', JSON.stringify(manifest.reasons))
  const result = saved.coverageV2
  assert.equal(result.projection.incomplete, false)
  assert.equal(result.final.length, 3)
  assert.equal(result.attempts.length, 1)
  for (const [index, item] of result.final.entries()) {
    assert.equal(item.planId, input.final[index].planId)
    assert.equal(item.shadow.classification, classification)
    assert.equal(item.shadow.stopReason, shadow.stopReason)
    assert.deepEqual(item.shadow.time, shadow.time)
    assert.deepEqual(item.shadow.blockers, shadow.blockers)
    assert.equal(item.shadow.coreSatisfied, shadow.coreSatisfied)
    assert.equal(item.shadow.remedy.supplementPasses[0].pending, shadow.remedy.supplementPasses[0].pending)
    assert.equal(item.shadow.remedy.supplementPasses[0].timelineSignature, undefined)
    assert.match(item.shadow.remedy.supplementPasses[0].timelineSignatureSha256, /^[a-f0-9]{64}$/)
  }
})

test('serialized duration events and retained coverage minutes agree with final time accounting', async t => {
  const { f, remedy } = sample('C')
  const padded = traceDurationPlan(f.plan, { ...f.plan, stops: f.plan.stops.map(stop => ({ ...stop, duration: 120 })) }, 'coverage_target')
  const shrunk = traceDurationPlan(padded, { ...padded, stops: padded.stops.map(stop => ({ ...stop, duration: 100 })) }, 'capacity')
  const shadow = assessCoverageV2(shrunk, f.input, f.candidates, remedy, { issues: [], routesFailed: false })
  const { saved } = await persist(t, { final: [row('safe', shadow)], attempts: [] })
  const read = saved.coverageV2.final[0].shadow
  assert.equal(read.time.actualMinutes, 210)
  assert.equal(read.time.coverageGapMinutes, 15)
  assert.equal(read.time.unarrangedMinutes, 90)
  assert.equal(read.stops.reduce((sum, stop) => sum + stop.finalMinutes, 0) + 10, read.time.actualMinutes)
  for (const [index, stop] of read.stops.entries()) {
    assert.equal(stop.aiOriginalMinutes, 90)
    assert.equal(stop.coverageAddedMinutes, 30)
    assert.equal(stop.coverageRetainedMinutes, 10)
    assert.deepEqual(stop.events.map(e => [e.reason, e.basis, e.before, e.after, e.delta]),
      getDurationTrace(shrunk.stops[index]).events.map(e => [e.reason, e.basis, e.before, e.after, e.delta]))
    assert.equal(stop.initialMinutes + stop.events.reduce((sum, event) => sum + event.delta, 0), stop.finalMinutes)
  }
})

test('disk preserves distinct technical, budget, candidate-insufficient and candidate-pending reasons', async t => {
  const states = []
  for (const reason of ['technical_failure', 'comparison_budget_exhausted', 'bounded_pool_insufficient', 'candidates_remain_unevaluated']) {
    const { f, remedy } = sample('C')
    remedy.technicalFailure = reason === 'technical_failure'
    remedy.budgetExhausted = reason === 'comparison_budget_exhausted'
    Object.assign(remedy.supplementPasses[0], {
      pending: reason === 'candidates_remain_unevaluated' ? 1 : 0,
      eligible: reason === 'bounded_pool_insufficient' ? 0 : 2,
      compared: reason === 'bounded_pool_insufficient' ? 0 : 4,
      stopReason: reason === 'bounded_pool_insufficient' ? 'bounded_pool_insufficient' : 'bounded_scope_evaluated' })
    const shadow = assessCoverageV2(f.plan, f.input, f.candidates, remedy, { issues: [], routesFailed: false })
    assert.equal(shadow.stopReason, reason)
    states.push(row('safe', shadow))
  }
  const { saved } = await persist(t, { final: [], attempts: states })
  assert.deepEqual(saved.coverageV2.attempts.map(item => item.shadow.stopReason),
    ['technical_failure', 'comparison_budget_exhausted', 'bounded_pool_insufficient', 'candidates_remain_unevaluated'])
  assert.equal(saved.coverageV2.attempts[0].shadow.remedy.technicalFailure, true)
  assert.equal(saved.coverageV2.attempts[1].shadow.remedy.budgetExhausted, true)
  assert.equal(saved.coverageV2.attempts[3].shadow.remedy.supplementPasses[0].pending, 1)
})

test('safe disk projection omits arbitrary credentials, prose, raw responses, pools and private locations', async t => {
  const secret = 'SECRET_DO_NOT_PERSIST'
  const { shadow } = sample('C')
  Object.assign(shadow, { token: secret, prompt: secret, candidatePool: [secret], location: { name: secret, lat: 123.456789 } })
  Object.assign(shadow.stops[0], { stopId: secret, placeId: secret, description: secret,
    activityEvidence: { source: 'operator_schedule', reference: `https://private.example/?token=${secret}`, minutes: 60, token: secret } })
  shadow.stops[0].events.push({ reason: secret, basis: secret, before: 90, after: 90, delta: 0, beforePlaceId: secret, afterPlaceId: secret, token: secret })
  shadow.necessaryConditions.hardIssues = [`${secret} 營業時間未知`]
  shadow.remedy.events.push({ kind: 'route', outcome: 'route_failure', details: secret, placeId: secret, rawResponse: { token: secret } })
  shadow.remedy.supplementPasses[0].timelineSignature = secret
  const { saved, serialized, manifest } = await persist(t, { final: [row('safe', shadow)], attempts: [], authorization: secret })
  assert.doesNotMatch(serialized, /SECRET_|PRIVATE_LOCATION|PRIVATE_CANDIDATE|123\.456789|private\.example/)
  const projected = saved.coverageV2.final[0].shadow
  assert.equal(projected.remedy.events[0].outcome, 'route_failure')
  assert.equal(projected.necessaryConditions.hardIssues[0], 'opening_validation')
  assert.match(projected.stops[0].activityEvidence.referenceSha256, /^[a-f0-9]{64}$/)
  assert.equal(projected.stops[0].events[0].reason, null)
  assert.equal(saved.coverageV2.projection.incomplete, true)
  assert.ok(manifest.reasons.includes('coverage_v2_projection_incomplete'))
})

test('oversized and malformed diagnostics are bounded and explicitly incomplete on disk', async t => {
  const { shadow } = sample('C')
  const event = { reason: 'coverage_target', basis: 'coverage_padding', before: 90, after: 91, delta: 1 }
  shadow.stops = Array.from({ length: 500 }, (_, i) => ({ ...shadow.stops[0], stopId: String(i), events: Array(500).fill(event) }))
  shadow.remedy.events = Array(500).fill({ kind: 'route', outcome: 'route_failure', details: 'x'.repeat(100000) })
  shadow.remedy.supplementPasses[0].timelineSignature = 'x'.repeat(70000)
  shadow.search = Array(500).fill({ stage: 'initial', status: 'failed', count: Infinity, query: 'x'.repeat(100000) })
  const entry = row('safe', shadow)
  const { saved, serialized, manifest } = await persist(t, { final: Array(100).fill(entry), attempts: Array(100).fill(entry) })
  assert.ok(Buffer.byteLength(JSON.stringify(saved.coverageV2)) <= 256 * 1024)
  assert.ok(Buffer.byteLength(serialized) < 2 * 1024 * 1024)
  assert.equal(saved.coverageV2.final.length, 3)
  assert.equal(saved.coverageV2.attempts.length, 12)
  assert.equal(saved.coverageV2.projection.incomplete, true)
  assert.ok(saved.coverageV2.projection.reasons.includes('array_truncated'))
  assert.ok(manifest.reasons.includes('coverage_v2_projection_incomplete'))
  assert.ok(saved.coverageV2.final.every(item => item.shadow.time.coverageGapMinutes === 35 && item.shadow.stopReason === 'bounded_scope_evaluated'))
})

test('legacy diagnostics without coverageV2 still serialize and read without inventing shadow results', async t => {
  const { saved, manifest } = await persist(t, null, { omit: true })
  assert.equal(saved.qualityDiagnostics.version, 1)
  assert.equal(Object.hasOwn(saved, 'coverageV2'), false)
  assert.equal(manifest.status, 'complete')
})
