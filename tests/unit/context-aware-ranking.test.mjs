import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveCandidateRankingContext } from '../../api/_lib/candidate-ranking-context.ts'
import { getPersonalizationCandidateBoost, getPersonalizationBoostCap } from '../../api/_lib/personalization-candidate-boost.ts'
import { getRequiredMealWindows } from '../../api/_lib/trip-planning-rules.ts'
import { classificationInput } from './fixtures/candidate-classification.mjs'
import { mockQuotaSearch, quotaSummary } from './fixtures/candidate-quota-consistency.mjs'
import { loadRankingBaseline, rankingEnvironments, rankingIntents, rankingProfiles, rankingPlace } from './fixtures/context-aware-ranking.mjs'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/_lib/google-places.ts')
const before = await loadRankingBaseline()
const delivery = await import('../../api/generate-trip.ts')
const observations = []
const priorPath = new URL('../../docs/investigations/context-aware-ranking-20261014-results.json', import.meta.url)
const prior = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')).rows : []

async function replay(t, env, intentId, history = 'none') {
  const override = rankingIntents.find(([id]) => id === intentId)?.[1] ?? env.override
  const input = { ...structuredClone(env.input), ...override }
  const profile = rankingProfiles()[history]
  const requests = mockQuotaSearch(t, env.places)
  let debug
  const sink = { recordQueryPlan() {}, recordQueryResult() {}, recordCandidatePool(s) { debug = s } }
  const oldPool = await before.getNearbyPlaceCandidates({ input }, sink, { preferenceProfile: profile })
  const oldRequests = requests.splice(0), oldDebug = debug
  const pool = await after.getNearbyPlaceCandidates({ input }, sink, { preferenceProfile: profile })
  assert.deepEqual(requests, oldRequests, 'same search strategy, request budget, fields and source')
  const stableFacts = list => list.map(({ score, ...c }) => c).sort((a, b) => a.placeId.localeCompare(b.placeId))
  for (const key of ['allCandidates', 'firstStopCandidates', 'otherCandidates']) {
    assert.deepEqual(stableFacts(pool[key]), stableFacts(oldPool[key]), 'all legal venues, roles, hours, slots and pools are preserved')
  }
  const oldSummary = quotaSummary(before, oldPool, input), summary = quotaSummary(after, pool, input)
  const scores = (api, p, dbg) => p.allCandidates.map((c, i) => {
    const boost = getPersonalizationCandidateBoost(c, profile)
    const base = dbg.candidates.find(d => d.placeId === c.placeId).personalization?.baseScore ?? c.score
    assert.ok(boost.bonus <= 3)
    assert.equal(c.score, Math.round((base + boost.bonus) * 10) / 10, 'history applied exactly once')
    return { placeId: c.placeId, name: c.name, role: c.role, subtype: c.foodSubtype,
      base, boost: boost.bonus, score: c.score, signals: boost.matchedSignals, rank: i + 1,
      culture: api.hasConfirmedCulturalPrimaryPurpose(c), outdoor: c.role === 'open_space' }
  })
  const oldScores = scores(before, oldPool, oldDebug), newScores = scores(after, pool, debug)
  for (const c of newScores) {
    const old = oldScores.find(p => p.placeId === c.placeId)
    assert.equal(c.boost, old.boost)
    assert.deepEqual(c.signals, old.signals)
  }
  assert.equal(getPersonalizationBoostCap(), 3)
  const selection = after.getPromptCandidateSelection(pool)
  assert.ok(selection.nearStops.length <= 12 && selection.foodStops.length <= 12 && selection.mainStops.length <= 18)
  assert.ok(summary.promptCount <= 42)
  assert.ok(selection.nearStops.every(c => c.distanceKm <= 2))
  assert.equal(new Set(selection.promptCandidates.map(c => c.placeId)).size, summary.promptCount)
  const count = list => ({ culture: list.filter(c => after.hasConfirmedCulturalPrimaryPurpose(c)).length,
    cafe: list.filter(c => c.role === 'food' && c.foodSubtype === 'cafe').length,
    restaurant: list.filter(c => c.role === 'food' && c.foodSubtype === 'restaurant').length,
    outdoor: list.filter(c => c.role === 'open_space').length })
  const oldSelection = before.getPromptCandidateSelection(oldPool)
  if (count(oldSelection.promptCandidates).restaurant) assert.ok(count(selection.promptCandidates).restaurant,
    'available true dining must not disappear for a theme preference')
  const context = resolveCandidateRankingContext(input)
  const mismatch = list => ({
    offTheme: context.themes.length ? list.filter(c => !(
      (context.themes.includes('culture') && after.hasConfirmedCulturalPrimaryPurpose(c)) ||
      (context.themes.includes('coffee') && c.role === 'food' && c.foodSubtype === 'cafe') ||
      (context.themes.includes('outdoor') && c.role === 'open_space')
    )).length : null,
    avoidedCafes: context.avoidCoffee ? count(list).cafe : null,
  })
  const priorRow = prior.find(r => r.env === env.id && r.intent === intentId && r.history === history)
  if (priorRow) {
    assert.deepEqual(input, priorRow.input, 'replay the prior audit input exactly')
    assert.deepEqual(oldRequests, priorRow.requests)
    assert.deepEqual(oldScores.map(c => [c.placeId, c.score]), priorRow.candidates.map(c => [c.placeId, c.score]))
    assert.deepEqual(oldSummary.groups, priorRow.groups)
  }
  const row = { env: env.id, intent: intentId, history, input, context, searches: [oldRequests.length, requests.length],
    requiredMeals: getRequiredMealWindows(input), before: { ...oldSummary, scores: oldScores, nearUses: count(oldSelection.nearStops), uses: count(oldSelection.promptCandidates),
      nearMismatch: mismatch(oldSelection.nearStops), promptMismatch: mismatch(oldSelection.promptCandidates) },
    after: { ...summary, scores: newScores, nearUses: count(selection.nearStops), uses: count(selection.promptCandidates),
      nearMismatch: mismatch(selection.nearStops), promptMismatch: mismatch(selection.promptCandidates) } }
  observations.push(row)
  return { input, context, oldPool, pool, oldSummary, summary, selection, row }
}

