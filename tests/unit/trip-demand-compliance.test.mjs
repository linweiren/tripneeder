import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { intentGroundingFixture } from './fixtures/intent-candidate-grounding.mjs'
import { mockGeneration, runHandler } from './fixtures/plan-identity.mjs'
import { durationQualityFixture, mockDurationQuality } from './fixtures/stop-duration-quality.mjs'

Object.assign(process.env, { NODE_ENV: 'production', TRIP_CANDIDATE_DEBUG: 'false',
  GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only',
  ENABLE_LOCAL_FALLBACK_REFILL: 'false' })
const api = await import('../../api/generate-trip.ts')
const demand = await import('../../api/_lib/trip-demand-compliance.ts')
const { resolveCandidateRankingContext, resolveVisitRequirements } = await import('../../api/_lib/candidate-ranking-context.ts')
const { repairRainBackupStops } = await import('../../api/generate-trip-details.ts')
const { getPlanActualDuration } = await import('../../api/_lib/trip-plan-metrics.ts')
const { getRequiredMealCoverageIssues } = await import('../../api/_lib/trip-quality-rules.ts')
const { getMinimumRequiredActualMinutes, getScheduleCapacityMinutes } = await import('../../api/_lib/trip-planning-rules.ts')

function assertTimingAndLunch(plan, f, original) {
  assert.equal(plan.totalTime, getPlanActualDuration(plan))
  assert.ok(plan.totalTime >= getMinimumRequiredActualMinutes(f.input))
  assert.ok(plan.totalTime <= getScheduleCapacityMinutes(f.input))
  assert.deepEqual(getRequiredMealCoverageIssues(plan, f.input), [])
  const lunch = plan.stops.find(stop => stop.id === original.stops[1].id)
  assert.equal(lunch.type, 'food')
  assert.equal(lunch.duration, 60)
  assert.ok(lunch.googleTypes.includes('restaurant'), 'a refreshment cannot silently replace the existing lunch')
  assert.equal(plan.transportSegments.reduce((sum, leg) => sum + leg.duration, 0), 8)
  plan.transportSegments.forEach((leg, i) => {
    assert.equal(leg.duration, f.routes[`${plan.stops[i].placeId}>${plan.stops[i + 1].placeId}`])
  })
}

// Controlled bodies built from the existing intent/three-style fixture. No model,
// Places, Routes, account or point service is contacted.
function fixture(kind = 'Q2') {
  const f = intentGroundingFixture('mixed')
  const find = type => f.candidates.allCandidates.find(candidate => candidate.types?.includes(type))
  const park = find('park'), meal = find('restaurant'), book = find('book_store'), cafe = find('cafe')
  f.input.customCategory = kind === 'Q3' ? '不要咖啡廳' : '想參觀博物館與美術展覽'
  let chosen = [[park, 90], [meal, 60], [book, 90]]
  if (kind === 'Q3') chosen = [[cafe, 60], [meal, 60], [park, 120]]
  if (kind.startsWith('Q6')) {
    f.input.startTime = '23:00'; f.input.endTime = '01:00'
    f.input.customCategory = '想參觀博物館'
    f.candidates.allCandidates = f.candidates.allCandidates.filter(candidate =>
      !candidate.types?.some(type => ['museum', 'art_gallery'].includes(type)))
    chosen = [[park, 50], [book, 50]]
    if (kind === 'Q6-related') f.candidates.allCandidates.push({ ...book,
      id: 'night-art', placeId: 'night-art', name: '夜間藝術空間', types: ['cultural_center'],
      role: 'main_activity', lat: 22.609, distanceKm: 1, score: 100 })
  }
  // Google filtering uses coordinates, not a fixture's hand-labelled distance.
  f.candidates.allCandidates.forEach((candidate, i) => {
    candidate.lat = 22.6 + i * .0008; candidate.lng = 120.3; candidate.distanceKm = i * .089
  })
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(candidate => candidate.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const a of f.candidates.allCandidates) for (const b of f.candidates.allCandidates) if (a !== b) {
    f.routes[`${a.placeId}>${b.placeId}`] = 4
  }
  f.aiPlans = ['safe', 'balanced', 'explore'].map(type => {
    const stops = chosen.map(([candidate, duration], i) => ({ id: `stop-${i}`, placeId: candidate.placeId,
      name: candidate.name, address: candidate.address, description: '', duration,
      type: candidate.role === 'food' ? 'food' : 'main_activity' }))
    return { ...f.plan, id: type, type, title: `固定${type}`, subtitle: '免費固定回應', summary: '固定測試',
      stops, rainBackup: [], rainTransportSegments: [], transportMode: 'scooter',
      totalTime: stops.reduce((sum, stop) => sum + stop.duration, 0) + (stops.length - 1) * 4,
      transportSegments: stops.slice(1).map((stop, i) => ({ fromStopId: stops[i].id, toStopId: stop.id,
        duration: 4, mode: 'scooter', label: '' })) }
  })
  f.plans = structuredClone(f.aiPlans)
  return f
}

