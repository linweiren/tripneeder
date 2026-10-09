import test from 'node:test'
import assert from 'node:assert/strict'
import { suitabilityFixture } from './fixtures/meal-suitability.mjs'
import { FIXED_NOW, mockMatrix } from './fixtures/supplement-quality.mjs'
import { compareOriginalActivities } from '../../api/_lib/trip-activity-purpose.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const api = await import('../../api/generate-trip.ts')

function fixture(kind) {
  const f = suitabilityFixture(kind === 'mismatch' ? 'museum-id-mismatch' : 'museum-coherent')
  const originalIds = new Map(f.candidates.allCandidates.map(c => [c.placeId, `${c.placeId}-${kind}`]))
  f.plan.stops = f.plan.stops.map(s => ({ ...s, id: `${s.id}-${kind}`, placeId: originalIds.get(s.placeId) }))
  f.candidates.allCandidates = f.candidates.allCandidates.map(c => ({ ...c,
    id: `${c.id}-${kind}`, placeId: originalIds.get(c.placeId) }))
  const [museum, river] = f.candidates.allCandidates
  museum.types = ['museum']
  river.types = ['park']
  f.museum = museum
  if (['culture', 'weak-culture', 'closed-culture', 'optional-closed', 'three-plans', 'far-culture', 'costly-culture'].includes(kind)) {
    f.culture = { ...museum, id: `${museum.id}-alternative`, placeId: `${museum.placeId}-alternative`,
      name: '地方文化館', lat: 22.607, distanceKm: 1, score: kind === 'weak-culture' ? 70 : 99 }
    f.candidates.allCandidates.push(f.culture)
    if (kind === 'far-culture') f.culture.distanceKm = 2.5
    if (kind === 'optional-closed') f.culture.openingHours = { ...f.culture.openingHours, windows: [{
      openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + (10 * 60 + 30) * 60000),
    }] }
  }
  if (kind.startsWith('closed')) museum.openingHours = { ...museum.openingHours, windows: [{
    openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + (10 * 60 + 30) * 60000),
  }] }
  if (kind === 'food-first') f.input.tags = ['food_first']
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 4
  }
  if (kind === 'costly-culture') f.routes[`${f.culture.placeId}>${f.plan.stops[1].placeId}`] = 90
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({
    fromStopId: f.plan.stops[i].id, toStopId: s.id, mode: 'scooter',
    duration: f.routes[`${f.plan.stops[i].placeId}>${s.placeId}`], label: '',
  }))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(c => [c.placeId,
    { displayName: { text: c.name }, types: c.types ?? [] }]))
  if (kind.startsWith('closed')) f.placeOverrides[museum.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 10, minute: 30 } })),
  }
  if (kind === 'optional-closed') f.placeOverrides[f.culture.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 10, minute: 30 } })),
  }
  return f
}

async function deliver(t, kind, crossUsed = true, ground = false) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = fixture(kind)
  const originals = structuredClone(f.plan.stops)
  const calls = mockMatrix(t, f)
  const start = ground ? api.applyCandidateGroundingToPlan(f.plan, f.candidates) : f.plan
  const result = await api.repairAndValidatePlanForDelivery(start, f.input, f.candidates,
    new Set(), 'purpose-regression', new Set(crossUsed ? [f.museum.placeId] : []))
  assert.ok(result.plan, JSON.stringify(result.issues))
  assert.equal(result.routesFailed, false)
  assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input, 'purpose-final',
    { candidates: f.candidates }), [])
  const impact = compareOriginalActivities(originals, result.plan.stops)
  t.diagnostic(JSON.stringify({ kind, impact, routeCalls: calls.length,
    selected: result.plan.stops.map(s => ({ name: s.name, type: s.type, duration: s.duration })) }))
  return { f, result, impact, originals, calls, start }
}

test('cross-plan diversity retains a coherent museum rather than converting it to food', async t => {
  const { f, result, impact, calls } = await deliver(t, 'reuse')
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(result.plan.stops[0].duration, 90)
  assert.equal(impact.identityChanges, 0)
  assert.equal(impact.purposeChanges, 0)
  assert.equal(result.plan.stops.filter(s => s.type === 'food').length, 1)
  assert.equal(calls.length, 2)
})

test('comparable nearby cultural alternatives preserve purpose and soft diversity', async t => {
  const { f, result, impact } = await deliver(t, 'culture')
  assert.equal(result.plan.stops[0].placeId, f.culture.placeId)
  assert.equal(impact.identityChanges, 1)
  assert.equal(impact.purposeChanges, 0)
})

test('a weak cultural alternative does not force replacement of a good repeated museum', async t => {
  const { f, result, impact } = await deliver(t, 'weak-culture')
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(impact.purposeChanges, 0)
})

test('closed original activity still accepts an available cultural replacement', async t => {
  const { f, result, impact } = await deliver(t, 'closed-culture', false)
  assert.equal(result.plan.stops[0].placeId, f.culture.placeId)
  assert.equal(impact.identityChanges, 1)
  assert.equal(impact.purposeChanges, 0)
})

test('necessary safety replacement can cross purpose without inheriting museum duration', async t => {
  const { f, result, impact } = await deliver(t, 'closed-food', false)
  const replacement = result.plan.stops.find(s => s.id === f.plan.stops[0].id)
  assert.equal(replacement.type, 'food')
  assert.equal(replacement.duration, 60)
  assert.equal(impact.purposeChanges, 1)
  assert.equal(impact.purposeLostMinutes, 90)
})

