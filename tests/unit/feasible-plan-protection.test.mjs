import test from 'node:test'
import assert from 'node:assert/strict'
import { durationQualityFixture, mockDurationQuality } from './fixtures/stop-duration-quality.mjs'

Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only',
  TRIP_CANDIDATE_DEBUG: 'false' })
const api = await import('../../api/generate-trip.ts')
const { optionalActivityFixture } = await import('./fixtures/optional-activity-quality.mjs')
const { assessVisitRequirements, getForbiddenVisitIssues } = await import('../../api/_lib/trip-demand-compliance.ts')
const { compareOriginalActivities } = await import('../../api/_lib/trip-activity-purpose.ts')
const { getCoverageShadow } = await import('../../api/_lib/trip-coverage-v2.ts')
const { getPlanActualDuration } = await import('../../api/_lib/trip-plan-metrics.ts')

// Observe real function boundaries, not a substituted optimizer or a second repair.
// All imports are tracked fixtures. mockDurationQuality blocks live fetch/HTTPS.
async function run(t, f, used = new Set()) {
  const source = structuredClone(f.plan), pool = structuredClone(f.candidates)
  const { counts, legs } = mockDurationQuality(t, f)
  const attempts = [], transitions = []
  const debug = {
    beginRepairAttempt(_plan, phase) { attempts.push(phase); return phase },
    recordPlanTransition(before, after, phase, context) {
      if (!phase.startsWith('duration-redistribution:') &&
        !phase.startsWith('fallback:activity-diversity-')) return
      transitions.push({ before, after, phase, context,
        beforeSnapshot: structuredClone(before), afterSnapshot: structuredClone(after),
        counts: { ...counts }, repairs: attempts.length })
    },
  }
  const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
    new Set(), 'feasible-protection-contract', used, debug)
  assert.deepEqual(f.plan, source, 'the source is not modified in place')
  assert.deepEqual(f.candidates, pool, 'trials do not modify shared candidate evidence')
  assert.ok(attempts.length <= 3, JSON.stringify(attempts))
  assert.equal(legs.length, new Set(legs).size, 'reuse successful and failed edges within the repair')
  return { f, result, counts, legs, attempts, transitions }
}

async function assertDelivered(row) {
  const { f, result, counts } = row
  assert.ok(result.plan)
  assert.equal(result.routesFailed, false)
  assert.deepEqual(result.issues, [])
  const before = { ...counts }
  assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input,
    'feasible-protection-final', { candidates: f.candidates }), [])
  assert.deepEqual(getForbiddenVisitIssues(result.plan, f.input, f.candidates), [])
  assert.equal(result.plan.totalTime, getPlanActualDuration(result.plan))
  assert.equal(result.plan.transportSegments.length, result.plan.stops.length - 1)
  result.plan.transportSegments.forEach((leg, i) => {
    assert.equal(leg.fromStopId, result.plan.stops[i].id)
    assert.equal(leg.toStopId, result.plan.stops[i + 1].id)
    assert.equal(leg.duration, f.routes[`${result.plan.stops[i].placeId}>${result.plan.stops[i + 1].placeId}`])
    assert.ok(!leg.label.includes('(估算)'))
  })
  assert.deepEqual(counts, before, 'final audit uses already populated evidence')
}

function record(t, row) {
  t.diagnostic(JSON.stringify({ style: row.f.plan.type, returned: Number(Boolean(row.result.plan)),
    complete: Number(Boolean(row.result.plan && !row.result.routesFailed &&
      getCoverageShadow(row.result.plan)?.deliveryDecision.status === 'complete')),
    routesFailed: row.result.routesFailed, calls: row.counts, repairs: row.attempts.length,
    // This entry invokes repair only; it never enters handler retry/refill.
    retry: 0, refill: 0, impact: row.result.plan &&
      compareOriginalActivities(row.f.plan.stops, row.result.plan.stops),
    decisions: row.transitions.map(item => ({ phase: item.phase, reason: item.context.reason })) }))
}