async function generate(t, f, preferenceEvents = []) {
  for (const key of ['info', 'warn', 'error', 'debug']) t.mock.method(console, key, () => {})
  const calls = mockGeneration(t, f, f.aiPlans, undefined, { preferenceEvents })
  if (f.input.startTime === '23:00') {
    const request = https.request
    t.mock.method(https, 'request', (url, options, callback) => request(url, options, response => {
      if (new URL(url).hostname === 'places.googleapis.com') {
        const emit = response.emit
        response.emit = function (event, value, ...rest) {
          if (event === 'data') {
            const place = item => ({ ...item, regularOpeningHours: { periods: [{
              open: { day: 4, hour: 0, minute: 0 }, close: { day: 6, hour: 0, minute: 0 },
            }] } })
            const payload = JSON.parse(value)
            value = Buffer.from(JSON.stringify(payload.places ? { places: payload.places.map(place) } : place(payload)))
          }
          return emit.call(this, event, value, ...rest)
        }
      }
      callback(response)
    }))
  }
  const result = await runHandler(api.default, f)
  assert.ok(result.response, JSON.stringify(result.events))
  return { plans: result.response.plans, warnings: result.response.warnings ?? [], calls, events: result.events }
}

for (const text of ['不想去咖啡廳', '不要去咖啡廳', '不要咖啡廳']) test(`Q3 parser: ${text}`, () => {
  assert.equal(resolveCandidateRankingContext({ ...fixture().input, customCategory: text }).avoidCoffee, true)
})
for (const text of ['不喝咖啡', '想去咖啡廳，但不喝咖啡', '如果下雨就不想去咖啡廳',
  '不想去咖啡廳附近的公園', '朋友說不要咖啡廳', '不是不要咖啡廳']) test(`does not invent a prohibition: ${text}`, () => {
  assert.equal(resolveCandidateRankingContext({ ...fixture().input, customCategory: text }).avoidCoffee, false)
})

test('Q2: existing museum candidates can replace a missing visit in all three lawful styles, without AI retry', async t => {
  const f = fixture(), original = structuredClone(f.aiPlans)
  const { plans, calls, warnings } = await generate(t, f)
  assert.deepEqual(plans.map(plan => plan.type), ['safe', 'balanced', 'explore'])
  for (const plan of plans) {
    assert.deepEqual(demand.assessVisitRequirements(plan, f.input).map(item => [item.label, item.status]),
      [['博物館', 'satisfied'], ['美術展覽', 'satisfied']])
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, f.input, 'Q2-final'), [])
    assert.equal(plan.stops.length, 3)
    assert.ok(plan.stops.some(stop => stop.type === 'food'))
    assertTimingAndLunch(plan, f, original.find(value => value.type === plan.type))
    assert.equal(plan.totalTime, 248)
    assert.deepEqual(plan.stops.filter(stop => stop.type !== 'food').map(stop => stop.duration), [90, 90])
    assert.ok(plan.stops.some(stop => stop.googleTypes.includes('museum')))
    assert.ok(plan.stops.some(stop => stop.googleTypes.includes('art_gallery')))
  }
  assert.deepEqual(f.aiPlans, original)
  assert.equal(calls.ai.length, 1)
  assert.deepEqual(warnings, [])
})

