import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { resolveCandidateRankingContext, resolveVisitRequirements } from '../../api/_lib/candidate-ranking-context.ts'
import { createDReplay, dFixture } from './fixtures/context-aware-search-d.mjs'
import { searchFixture } from './fixtures/context-aware-search.mjs'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/_lib/google-places.ts')
// Compare with the requested production baseline, including its optional search.
const sourceUrl = new URL('../../api/_lib/google-places.ts', import.meta.url)
const committed = execFileSync('git', ['show', '2356ec216fc49542a055a9c855668bee3fa983d6:api/_lib/google-places.ts'],
  { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
const source = stripTypeScriptTypes(committed).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) =>
  `from ${quote}${specifier.startsWith('.') ? new URL(specifier.replace(/\.js$/, '.ts'), sourceUrl).href : specifier}${quote}`)
const before = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const gap = dFixture.cases.find(row => row.environment === 'activity-loss' && row.intent === 'culture' && row.history === 'none')
const raw = searchFixture.places.city
const cultureQuery = 'fixture 博物館 美術館 museum art gallery'
const rowFor = customCategory => ({ ...gap, input: { ...gap.input, customCategory } })

function assertSearchBudget(base, result) {
  assert.deepEqual(result.requests.filter(r => r.stage !== 'supplement'), base.requests.filter(r => r.stage !== 'supplement'))
  assert.deepEqual(result.plans.filter(p => p.queryLimit !== 1), base.plans.filter(p => p.queryLimit !== 1))
  const probes = result.requests.filter(r => r.stage === 'supplement')
  assert.ok(probes.length <= 1, 'Existing optional budget: at most one search, without retries')
  assert.equal(result.costs[0].legacyTotal, base.costs[0].legacyTotal)
  assert.equal(result.costs[0].total, result.requests.length)
  assert.equal(result.costs[0].supplement, probes.length)
  for (const probe of probes) {
    assert.equal(probe.body.maxResultCount, 20)
    assert.equal(probe.body.locationBias.circle.radius, 5000)
    assert.equal(probe.mask, searchFixture.fieldMasks[0])
  }
  assert.equal(new Set(result.requests.map(r => JSON.stringify(r.body))).size, result.requests.length)
  assert.equal(new Set(result.pool.allCandidates.map(c => c.placeId)).size, result.pool.allCandidates.length)
}

for (const customCategory of [
  '文化景點＋咖啡廳', '咖啡館 + 文化景點', '文化活動＋咖啡店',
  '想去文化景點與咖啡廳', '想看展覽，順便找咖啡廳', '想參觀文化展覽', '想去文化活動',
]) test(`recognized cultural demand reaches the existing supplement: ${customCategory}`, async t => {
  const row = rowFor(customCategory)
  assert.equal(resolveCandidateRankingContext(row.input).customStatus, 'recognized')
  assert.ok(resolveVisitRequirements(row.input).some(r => r.theme === 'culture'))
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.equal(base.costs[0].supplementDecision, 'unsupported_intent_or_time')
  assert.equal(base.requests.length, 5)
  assert.equal(result.requests.length, 6)
  assert.equal(result.requests.at(-1).body.textQuery, cultureQuery)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  assert.equal(base.summary.promptUses.culture, 0)
  assert.equal(result.summary.promptUses.culture, 1)
  assertSearchBudget(base, result)
  for (const original of base.facts) assert.deepEqual(result.facts.find(c => c.placeId === original.placeId), original)
  const selected = new Set(after.getPromptCandidateSelection(result.pool).promptCandidates.map(c => c.placeId))
  assert.ok(before.getPromptCandidateSelection(base.pool).promptCandidates.every(c => selected.has(c.placeId)))
})

for (const [category, customCategory] of [
  ['other', '想找咖啡廳'], ['other', '想喝咖啡'], ['explore', ''],
  ['other', '不要文化景點，想去咖啡廳'], ['other', '想去咖啡廳，但不要文化景點'],
  ['other', '不想去文化景點'], ['other', '不是不想去博物館'],
  ['other', '想去文化中心附近的咖啡廳'], ['other', '文化路散步'],
  ['other', '想去博物館還是咖啡廳？'], ['explore', '文化景點＋咖啡廳'],
]) test(`non-cultural, excluded or unknown demand preserves search: ${category}/${customCategory}`, async t => {
  const row = rowFor(customCategory)
  row.input.category = category
  // A cultural word in the origin must not establish visit intent either.
  row.input.location = { ...row.input.location, name: '文化路' }
  row.responder = body => {
    const query = body.textQuery.replace('文化路', 'fixture').replace('sightseeing attractions museums landmarks', 'attractions')
    const saved = searchFixture.responses['activity-loss'][query]
    return saved ? saved.map(id => searchFixture.places['activity-loss'][id]) : [raw.culture0]
  }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.deepEqual(result.requests, base.requests)
  assert.equal(result.requests.filter(r => r.stage === 'supplement').length, 0)
  assert.deepEqual(result.pool, base.pool)
  assertSearchBudget(base, result)
})