for (const [intent, history, id, expectedScore] of [
  ['culture', 'none', 'p-cafe', 93], ['culture', 'coffee', 'p-cafe', 95.5],
  ['outdoor-text', 'none', 'p-park', 101], ['negative-coffee', 'none', 'p-cafe', 93],
]) {
  test(`ranking regression: ${intent}/${history} changes actual candidate score and order`, async t => {
    const r = await replay(t, rankingEnvironments()[0], intent, history)
    assert.equal(r.pool.allCandidates.find(c => c.placeId === id).score, expectedScore)
    assert.equal(r.pool.allCandidates[0].placeId, intent === 'outdoor-text' ? 'p-park' : 'p-culture')
    assert.ok(r.row.after.nearUses.restaurant > 0)
  })
}

const parserCases = [
  ['想參觀博物館、文化景點', ['culture'], false, 'recognized'],
  ['想找咖啡廳', ['coffee'], false, 'recognized'],
  ['想去戶外景點', ['outdoor'], false, 'recognized'],
  ['文化＋咖啡', ['culture', 'coffee'], false, 'recognized'],
  ['不想去咖啡廳', [], true, 'recognized'],
  ['不想去咖啡廳，想看文化展覽', ['culture'], true, 'recognized'],
  ['想去咖啡廳，但不喝咖啡', ['coffee'], false, 'recognized'],
  ['不喝咖啡', [], false, 'unknown'],
  ['不想吃正餐', [], false, 'unknown'],
  ['不想吃正餐，只想看展覽', [], false, 'unknown'],
  ['想去咖啡廳，也完全不想去咖啡廳', [], false, 'unknown'],
  ['不是不想去咖啡廳', [], false, 'unknown'],
  ['不想去咖啡廳附近的公園', [], false, 'unknown'],
  ['如果下雨就不想去咖啡廳', [], false, 'unknown'],
  ['朋友說想去咖啡廳', [], false, 'unknown'],
  ['可能想去咖啡廳', [], false, 'unknown'],
  ['想去咖啡廳還是博物館？', [], false, 'unknown'],
  ['文化', [], false, 'unknown'], ['咖啡廳', [], false, 'unknown'],
  ['想找安靜又有海風的地方', [], false, 'unknown'],
]
for (const [text, themes, avoidCoffee, customStatus] of parserCases) {
  test(`conservative visit intent: ${text}`, () => {
    assert.deepEqual(resolveCandidateRankingContext(classificationInput({ category: 'other', customCategory: text })),
      { themes, avoidCoffee, customStatus })
  })
}