test('Q2 museum-only: replace the omitted book visit while retaining park, lunch, stays and actual routes', async t => {
  const f = fixture(), original = structuredClone(f.aiPlans)
  f.input.customCategory = '想參觀博物館'
  assert.ok(original.every(plan => demand.assessVisitRequirements(plan, f.input, f.candidates)[0].fulfillment === 'not_confirmed'))
  const { plans, warnings } = await generate(t, f)
  for (const plan of plans) {
    const before = original.find(value => value.type === plan.type)
    assertTimingAndLunch(plan, f, before)
    const park = plan.stops.find(stop => stop.placeId === before.stops[0].placeId)
    assert.ok(park, 'the existing outdoor activity is protected in this one-gap fixture')
    assert.equal(park.duration, 90)
    assert.ok(!plan.stops.some(stop => stop.placeId === before.stops[2].placeId))
    const museum = plan.stops.find(stop => stop.googleTypes.includes('museum'))
    assert.ok(museum)
    assert.equal(museum.duration, 90)
    assert.equal(plan.totalTime, before.totalTime)
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, f.input, 'Q2-one-gap'), [])
  }
  assert.deepEqual(warnings, [])
})

test('Q3: all delivered styles exclude confirmed cafes, including diversity replacement and fallback paths', async t => {
  const f = fixture('Q3'), { plans, calls, events } = await generate(t, f)
  assert.equal(plans.length, 3)
  for (const plan of plans) {
    assert.deepEqual(demand.getForbiddenVisitIssues(plan, f.input), [])
    assert.ok(!plan.stops.some(stop => demand.isConfirmedCafe(demand.visitVenue(stop))))
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, f.input, 'Q3-final'), [])
    const before = f.aiPlans.find(value => value.type === plan.type)
    assert.ok(demand.getForbiddenVisitIssues(before, f.input, f.candidates).length)
    assertTimingAndLunch(plan, f, before)
    const park = plan.stops.find(stop => stop.placeId === before.stops[2].placeId)
    assert.ok(park)
    assert.equal(park.duration, 120)
    assert.equal(plan.totalTime, before.totalTime - before.stops[0].duration + plan.stops[0].duration)
  }
  assert.ok(events.filter(event => event.event === 'plan').every(event =>
    !demand.getForbiddenVisitIssues(event.plan, f.input).length))
  assert.equal(calls.ai.length, 1)
})

test('a cafe visit with no coffee drinking remains available in all three styles', async t => {
  const f = fixture('Q3')
  f.input.customCategory = '想去咖啡廳，但不喝咖啡'
  const { plans, warnings, calls } = await generate(t, f)
  assert.equal(plans.length, 3)
  assert.ok(plans.every(plan => demand.assessVisitRequirements(plan, f.input)[0].status === 'satisfied'))
  assert.deepEqual(warnings, [])
  assert.equal(calls.ai.length, 1)
})

test('culture and cafe repair protects lunch and the already fulfilled theme, despite cafe history', async t => {
  const f = fixture()
  f.input.customCategory = '想去博物館與咖啡廳'
  const { plans, warnings } = await generate(t, f, intentGroundingFixture('history-coffee').mockOptions.preferenceEvents)
  for (const plan of plans) {
    assert.ok(demand.assessVisitRequirements(plan, f.input).every(item => item.status === 'satisfied'))
    assert.ok(plan.stops.some(stop => stop.googleTypes?.includes('restaurant')))
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, f.input, 'mixed-final'), [])
  }
  assert.deepEqual(warnings, [])
})

test('museum and art exhibition clauses are checked separately; a museum alone is partial fulfillment', () => {
  const f = fixture(), museum = f.candidates.allCandidates.find(candidate => candidate.types?.includes('museum'))
  const states = demand.assessVisitRequirements({ ...f.plan, stops: [{ ...museum, googleTypes: museum.types }] }, f.input)
  assert.deepEqual(states.map(item => [item.label, item.status]), [['博物館', 'satisfied'], ['美術展覽', 'alternative']])
})