for (const style of ['safe', 'balanced', 'explore']) {
  test(`${style}: closing-buffer rejection preserves the complete validated result by identity`, async t => {
    const row = await run(t, durationQualityFixture('early-close', style))
    await assertDelivered(row)
    const [trial] = row.transitions
    assert.equal(row.transitions.length, 1)
    assert.equal(trial.phase, 'duration-redistribution:rejected')
    assert.match(trial.context.reason, /opening_hours_or_closing_buffer/)
    assert.equal(row.result.plan, trial.before, 'return the whole original result, not reconstructed stops')
    assert.deepEqual(row.result.plan, trial.beforeSnapshot)
    assert.deepEqual(trial.after, trial.afterSnapshot)
    assert.notDeepEqual(trial.after.stops, trial.before.stops)
    assert.notEqual(trial.after.stops, trial.before.stops)
    trial.after.stops.forEach((stop, i) => assert.notEqual(stop, trial.before.stops[i]))
    // Duration-only trials deliberately reuse the unchanged route array read-only.
    assert.equal(row.result.plan.transportSegments, trial.before.transportSegments)
    assert.deepEqual(row.counts, trial.counts)
    assert.equal(row.attempts.length, trial.repairs, 'no repair after the rejected trial')
    assert.deepEqual(row.counts, { places: 4, routes: 3, ai: 0 })
    assert.ok(assessVisitRequirements(row.result.plan, row.f.input, row.f.candidates)
      .every(requirement => requirement.status === 'satisfied'))
    record(t, row)
  })
}

test('a lunch-conflicting redistribution preserves all timing, route and activity fields', async t => {
  const row = await run(t, durationQualityFixture('late-lunch'))
  await assertDelivered(row)
  const [trial] = row.transitions
  assert.equal(row.transitions.length, 1)
  assert.match(trial.context.reason, /required_meal_window/)
  assert.equal(row.result.plan, trial.before)
  assert.deepEqual(row.result.plan, trial.beforeSnapshot)
  assert.deepEqual(row.counts, trial.counts)
  assert.equal(row.attempts.length, trial.repairs)
  record(t, row)
})

for (const failure of ['opening', 'capacity', 'routes']) {
  test(`optional venue ${failure} failure selects a complete lawful fallback with its own routes`, async t => {
    // Unique fixture IDs keep cached Details from another case from hiding a failure.
    const f = optionalActivityFixture(`atomic-${failure}`)
    f.plan.scheduleStartTime = f.input.startTime
    const meal = f.plan.stops[1]
    if (failure === 'opening') f.placeOverrides[f.alternative.placeId].regularOpeningHours = {
      periods: Array.from({ length: 7 }, (_, day) => ({
        open: { day, hour: 0, minute: 0 }, close: { day, hour: 10, minute: 30 },
      })),
    }
    if (failure === 'capacity') f.routes[`${f.alternative.placeId}>${meal.placeId}`] = 200
    if (failure === 'routes') delete f.routes[`${f.alternative.placeId}>${meal.placeId}`]
    const row = await run(t, f, new Set([f.museum.placeId]))
    await assertDelivered(row)
    const selected = row.transitions.find(item => item.phase === 'fallback:activity-diversity-selected')
    assert.ok(selected)
    assert.equal(selected.before.stops[0].placeId, f.alternative.placeId)
    assert.equal(selected.after.stops[0].placeId, f.museum.placeId)
    assert.deepEqual(row.result.plan, selected.afterSnapshot)
    assert.deepEqual(selected.before, selected.beforeSnapshot)
    assert.deepEqual(selected.after, selected.afterSnapshot)
    assert.deepEqual(row.counts, selected.counts, 'acceptance does not add remote validation')
    assert.equal(row.attempts.length, selected.repairs)
    assert.equal(row.attempts.filter(phase => phase.includes('diversity-fallback')).length, 1)
    assert.equal(compareOriginalActivities(f.plan.stops, row.result.plan.stops).retainedStayLoss, 0)
    record(t, row)
  })
}

for (const kind of ['route-gain', 'demand-gain']) {
  test(`${kind}: confirmed improvement is not displaced by automatic original preference`, async t => {
    const f = optionalActivityFixture(kind)
    const row = await run(t, f, new Set([f.museum.placeId]))
    await assertDelivered(row)
    assert.equal(row.result.plan.stops[0].placeId, f.alternative.placeId)
    assert.ok(assessVisitRequirements(row.result.plan, f.input, f.candidates)
      .every(requirement => requirement.status === 'satisfied'))
    assert.equal(compareOriginalActivities(f.plan.stops, row.result.plan.stops).retainedStayLoss, 0)
    assert.equal(row.attempts.length, kind === 'route-gain' ? 2 : 1)
    assert.equal(row.counts.routes, kind === 'route-gain' ? 3 : 2)
    record(t, row)
  })
}