for (const [name, places, flags] of [
  ['empty', []], ['duplicates only', [raw.meal0]], ['wrong purpose', [{ ...raw.meal0, id: 'new-meal' }]],
  ['low quality', [{ ...raw.culture0, rating: 1, location: { latitude: 22.636, longitude: 120.3 } }]],
  ['invalid hours', [raw['bad-hours'], raw['bad-closed']]],
  ['timeout', [], { supplementError: true }], ['HTTP 503', [], { httpFailure: true }],
]) test(`cultural supplement safely falls back: ${name}`, async t => {
  const row = { ...rowFor('文化景點＋咖啡廳'), overrides: { [cultureQuery]: places }, ...flags }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.equal(result.requests.length, base.requests.length + 1)
  assert.notEqual(result.costs[0].supplementDecision, 'accepted')
  assert.deepEqual(result.pool, base.pool)
  assert.deepEqual(result.summary, base.summary)
  assertSearchBudget(base, result)
  const delivery = await import('../../api/generate-trip.ts')
  const selection = before.getPromptCandidateSelection(base.pool).promptCandidates
  const activity = selection.find(c => c.role === 'main_activity')
  const meal = selection.find(c => c.role === 'food' && c.foodSubtype === 'restaurant')
  assert.ok(activity && meal)
  const plan = { id: 'safe', type: 'safe', stops: [activity, meal].map(c => ({ id: c.placeId,
    placeId: c.placeId, name: c.name, address: c.address, type: 'food', duration: 45, description: '' })),
    transportSegments: [{ fromStopId: activity.placeId, toStopId: meal.placeId, duration: 5, mode: 'scooter' }], rainBackup: [] }
  const original = delivery.applyCandidateGroundingToPlan(structuredClone(plan), base.pool)
  const fallback = delivery.applyCandidateGroundingToPlan(structuredClone(plan), result.pool)
  assert.deepEqual(fallback, original)
  assert.deepEqual(await delivery.getDeliveryPlanIssues(fallback, row.input, 'culture-fallback', { candidates: result.pool }),
    await delivery.getDeliveryPlanIssues(original, row.input, 'culture-baseline', { candidates: base.pool }))
})

test('cultural candidates merge once; duplicate old metadata cannot corrupt the Details cache', async t => {
  const row = { ...rowFor('文化景點＋咖啡廳'), overrides: {
    [cultureQuery]: [raw.culture0, raw.culture0, { ...raw.meal0, currentOpeningHours: undefined }],
  } }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.equal(result.costs[0].supplementDecision, 'accepted')
  assert.equal(result.pool.allCandidates.length, base.pool.allCandidates.length + 1)
  assert.equal(result.pool.allCandidates.filter(c => c.placeId === 'culture0').length, 1)
  for (const original of base.pool.allCandidates) {
    assert.deepEqual(result.pool.allCandidates.find(c => c.placeId === original.placeId), original)
  }
  assertSearchBudget(base, result)
  // This validation must use accepted/old cached search facts; the replay forbids Details calls.
  const cached = ['meal0', 'culture0'].map(id => result.pool.allCandidates.find(c => c.placeId === id))
  const validated = await after.validateStopsWithPlaces({ id: 'safe', type: 'safe', stops: cached.map(c => ({ id: c.placeId,
    placeId: c.placeId, name: c.name, address: c.address, type: c.role, duration: 45 })),
    transportSegments: [] }, row.input.location)
  assert.equal(validated.invalidCount, 0)
})

test('already visible culture does not cause an extra search', async t => {
  const city = dFixture.cases.find(row => row.id === 'culture-success')
  const row = { ...city, input: { ...city.input, customCategory: '文化景點＋咖啡廳' } }
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.equal(result.costs[0].supplementDecision, 'already_covered')
  assert.deepEqual(result.requests, base.requests)
  assert.deepEqual(result.pool, base.pool)
})

for (const [name, overrides, places] of [
  ['night', { startTime: '21:00', endTime: '23:00' }],
  ['no coordinates', { location: { name: 'fixture' } }],
  ['empty baseline', {}, []], ['legacy gaps remain', {}, [raw.cafe0]],
]) test(`existing cultural search guard remains: ${name}`, async t => {
  const row = rowFor('文化景點＋咖啡廳')
  row.input = { ...row.input, ...overrides }
  if (places) row.places = places
  else row.responder = () => [raw.cafe0]
  const replay = createDReplay(t, row), base = await replay(before), result = await replay(after)
  assert.deepEqual(result.requests, base.requests)
  assert.equal(result.requests.filter(r => r.stage === 'supplement').length, 0)
  assert.deepEqual(result.pool, base.pool)
})