test('already verified cafes cannot bypass replacement through their Maps URL or stale stop types', async t => {
  for (const key of ['info', 'warn', 'error', 'debug']) t.mock.method(console, key, () => {})
  const f = fixture('Q3')
  const grounded = api.applyCandidateGroundingToPlan(f.aiPlans[0], f.candidates)
  grounded.stops[0].googleTypes = ['tourist_attraction']
  assert.ok(grounded.stops[0].googleMapsUrl)
  assert.equal(demand.getForbiddenVisitIssues(grounded, f.input, f.candidates).length, 1)
  mockGeneration(t, f, f.aiPlans)
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates, new Set(), 'verified-ban')
  assert.ok(result.plan)
  assert.deepEqual(demand.getForbiddenVisitIssues(result.plan, f.input, f.candidates), [])
})

test('an impossible confirmed prohibition is not cancelled by repair fallback', async t => {
  for (const key of ['info', 'warn', 'error', 'debug']) t.mock.method(console, key, () => {})
  const f = fixture('Q3')
  const cafes = f.candidates.allCandidates.filter(candidate => demand.isConfirmedCafe(candidate))
  f.candidates = { allCandidates: cafes, firstStopCandidates: cafes, otherCandidates: cafes }
  const grounded = api.applyCandidateGroundingToPlan({ ...f.aiPlans[0], stops: f.aiPlans[0].stops.slice(0, 1),
    transportSegments: [] }, f.candidates)
  mockGeneration(t, f, f.aiPlans)
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates,
    new Set(cafes.map(candidate => candidate.placeId)), 'impossible-ban')
  assert.equal(result.plan, null)
})

test('Q6: missing cultural evidence keeps lawful night alternatives and truthful warnings', async t => {
  const f = fixture('Q6'), { plans, warnings, calls } = await generate(t, f)
  assert.equal(plans.length, 3)
  for (const plan of plans) {
    const assessment = demand.assessVisitRequirements(plan, f.input)[0]
    assert.equal(assessment.status, 'unmet')
    assert.equal(assessment.fulfillment, 'not_confirmed')
    assert.equal(assessment.otherOptionsAvailability, 'unknown')
    assert.ok(plan.stops.every(stop => !stop.googleTypes?.includes('museum')))
    assert.deepEqual(await api.getDeliveryPlanIssues(plan, f.input, 'Q6-final'), [])
  }
  assert.deepEqual(warnings, ['所有方案：未安排可確認符合「博物館」需求的活動；已保留其他可用活動，目前無法確認是否另有合適地點。'])
  assert.equal(calls.ai.length, 1)
})

test('Q6: a verified cultural-space alternative is distinct from a museum visit', async t => {
  const f = fixture('Q6-related'), { plans, warnings, calls } = await generate(t, f)
  for (const plan of plans) assert.equal(demand.assessVisitRequirements(plan, f.input)[0].status, 'alternative')
  assert.ok(warnings.every(warning => warning.includes('替代')))
  assert.equal(calls.ai.length, 1)
})

test('generic attractions and mixed/unknown metadata cannot establish a museum visit', () => {
  const requirement = resolveVisitRequirements(fixture().input)[0]
  for (const venue of [{ name: '文化藝術地標', types: ['tourist_attraction'] },
    { name: '歷史遺址', types: ['historical_landmark'] }, { name: '未確認展覽' },
    { name: '博物館咖啡廳', types: ['museum', 'cafe'], role: 'food' }]) {
    assert.equal(demand.visitRequirementEvidence(requirement, venue), 'unknown')
  }
})

test('Q6 unknown venue evidence is not unknown delivery confirmation or proof that other options do not exist', () => {
  const f = fixture('Q6'), plan = { ...f.plan, stops: [{ id: 'landmark', name: '一般地標',
    type: 'main_activity', duration: 50, googleTypes: ['tourist_attraction'] }] }
  const assessment = demand.assessVisitRequirements(plan, f.input)[0]
  assert.equal(assessment.status, 'unknown')
  assert.equal(assessment.fulfillment, 'not_confirmed')
  assert.equal(assessment.otherOptionsAvailability, 'unknown')
  assert.deepEqual(demand.getVisitRequirementWarnings(plan, f.input),
    ['未安排可確認符合「博物館」需求的活動；已保留其他可用活動，目前無法確認是否另有合適地點。'])
})