test('locally verified unique museum name resolves a conflicting restaurant ID before delivery', async t => {
  const { f, result, impact, start, originals } = await deliver(t, 'mismatch', false, true)
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(result.plan.stops[0].type, 'main_activity')
  assert.equal(impact.identityChanges, 1)
  assert.equal(impact.purposeChanges, 0)
  // The diagnostic must retain the AI's conflicting ID, not just the grounded snapshot.
  assert.deepEqual(api.getOriginalActivityImpact(start, result.plan.stops),
    compareOriginalActivities(originals, result.plan.stops))
})

test('food-first keeps explicitly requested consecutive food stops', async t => {
  const f = fixture('food-first')
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const food = f.candidates.allCandidates.filter(c => c.role === 'food')
  f.plan.stops = [...food.map((c, i) => ({ ...c, id: `tour-${i}`, type: 'food', duration: 75 })), f.plan.stops[2]]
  const calls = mockMatrix(t, f)
  const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'food-tour')
  assert.ok(result.plan)
  assert.equal(result.plan.stops.filter(s => s.type === 'food').length, 2)
  assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input, 'food-tour-final', { candidates: f.candidates }), [])
  assert.equal(calls.length, 2)
})

test('original skeleton diagnostics distinguish shortening, identity, purpose and removal', () => {
  const originals = fixture('diagnostics').plan.stops
  const final = [{ ...originals[0], duration: 70 }, { ...originals[1], placeId: 'different-park', type: 'main_activity', name: '城市公園' }]
  assert.deepEqual(compareOriginalActivities(originals, final), { retainedStayLoss: 20,
    removedStops: 1, identityChanges: 1, purposeChanges: 1, identityLostMinutes: 165, purposeLostMinutes: 165 })
})

test('a closed optional cultural alternative cannot displace the available original', async t => {
  const { f, result, impact } = await deliver(t, 'optional-closed')
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(impact.purposeChanges, 0)
})

test('optional cultural variety cannot compress the useful original skeleton after real routing', async t => {
  const { f, result, impact, calls } = await deliver(t, 'costly-culture')
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(impact.retainedStayLoss, 0)
  assert.equal(impact.purposeChanges, 0)
  assert.ok(calls.length <= 4)
})

test('purpose similarity never admits a first stop beyond the existing 2km gate', async t => {
  const { f, result } = await deliver(t, 'far-culture')
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  // Even if a producer erroneously included the far entry, selection keeps the gate.
  f.candidates.firstStopCandidates.push(f.culture)
  const selected = api.pickCandidateForStop(f.plan.stops[0], 0, f.candidates, new Set(), new Set(),
    new Set([f.museum.placeId]))
  assert.equal(selected.placeId, f.museum.placeId)
})

test('unsupported aliases continue using the verified ID rather than guessing by type', async t => {
  const f = fixture('alias')
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const raw = { ...f.plan, stops: [{ ...f.plan.stops[0], name: '在地收藏館別名' }, ...f.plan.stops.slice(1)] }
  const grounded = api.applyCandidateGroundingToPlan(raw, f.candidates)
  const calls = mockMatrix(t, f)
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates, new Set(), 'alias-final')
  assert.ok(result.plan)
  assert.equal(result.plan.stops[0].placeId, f.museum.placeId)
  assert.equal(result.plan.stops[0].duration, 90)
  assert.equal(calls.length, 2)
})

test('ambiguous exact names do not override a verified supplied ID', async t => {
  const f = fixture('ambiguous')
  const duplicate = { ...f.museum, id: 'second-museum', placeId: 'second-museum', lat: 22.607 }
  f.candidates.firstStopCandidates.push(duplicate)
  f.candidates.allCandidates.push(duplicate)
  const raw = { ...f.plan, stops: [{ ...f.plan.stops[0], placeId: f.candidates.allCandidates[3].placeId },
    ...f.plan.stops.slice(1)] }
  const grounded = api.applyCandidateGroundingToPlan(raw, f.candidates)
  assert.equal(grounded.stops[0].placeId, raw.stops[0].placeId)
  assert.equal(grounded.stops[0].type, 'food')
  assert.equal(grounded.stops[0].duration, 60)
  // Ambiguity is surfaced by the raw-skeleton metric instead of being hidden as zero loss.
  assert.equal(api.getOriginalActivityImpact(grounded, grounded.stops).purposeChanges, 1)
})

test('three delivered plans preserve purpose, diversify when possible, and safely reuse', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const used = new Set()
  const firstStops = []
  const rows = []
  for (const id of ['safe', 'balanced', 'explore']) {
    const f = fixture('three-plans')
    f.plan.id = f.plan.type = id
    const originals = structuredClone(f.plan.stops)
    const calls = mockMatrix(t, f)
    const grounded = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
    const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates,
      new Set(), 'three-purpose-plans', used)
    assert.ok(result.plan, JSON.stringify(result.issues))
    assert.equal(result.routesFailed, false)
    assert.deepEqual(await api.getDeliveryPlanIssues(result.plan, f.input, 'three-purpose-final',
      { candidates: f.candidates }), [])
    assert.equal(compareOriginalActivities(originals, result.plan.stops).purposeChanges, 0)
    assert.equal(result.plan.stops.filter(stop => stop.type === 'food').length, 1)
    firstStops.push(result.plan.stops[0].placeId)
    result.plan.stops.forEach(stop => used.add(stop.placeId))
    rows.push({ id, routeCalls: calls.length, first: result.plan.stops[0].name })
    t.mock.restoreAll()
  }
  assert.notEqual(firstStops[0], firstStops[1])
  assert.equal(firstStops[2], firstStops[0])
  t.diagnostic(JSON.stringify(rows))
})