test('structured category takes precedence over inactive custom text; meal tags are untouched', () => {
  const input = classificationInput({ category: 'outdoor', customCategory: '想找咖啡廳' })
  assert.deepEqual(resolveCandidateRankingContext(input), { themes: ['outdoor'], avoidCoffee: false, customStatus: 'not_used' })
  const noMealText = classificationInput({ category: 'other', customCategory: '不想吃正餐' })
  const clone = structuredClone(noMealText)
  resolveCandidateRankingContext(noMealText)
  assert.deepEqual(noMealText, clone)
  assert.ok(getRequiredMealWindows(noMealText).length)
})

test('replay prior fixed matrix through search, score, first shortlist and actual Prompt formatter', async t => {
  for (const env of rankingEnvironments()) for (const [intent] of rankingIntents) {
    if (env.intentIds && !env.intentIds.includes(intent)) continue
    for (const history of Object.keys(rankingProfiles())) await t.test(`${env.id}/${intent}/${history}`, async sub => {
      const r = await replay(sub, env, intent, history)
      if (['explore', 'other-neutral', 'coffee', 'contradictory', 'no-drink', 'food-first', 'indoor-first',
        'no-meals-text', 'no-meals-tag', 'inactive-custom', 'tired-short'].includes(intent)) {
        assert.deepEqual(r.pool, r.oldPool, 'unknown, baseline and existing tag-only behavior is unchanged')
        assert.deepEqual(r.summary, r.oldSummary)
      }
      if (env.id === 'city' && ['culture', 'negative-coffee'].includes(intent)) {
        assert.equal(r.row.before.nearUses.culture, 0)
        assert.equal(r.row.after.nearUses.culture, 12)
        assert.equal(r.row.before.uses.culture, 12)
        assert.equal(r.row.after.uses.culture, 24)
      }
      if (env.id === 'city' && ['outdoor-text', 'outdoor-category'].includes(intent)) {
        assert.equal(r.row.after.nearUses.outdoor, 2)
      }
      if (intent === 'mixed') {
        assert.ok(r.row.after.uses.culture > 0 && r.row.after.uses.cafe > 0)
      }
      if (env.id === 'suburb' && intent === 'culture') {
        assert.equal(r.selection.nearStops.length, 3)
        assert.ok(r.selection.nearStops.every(c => c.role === 'food'), '8km culture cannot become a first stop')
      }
    })
  }
})

test('negative cafe preference lowers priority without banning the only legal first/dining options', async t => {
  const env = { id: 'cafe-only', input: classificationInput(),
    override: { category: 'other', customCategory: '不想去咖啡廳' },
    places: [rankingPlace('only-cafe', '唯一咖啡廳', ['cafe', 'food'])] }
  const r = await replay(t, env, 'only-cafe')
  assert.equal(r.pool.allCandidates[0].score, 97)
  assert.equal(r.summary.promptCount, 1)
  assert.equal(r.selection.nearStops[0].placeId, 'only-cafe')
})

test('explicit cafe avoidance alone reaches near12 and Prompt while keeping a soft cafe option and real meals', async t => {
  const env = { ...rankingEnvironments().find(e => e.id === 'city'), id: 'city-avoid-only',
    override: { category: 'other', customCategory: '不想去咖啡廳', tags: [] } }
  const r = await replay(t, env, 'avoid-only', 'coffee')
  assert.equal(r.row.before.nearUses.cafe, 12)
  assert.equal(r.row.after.nearUses.cafe, 0)
  assert.equal(r.row.before.uses.cafe, 19)
  assert.equal(r.row.after.uses.cafe, 1, 'the existing cafe bucket remains a soft fallback, not a hard ban')
  assert.equal(r.row.after.uses.restaurant, 11)
})

test('venue negation vs drink negation changes the full ranking only for the explicit venue preference', async t => {
  for (const [text, expectedCafe] of [['不想去咖啡廳', 97], ['不喝咖啡', 111]]) await t.test(text, async sub => {
    const env = { ...rankingEnvironments()[0], id: `negation-${text}`,
      override: { category: 'other', customCategory: text, tags: [] } }
    const r = await replay(sub, env, 'negation-control')
    assert.equal(r.pool.allCandidates.find(c => c.placeId === 'p-cafe').score, expectedCafe)
    if (text === '不喝咖啡') assert.deepEqual(r.pool, r.oldPool)
    assert.ok(r.selection.promptCandidates.some(c => c.placeId === 'p-cafe'))
  })
})