for (const [name, types, role, visitType, forbidden] of [
  ['甜點店', ['bakery', 'dessert_shop'], 'food', 'food', false],
  ['甜點店', ['bakery', 'cafe'], 'food', 'food', true],
  ['雙用途餐館', ['restaurant', 'coffee_shop'], 'food', 'food', true],
  ['藝文咖啡空間', ['museum', 'cafe'], 'food', 'food', true],
  ['地方博物館', ['museum', 'cafe'], 'main_activity', 'main_activity', false],
  ['地方博物館', ['museum', 'cafe'], 'main_activity', 'food', true],
  ['名字含咖啡廳的烘焙店', ['bakery'], 'food', 'food', false],
]) test(`Q3 venue evidence: ${name}/${types.join('+')}/${visitType}`, () => {
  const f = fixture('Q3'), candidate = { ...f.candidates.allCandidates[0], name, types, role }
  const stop = { ...candidate, id: 'purpose', type: visitType, googleTypes: types, candidateRole: role, duration: 60 }
  const pool = { allCandidates: [candidate], firstStopCandidates: [candidate], otherCandidates: [candidate] }
  assert.equal(demand.isForbiddenStop(stop, f.input, pool), forbidden)
  for (const key of ['stops', 'rainBackup']) {
    const plan = { ...f.plan, stops: [], rainBackup: [], [key]: [stop] }
    assert.equal(demand.getForbiddenVisitIssues(plan, f.input, pool).length > 0, forbidden)
  }
  // Selection uses venue evidence; a primary cultural candidate remains available
  // for an activity visit, while its independent food visit is still prohibited.
  const venueForbidden = types.some(type => ['cafe', 'coffee_shop'].includes(type)) &&
    !(name === '地方博物館' && role === 'main_activity')
  assert.equal(demand.filterDemandCandidates(pool, f.input).allCandidates.length, venueForbidden ? 0 : 1)
})

test('rain backup filtering cannot reintroduce a forbidden cafe while supplementing indoor venues', () => {
  const f = fixture('Q3')
  const stops = f.candidates.allCandidates.map((candidate, i) => ({ ...candidate, id: `rain-${i}`,
    googleTypes: candidate.types, candidateRole: candidate.role, duration: 60, description: '' }))
  const result = repairRainBackupStops(stops, f.candidates.allCandidates, f.input)
  assert.ok(result.every(stop => !demand.isConfirmedCafe(demand.visitVenue(stop, f.candidates))))
})

test('an impossible positive visit does not accept failing real routes or consume unbounded comparison calls', async t => {
  const f = durationQualityFixture('slow')
  f.input.customCategory = '想參觀博物館'
  // Keep the legal original allocation but remove its cultural purpose evidence.
  for (const stop of f.plan.stops) { stop.name = '一般地標'; stop.googleTypes = ['tourist_attraction'] }
  for (const candidate of f.candidates.allCandidates) { candidate.name = '一般地標'; candidate.types = ['tourist_attraction'] }
  const extra = { ...f.candidates.allCandidates[0], id: 'new-museum', placeId: 'new-museum',
    name: '地方博物館', types: ['museum'], lat: 22.615, score: 120 }
  f.candidates.allCandidates.push(extra)
  f.candidates.otherCandidates.push(extra)
  const { counts } = mockDurationQuality(t, f)
  const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'bounded')
  assert.ok(result.plan)
  assert.deepEqual(result.plan.stops.map(stop => stop.placeId), f.plan.stops.map(stop => stop.placeId))
  assert.ok(counts.routes <= 11)
  assert.equal(counts.ai, 0)
})