test('raw AI timing and declared total never replace actual route resolution', async t => {
  const f = durationQualityFixture('slow')
  f.plan.transportSegments = f.plan.transportSegments.map(leg => ({ ...leg, duration: 1 }))
  f.plan.totalTime = 225
  const row = await run(t, f)
  await assertDelivered(row)
  assert.notEqual(row.result.plan, f.plan)
  assert.equal(row.result.plan.totalTime, 300)
  assert.deepEqual(row.result.plan.transportSegments.map(leg => leg.duration), [4, 4, 4])
  assert.deepEqual(row.counts, { places: 4, routes: 3, ai: 0 })
  record(t, row)
})

for (const failure of ['opening', 'capacity', 'meal', 'coverage', 'routes']) {
  test(`invalid original ${failure} evidence cannot be restored or reported as normal completion`, async t => {
    const f = durationQualityFixture(`invalid-original-${failure}`)
    if (failure === 'opening') for (const place of Object.values(f.placeOverrides)) {
      place.regularOpeningHours = { periods: Array.from({ length: 7 }, (_, day) => ({
        open: { day, hour: 0, minute: 0 }, close: { day, hour: 9, minute: 0 },
      })) }
    }
    if (failure === 'capacity') f.input.endTime = '10:30'
    if (failure === 'meal') {
      f.input.customCategory = '想參觀博物館'
      for (const stop of [f.plan.stops[1], f.candidates.allCandidates[1]]) {
        Object.assign(stop, { type: 'main_activity', role: 'main_activity', candidateRole: 'main_activity',
          name: '地方第二文物館', types: ['museum'], googleTypes: ['museum'], foodSubtype: undefined })
      }
      f.placeOverrides[f.plan.stops[1].placeId].types = ['museum']
      f.placeOverrides[f.plan.stops[1].placeId].displayName.text = '地方第二文物館'
    }
    if (failure === 'coverage') {
      f.plan.stops = f.plan.stops.slice(0, 2)
      f.plan.stops[0].name = '市民服務中心'
      f.plan.stops[0].duration = 40
      f.plan.transportSegments = f.plan.transportSegments.slice(0, 1)
      f.candidates.allCandidates = f.candidates.allCandidates.slice(0, 2)
      f.candidates.allCandidates[0].name = f.plan.stops[0].name
      f.candidates.firstStopCandidates = f.candidates.otherCandidates = f.candidates.allCandidates
      f.placeOverrides[f.plan.stops[0].placeId].displayName.text = f.plan.stops[0].name
      f.input.tags = ['no_full_meals']
    }
    if (failure === 'routes') f.failRoutes = true
    const row = await run(t, f)
    assert.ok(!row.transitions.some(item => item.phase === 'duration-redistribution:accepted'))
    if (failure === 'routes') {
      assert.equal(row.result.routesFailed, true)
      if (row.result.plan) {
        assert.notEqual(getCoverageShadow(row.result.plan).deliveryDecision.status, 'complete')
        assert.ok(row.result.plan.transportSegments.every(leg => leg.label.includes('(估算)')))
      }
    } else {
      assert.equal(row.result.plan, null)
      const reason = { opening: /營業/, capacity: /超出可安排時間/,
        meal: /餐飲|餐|午/, coverage: /行程時長不足/ }[failure]
      assert.match(row.result.issues.join(' '), reason)
    }
    assert.equal(row.counts.ai, 0)
    record(t, row)
  })
}

test('mixed style outcomes preserve the earlier complete result without sharing failure state', async t => {
  const rows = []
  const used = new Set()
  for (const [style, kind] of [['safe', 'early-close'], ['balanced', 'pressure'],
    ['explore', 'mixed-invalid-capacity']]) {
    await t.test(style, async child => {
      const f = durationQualityFixture(kind, style)
      if (style === 'explore') f.input.endTime = '10:30'
      const row = await run(child, f, used)
      if (style === 'explore') {
        assert.equal(row.result.plan, null)
      } else {
        await assertDelivered(row)
        assert.equal(row.result.plan.id, style)
        assert.equal(row.result.plan.type, style)
        row.result.plan.stops.forEach(stop => used.add(stop.placeId))
      }
      rows.push({ row, snapshot: structuredClone(row.result) })
    })
  }
  assert.deepEqual(rows.map(({ row }) => Boolean(row.result.plan)), [true, true, false])
  assert.equal(rows[0].row.transitions[0].phase, 'duration-redistribution:rejected')
  assert.equal(rows[1].row.transitions[0].phase, 'duration-redistribution:accepted')
  for (const { row, snapshot } of rows) {
    assert.deepEqual(row.result, snapshot, 'later styles cannot modify an earlier result')
    record(t, row)
  }
})