test('structured food and indoor categories reuse their existing tag branches without stacking', async t => {
  for (const [category, tag, candidate, expected] of [['food', 'food_first', 'p-meal', 119],
    ['indoor', 'indoor_first', 'p-culture', 115]]) await t.test(category, async sub => {
    const env = { ...rankingEnvironments()[0], id: `structured-${category}`,
      override: { category, customCategory: '', tags: [tag] } }
    const r = await replay(sub, env, 'structured-control')
    assert.equal(r.pool.allCandidates.find(c => c.placeId === candidate).score, expected)
  })
})

test('preference cannot rescue far, poorly rated or time-illegal culture; default main is not cultural evidence', async t => {
  const env = { id: 'quality-guard', input: classificationInput(), override: rankingIntents.find(([id]) => id === 'culture')[1],
    places: [rankingPlace('near-cafe', '鄰近咖啡廳', ['cafe', 'food'], 0.5, 5),
      rankingPlace('far-culture', '遠方博物館', ['museum'], 8, 3),
      rankingPlace('poor-culture', '低評分博物館', ['museum'], 1, 3),
      rankingPlace('default-main', '複合生活空間', ['point_of_interest']),
      rankingPlace('unknown-hours', '未知時段博物館', ['museum'], 1, 5, { currentOpeningHours: undefined }),
      rankingPlace('closed', '停業博物館', ['museum'], 1, 5, { businessStatus: 'CLOSED_TEMPORARILY' })] }
  const r = await replay(t, env, 'quality-guard', 'culture')
  assert.equal(r.pool.allCandidates[0].placeId, 'near-cafe')
  assert.equal(r.pool.allCandidates.find(c => c.placeId === 'default-main').score, 94)
  assert.ok(!r.selection.nearStops.some(c => c.placeId === 'far-culture'))
  assert.ok(!r.pool.allCandidates.some(c => ['unknown-hours', 'closed'].includes(c.placeId)))
})

test('cultural primary purpose stays cultural through Prompt/Grounding and cannot replace required lunch', async t => {
  const env = rankingEnvironments().find(e => e.id === 'city')
  const r = await replay(t, env, 'culture', 'coffee')
  const c = r.selection.nearStops[0]
  const stop = { id: 'cultural-visit', placeId: c.placeId, name: c.name, address: c.address,
    type: 'food', duration: 75, description: '' }
  const plan = delivery.applyCandidateGroundingToPlan({ id: 'explore', type: 'explore', stops: [stop], transportSegments: [] }, r.pool)
  assert.equal(plan.stops[0].type, 'main_activity')
  assert.equal(plan.stops[0].duration, 75)
  const mealStops = delivery.ensureMealStopForTrip(plan.stops, r.input, r.pool, new Set([c.placeId]))
  assert.ok(mealStops.some(s => s.type === 'food' && !after.hasConfirmedCulturalPrimaryPurpose(
    r.pool.allCandidates.find(p => p.placeId === s.placeId))))
  assert.equal(r.pool.allCandidates.find(c => c.placeId === mealStops.find(s => s.type === 'food').placeId).foodSubtype, 'restaurant')
})

test('two-hour culture ranking retains a separate suitable meal and passes existing final delivery validation', async t => {
  const env = { ...rankingEnvironments().find(e => e.id === 'city'), id: 'meal-safety',
    input: classificationInput({ startTime: '11:00', endTime: '13:00' }),
    override: rankingIntents.find(([id]) => id === 'culture')[1] }
  const r = await replay(t, env, 'meal-safety', 'coffee')
  const culture = r.selection.nearStops.find(c => after.hasConfirmedCulturalPrimaryPurpose(c))
  const restaurant = r.selection.foodStops.find(c => c.foodSubtype === 'restaurant')
  assert.ok(culture && restaurant)
  const asStop = (c, type, duration) => ({ id: c.placeId, placeId: c.placeId, name: c.name, address: c.address,
    type, duration, description: '' })
  const plan = delivery.applyCandidateGroundingToPlan({ id: 'explore', type: 'explore',
    stops: [asStop(culture, 'main_activity', 45), asStop(restaurant, 'food', 45)], rainBackup: [],
    transportSegments: [{ fromStopId: culture.placeId, toStopId: restaurant.placeId, duration: 5, mode: 'scooter' }] }, r.pool)
  assert.deepEqual(await delivery.getDeliveryPlanIssues(plan, r.input, 'context-ranking-meal', { candidates: r.pool }), [])
})

test.after(() => {
  if (process.env.CONTEXT_RANKING_AUDIT_OUTPUT) writeFileSync(process.env.CONTEXT_RANKING_AUDIT_OUTPUT,
    JSON.stringify({ baseline: 'c4f70a88', observations }, null, 2) + '\n')
})