for (const kind of ['closed-details', 'weak-stamina', 'capacity']) test(`demand replacement rejects ${kind} regressions`, async t => {
  const f = durationQualityFixture('slow')
  f.input.customCategory = '想參觀博物館'
  for (const value of [...f.plan.stops, ...f.candidates.allCandidates]) {
    if (value.types?.some(type => ['museum', 'art_gallery'].includes(type)) ||
      value.googleTypes?.some(type => ['museum', 'art_gallery'].includes(type))) {
      value.name = '街角書店'; value.types = value.googleTypes = ['book_store']
    }
  }
  const extra = { ...f.candidates.allCandidates[0], id: 'trial-museum', placeId: 'trial-museum',
    name: '地方博物館', types: ['museum'], googleTypes: ['museum'], lat: 22.615, score: 120 }
  f.candidates.allCandidates.push(extra)
  for (const old of f.candidates.allCandidates.filter(candidate => candidate !== extra)) {
    f.routes[`${old.placeId}>${extra.placeId}`] = f.routes[`${extra.placeId}>${old.placeId}`] = kind === 'capacity' ? 100 : 5
  }
  // Candidate Search was optimistic; final Details remains authoritative.
  f.placeOverrides[extra.placeId] = { displayName: { text: extra.name }, types: extra.types,
    ...(kind === 'closed-details' ? { regularOpeningHours: { periods: [] } } : {}) }
  for (const candidate of f.candidates.allCandidates.filter(candidate => candidate !== extra)) {
    f.placeOverrides[candidate.placeId].displayName = { text: candidate.name }
    f.placeOverrides[candidate.placeId].types = candidate.types
  }
  const { counts } = mockDurationQuality(t, f)
  const original = f.plan.stops.map(stop => stop.placeId)
  const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(),
    'guarded-demand', new Set(), undefined, kind === 'weak-stamina' ? '弱' : '普通')
  assert.ok(result.plan)
  assert.deepEqual(result.plan.stops.map(stop => stop.placeId), original)
  assert.equal(counts.ai, 0)
  assert.ok(counts.routes <= 11)
})

test('a closed museum trial gives way to a feasible cultural alternative, with truthful status', async t => {
  const f = durationQualityFixture('slow')
  f.input.customCategory = '想參觀博物館'
  for (const value of [...f.plan.stops, ...f.candidates.allCandidates]) {
    if (value.types?.some(type => ['museum', 'art_gallery'].includes(type)) ||
      value.googleTypes?.some(type => ['museum', 'art_gallery'].includes(type))) {
      value.name = '街角書店'; value.types = value.googleTypes = ['book_store']
    }
  }
  const base = f.candidates.allCandidates[0]
  const museum = { ...base, id: 'closed-museum', placeId: 'closed-museum', name: '地方博物館',
    types: ['museum'], googleTypes: ['museum'], lat: 22.615, score: 120 }
  const alternative = { ...base, id: 'related-art', placeId: 'related-art', name: '藝術空間',
    types: ['cultural_center'], googleTypes: ['cultural_center'], lat: 22.616, score: 100 }
  f.candidates.allCandidates.push(museum, alternative)
  f.placeOverrides[museum.placeId] = { displayName: { text: museum.name }, types: museum.types,
    regularOpeningHours: { periods: [] } }
  f.placeOverrides[alternative.placeId] = { displayName: { text: alternative.name }, types: alternative.types }
  for (const old of f.candidates.allCandidates.filter(candidate => candidate !== museum && candidate !== alternative)) {
    f.placeOverrides[old.placeId].displayName = { text: old.name }
    f.placeOverrides[old.placeId].types = old.types
    for (const extra of [museum, alternative]) {
      f.routes[`${old.placeId}>${extra.placeId}`] = f.routes[`${extra.placeId}>${old.placeId}`] = 4
    }
  }
  const { counts } = mockDurationQuality(t, f)
  const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'related-demand')
  assert.ok(result.plan)
  assert.ok(result.plan.stops.some(stop => stop.placeId === alternative.placeId))
  assert.ok(!result.plan.stops.some(stop => stop.placeId === museum.placeId))
  assert.equal(demand.assessVisitRequirements(result.plan, f.input)[0].status, 'alternative')
  assert.match(demand.getVisitRequirementWarnings(result.plan, f.input)[0], /替代/)
  assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input, 'related-final'), [])
  assert.ok(counts.routes <= 11)
  assert.equal(counts.ai, 0)
})
