// Explicit transport-contract delta. Itinerary quality and paid provider calls
// remain compared exactly; old provisional content becomes metadata only.
import assert from 'node:assert/strict'

export const deliveryDisclosure = warning => /合併顯示|^目前僅 \d+ 個風格方案通過驗收/.test(warning)

// Independent comparison of the delivered choices; do not call the production
// predicate from assertions intended to catch regressions in that predicate.
export function assertHonestDeliveryChoices(response, expectedStyles) {
  assert.ok(response.plans.length > 0)
  if (expectedStyles) assert.deepEqual(response.plans.map(plan => plan.type), expectedStyles)
  const route = plan => JSON.stringify([plan.transportMode, plan.stops.map(stop => stop.placeId || [stop.name, stop.address])])
  for (const [index, plan] of response.plans.entries()) for (const other of response.plans.slice(index + 1)) {
    if (route(plan) !== route(other)) continue
    const minutes = time => time ? Number(time.slice(0,2))*60 + Number(time.slice(3)) : null
    const a = minutes(plan.scheduleStartTime), b = minutes(other.scheduleStartTime)
    const gap = a !== null && b !== null ? Math.min(Math.abs(a-b), 1440-Math.abs(a-b)) : 0
    assert.ok(gap >= 30
      || plan.stops.reduce((sum, stop, i) => sum + Math.abs(stop.duration-other.stops[i].duration),0) >= 30,
    'same route must offer a real start/depth difference')
  }
  if (response.plans.length < 3) assert.ok(response.warnings?.some(warning => warning.includes('合併顯示')))
}

export function paidEventsFromLegacy(events) {
  return events.flatMap(event => event.event === 'plan'
    ? [{ event: 'progress', style: event.plan.type, stage: 'validating' }]
    : event.event === 'done' ? [...event.response.plans.map(plan => ({ event: 'plan', plan })), event] : [event])
}

export function withoutPaymentPersistence(calls) {
  return calls.filter(call => {
    const url = new URL(call.url)
    return !(url.hostname === 'unit-test.supabase.co' && (url.pathname === '/auth/v1/user'
      || /\/(claim_trip_generation|complete_paid_trip_generation|fail_trip_generation|consume_points_for_analysis|trip_generations)$/.test(url.pathname)))
  }).map(call => {
    if (!call.init) return call
    const { signal: _cancellationSignal, ...init } = call.init
    return { ...call, init }
  })
}

// Approved final-delivery delta only. Frozen research results are never rewritten:
// retained stops/routes remain byte-identical, omitted choices need an earlier
// equivalent actual route, and changed amounts must carry the explicit estimate.
export function assertDeliveryData(actual, baseline, { ignoreText = false, additionalWarnings = [] } = {}) {
  assert.equal(Boolean(actual), Boolean(baseline))
  if (!actual) return
  const route = p => JSON.stringify([p.transportMode, p.stops.map(s => s.placeId || [s.name, s.address])])
  const strip = p => Object.fromEntries(Object.entries(p).filter(([key]) =>
    !['budget', 'budgetEstimateNote', ...(ignoreText ? ['title', 'subtitle', 'summary'] : [])].includes(key)))
  for (const plan of actual.plans) {
    const old = baseline.plans.find(p => p.id === plan.id)
    assert.ok(old, 'no invented/relabelled style')
    assert.deepEqual(strip(plan), strip(old), 'all non-budget itinerary fields stay identical')
    if (plan.budget !== old.budget || plan.budgetEstimateNote !== old.budgetEstimateNote) {
      assert.match(plan.budgetEstimateNote, /^以\d+人基準、餐飲每站350元、其他停留120元粗估/)
      assert.match(plan.budgetEstimateNote, /非票價或店家報價/)
      const people = Number(/^以(\d+)人/.exec(plan.budgetEstimateNote)[1])
      assert.equal(plan.budget, Math.max(300, Math.round(plan.stops.reduce((n, s) => n + (s.type === 'food' ? 350 : 120), 0) * people / 2)))
    }
  }
  for (const [index, old] of baseline.plans.entries()) {
    if (actual.plans.some(p => p.id === old.id)) continue
    const representative = actual.plans.find(p => baseline.plans.findIndex(old => old.id === p.id) < index
      && route(p) === route(old) && p.stops.reduce((n, s, i) => n + Math.abs(s.duration - old.stops[i].duration), 0) < 30
      && (p.scheduleStartTime === old.scheduleStartTime))
    assert.ok(representative, `omitted ${old.id} must have an earlier equivalent choice`)
    assert.ok(actual.warnings?.some(w => w.includes('合併顯示')), 'deduplication must be disclosed')
  }
  assert.equal(actual.plans.length > 0, baseline.plans.length > 0)
  const warningText = value => value.replace(/^(?:所有方案|(?:保守方案|平衡方案|探索方案)(?:、(?:保守方案|平衡方案|探索方案))*)：/, '')
  const oldWarnings = (baseline.warnings ?? []).filter(w => !/^目前僅 \d+ 個風格方案通過驗收/.test(w)).map(warningText)
  const currentWarnings = (actual.warnings ?? []).map(warningText)
  for (const warning of oldWarnings) assert.ok(currentWarnings.includes(warning), `existing warning preserved: ${warning}`)
  for (const warning of currentWarnings) assert.ok(oldWarnings.includes(warning) || additionalWarnings.some(pattern => pattern.test(warning)) || /合併顯示|^目前僅 \d+ 個風格方案通過驗收/.test(warning), `only approved delivery disclosures added: ${warning}`)
}

export function assertPaidGenerationEvents(actual, legacy, response) {
  const control = events => events.filter(e => !['plan', 'done'].includes(e.event)).map(event => {
    if (event.event !== 'progress') return event
    const { preview, ...rest } = event
    if (preview) {
      assert.deepEqual(Object.keys(preview).sort(), ['highlights', 'sampleVenueNames', 'stopCount', 'type'])
      assert.equal(preview.type, rest.style)
      assert.ok(Array.isArray(preview.sampleVenueNames) && preview.sampleVenueNames.length <= 1)
      assert.ok(preview.sampleVenueNames.every(name => typeof name === 'string' && name.length <= 80))
      assert.ok(preview.highlights.every(value => ['戶外活動', '文化場館', '咖啡停留', '餐飲停留', '主要活動', '休息與轉場'].includes(value)))
    }
    return rest
  })
  assert.deepEqual(control(actual), control(paidEventsFromLegacy(legacy)), 'progress/warnings outside the approved safe preview stay identical')
  assert.ok(new Set(actual.flatMap(event => event.preview?.sampleVenueNames ?? [])).size <= 1,
    'all styles and revisions together expose at most one sampled venue')
  if (!response) return
  assert.deepEqual(actual.filter(e => e.event === 'plan').map(e => e.plan), response.plans)
  assert.deepEqual(actual.find(e => e.event === 'done')?.response, response)
}
