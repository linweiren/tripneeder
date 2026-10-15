import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { searchFixture, loadSearchBaseline, loadRejectedSearchProposal, priorSearchExperiment, createSearchReplay } from './fixtures/context-aware-search.mjs'
import { rankingProfiles } from './fixtures/context-aware-ranking.mjs'
import { classificationInput } from './fixtures/candidate-classification.mjs'
import { getRequiredMealWindows } from '../../api/_lib/trip-planning-rules.ts'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const baseline = await loadSearchBaseline()
const production = await import('../../api/_lib/google-places.ts')
const current = await loadRejectedSearchProposal()
const delivery = await import('../../api/generate-trip.ts')
const experiment = await loadSearchBaseline(true)
experiment.setQueryPlanner((input, persona) => priorSearchExperiment(baseline, input, persona))
const observations = []

function assertSafety(result, input) {
  const selection = current.getPromptCandidateSelection(result.pool)
  assert.ok(selection.nearStops.length <= 12 && selection.foodStops.length <= 12 && selection.mainStops.length <= 18)
  assert.ok(selection.promptCandidates.length <= 42)
  assert.equal(new Set(selection.promptCandidates.map(c => c.placeId)).size, selection.promptCandidates.length)
  assert.ok(selection.promptCandidates.every(c => c.openingHours?.isKnown && !c.openingHours.isNeverOpen && c.availabilitySlots.length))
  assert.ok(selection.nearStops.every(c => c.distanceKm <= 2 && current.isCandidateOpenForVisit(c,
    Number(input.startTime.slice(0, 2)) * 60 + Number(input.startTime.slice(3)), c.role === 'food' ? 45 : 40)))
}

function describe(result) {
  const phases = result.debugPools.map(pool => ({ raw: pool.rawCandidateCount, legal: pool.usableCandidateCount,
    uses: pool.candidates.filter(c => !c.excluded).reduce((counts, c) => {
      if (c.distanceKm === null || c.distanceKm <= 5) {
        if (c.role === 'food') counts.food++
        if (['main_activity', 'open_space', 'shopping'].includes(c.role)) counts.activity++
        if (current.isIndoorCandidate(c)) counts.indoor++
      }
      if (!c.firstStopRejectionReason) counts.first++
      if (c.availabilitySlots.includes('late')) counts.late++
      return counts
    }, { food: 0, activity: 0, indoor: 0, first: 0, late: 0 }),
    exclusions: pool.candidates.filter(c => c.excluded).map(c => ({ id: c.placeId, reason: c.exclusionReason })) }))
  const seen = new Set()
  const legal = new Set(result.pool.allCandidates.map(c => c.placeId))
  const requests = result.requests.map(request => {
    const fresh = request.returnedPlaceIds.filter(id => !seen.has(id))
    request.returnedPlaceIds.forEach(id => seen.add(id))
    return { ...request, newRawIds: fresh, newLegalIds: fresh.filter(id => legal.has(id)) }
  })
  return { summary: result.summary, plans: result.plans, phases, requests, candidates: result.facts }
}

test('Search v2 baseline: replay all previous 136 cases and the prior proposal through actual collection/ranking/Prompt', async t => {
  assert.equal(searchFixture.rows.length, 136)
  for (const row of searchFixture.rows) await t.test(`${row.environment}/${row.intent}/${row.history}`, async sub => {
    const replay = createSearchReplay(sub, row)
    const profile = rankingProfiles()[row.history]
    for (const [api, saved] of [[baseline, row.baseline], [experiment, row.experiment]]) {
      const result = await replay(api, profile)
      assert.deepEqual(result.summary, saved.summary)
      assert.deepEqual(result.plans, saved.plans)
      assert.deepEqual(result.facts, saved.candidateRefs.map(ref => searchFixture.facts[ref]))
      assert.deepEqual(result.requests, saved.requests.map(({ maskRef, ...request }) => ({ ...request, mask: searchFixture.fieldMasks[maskRef] })))
    }
  })
})

test('Search v2 baseline: all four edge paths including 6+13+5=24 remain reproducible', async t => {
  for (const row of searchFixture.edges) await t.test(row.id, async sub => {
    const result = await createSearchReplay(sub, row)(baseline)
    assert.equal(result.summary.calls, row.requests.length)
    assert.equal(result.summary.usable, row.usable)
    assert.equal(result.summary.first, row.first)
    assert.equal(result.summary.legalPrompt, row.prompt)
    assert.deepEqual(result.plans, row.plans)
    assert.deepEqual(result.requests.map(({ returnedPlaceIds, phase, ...r }) => r), row.requests)
  })
})

test('Search v2 baseline records the improvement opportunity and the known quality/cost failure', () => {
  const find = env => searchFixture.rows.find(r => r.environment === env && r.intent === 'culture' && r.history === 'none')
  const city = find('city'), loss = find('activity-loss')
  assert.deepEqual([city.baseline.summary.poolUses.culture, city.experiment.summary.poolUses.culture], [2, 12])
  assert.deepEqual([loss.baseline.summary.poolUses.activity, loss.experiment.summary.poolUses.activity], [12, 1])
  assert.deepEqual([loss.baseline.summary.calls, loss.experiment.summary.calls], [5, 8])
  assert.deepEqual(searchFixture.edges.find(e => e.id === 'max-budget').plans.map(p => p.queries.length), [6, 13, 5])
})

test('Rejected Search v2 proposal: prior 136 cases preserve activity sources and dining, but are insufficient for acceptance', async t => {
  for (const row of searchFixture.rows) await t.test(`${row.environment}/${row.intent}/${row.history}`, async sub => {
    const replay = createSearchReplay(sub, row)
    const profile = rankingProfiles()[row.history]
    const before = await replay(baseline, profile), after = await replay(current, profile)
    assert.equal(after.summary.initialCalls, before.summary.initialCalls)
    assert.ok(after.summary.calls <= row.experiment.summary.calls, 'No cost beyond the prior bounded proposal')
    const nextById = new Map(after.facts.map(c => [c.placeId, c]))
    for (const candidate of before.facts) {
      if (['main_activity', 'open_space', 'shopping'].includes(candidate.role) || candidate.role === 'food' && candidate.foodSubtype === 'restaurant') {
        assert.ok(nextById.has(candidate.placeId), `Preserve activity/dining evidence: ${candidate.placeId}`)
      }
      if (nextById.has(candidate.placeId)) assert.deepEqual(nextById.get(candidate.placeId), candidate,
        'Classification, score, personalization and slots for common candidates remain unchanged')
    }
    assert.ok(after.summary.first >= before.summary.first)
    assert.ok(after.summary.promptUses.mealLikely > 0 || before.summary.promptUses.mealLikely === 0)
    assertSafety(after, row.input)
    assert.deepEqual(getRequiredMealWindows(row.input), row.requiredMeals)
    const oldDebug = new Map(before.debugPools.at(-1)?.candidates.map(c => [c.placeId, c]) ?? [])
    for (const c of after.debugPools.at(-1)?.candidates ?? []) {
      if (oldDebug.has(c.placeId)) assert.deepEqual(c.personalization, oldDebug.get(c.placeId).personalization)
    }
    if (row.environment.startsWith('saved-')) assert.deepEqual(after.summary, before.summary,
      'Archived fixed pools validate compatibility, not new-query recall')
    observations.push({ environment: row.environment, intent: row.intent, history: row.history, input: row.input,
      before: describe(before), after: describe(after), requiredMeals: row.requiredMeals,
      removedActivityIds: before.facts.filter(c => ['main_activity', 'open_space', 'shopping'].includes(c.role) && !nextById.has(c.placeId)).map(c => c.placeId),
      removedPromptIds: Object.values(before.summary.groups).flat().filter(id => !Object.values(after.summary.groups).flat().includes(id)) })
  })
})

test('Rejected Search v2 proposal restores the displaced 12 activities using the existing three-query supplement', async t => {
  for (const intent of ['culture', 'mixed', 'culture-food-first']) await t.test(intent, async sub => {
    const row = searchFixture.rows.find(r => r.environment === 'activity-loss' && r.intent === intent && r.history === 'none')
    const after = await createSearchReplay(sub, row)(current)
    assert.equal(after.summary.calls, 8)
    assert.equal(after.summary.initialCalls, 5)
    assert.equal(after.summary.poolUses.activity, 13)
    assert.equal(after.summary.poolUses.culture, 1)
    assert.equal(after.summary.promptUses.activity, 13)
    assert.ok(Array.from({ length: 12 }, (_, i) => `unique${i}`).every(id => after.pool.allCandidates.some(c => c.placeId === id)))
    assert.equal(after.plans[1].queries.length, 3)
    assert.equal(after.plans[1].queries.at(-1), row.baseline.plans[0].queries[0])
    assert.equal(after.requests.at(-1).returnedPlaceIds.length, 12)
  })
})

test('Rejected Search v2 proposal: 2→12 culture, 8→16 cafe, 4→12 outdoor reach Prompt without extra city calls', async t => {
  for (const [intent, field, oldCount, nextCount] of [['culture', 'culture', 2, 12], ['coffee', 'cafe', 8, 16],
    ['outdoor', 'outdoor', 4, 12], ['mixed', 'culture', 2, 12]]) await t.test(intent, async sub => {
    const row = searchFixture.rows.find(r => r.environment === 'city' && r.intent === intent && r.history === 'none')
    const after = await createSearchReplay(sub, row)(current)
    assert.equal(row.baseline.summary.poolUses[field], oldCount)
    assert.equal(after.summary.poolUses[field], nextCount)
    assert.equal(after.summary.promptUses[field], nextCount)
    assert.equal(after.summary.calls, 5)
    assert.equal(after.summary.poolUses.restaurant, 8)
    if (intent === 'mixed') assert.equal(after.summary.promptUses.cafe, 8)
    assert.ok(!after.pool.allCandidates.some(c => ['bad-hours', 'bad-closed'].includes(c.placeId)))
  })
})

test('Rejected Search v2 proposal preserves queries and full output for unsupported or broad custom clauses', async t => {
  for (const customCategory of ['不想去咖啡廳', '不喝咖啡', '想喝咖啡', '如果下雨就想去咖啡廳',
    '想去咖啡廳，也完全不想去咖啡廳', '不是不想去咖啡廳', '朋友說想去博物館', '可能想去美術館',
    '想找安靜又有海風的地方', '想去文化活動', '想去文化景點', '想去戶外活動', '想去戶外景點',
    '想去博物館與戶外活動', '想參觀博物館與公園']) await t.test(customCategory, async sub => {
    const row = { environment: 'city', input: classificationInput({ category: 'other', customCategory }) }
    assert.deepEqual(current.buildCandidateSearchQueryPlan(row.input), baseline.buildCandidateSearchQueryPlan(row.input))
    const replay = createSearchReplay(sub, row)
    const before = await replay(baseline), after = await replay(current)
    assert.deepEqual(after.summary, before.summary)
    assert.deepEqual(after.facts, before.facts)
    assert.deepEqual(after.requests, before.requests)
  })
})

test('Rejected Search v2 proposal changes at most one initial slot, preserves tags, and leaves conflicts untouched', () => {
  for (const [text, index, query] of [['想參觀美術館', 0, 'fixture 博物館 美術館 museum art gallery'],
    ['想看美術展覽', 0, 'fixture 博物館 美術館 museum art gallery'], ['想去咖啡馆', null, null],
    ['想去咖啡館，但不喝咖啡', 3, '咖啡廳 cafe'], ['想去步道', 4, '公園 步道 park trail'],
    ['咖啡＋文化', 0, 'fixture 博物館 美術館 museum art gallery'],
    ['想看文化展覽，途中喝一杯咖啡', 0, 'fixture 博物館 美術館 museum art gallery']]) {
    const input = classificationInput({ category: 'other', customCategory: text })
    const before = baseline.buildCandidateSearchQueryPlan(input), after = current.buildCandidateSearchQueryPlan(input)
    assert.equal(before.queries.length, after.queries.length)
    const changed = after.queries.flatMap((q, i) => q !== before.queries[i] ? [i] : [])
    assert.deepEqual(changed, index === null ? [] : [index])
    if (index !== null) assert.equal(after.queries[index], query)
  }
  const tagged = classificationInput({ category: 'other', customCategory: '想去博物館', tags: ['food_first', 'short_distance'] })
  assert.equal(current.buildCandidateSearchQueryPlan(tagged).queries[0], 'fixture 博物館 美術館 museum art gallery gourmet nearby')
  for (const override of [{ category: 'explore' }, { startTime: '23:00', endTime: '01:00' },
    { startTime: '21:00', endTime: '23:00' }, { startTime: '04:00', endTime: '09:00' },
    { startTime: '06:00', endTime: '06:00' }, { startTime: '' }, { location: { name: 'fixture' } },
    { customCategory: '想去公園', tags: ['indoor_first'] }]) {
    const input = classificationInput({ category: 'other', customCategory: '想去博物館', ...override })
    assert.deepEqual(current.buildCandidateSearchQueryPlan(input), baseline.buildCandidateSearchQueryPlan(input))
  }
})

test('Rejected Search v2 proposal keeps all four edge costs and rejects far/unknown first stops', async t => {
  for (const row of searchFixture.edges) await t.test(row.id, async sub => {
    const result = await createSearchReplay(sub, row)(current)
    assert.equal(result.summary.calls, row.requests.length)
    assert.equal(result.summary.first, row.first)
    assert.deepEqual(result.plans, row.plans)
    assertSafety(result, row.input)
    observations.push({ edge: row.id, after: describe(result) })
  })
})

test('Rejected Search v2 proposal culture cannot replace required lunch; existing final validation remains authoritative', async t => {
  const row = searchFixture.rows.find(r => r.environment === 'city' && r.intent === 'culture' && r.history === 'none')
  // Existing grounding gives a cultural food-mislabeled stop its 75-minute
  // activity stay; allow that stay plus the separate 45-minute lunch and travel.
  const short = { ...row, input: { ...row.input, startTime: '11:00', endTime: '13:30' } }
  const replay = createSearchReplay(t, short)
  // Delivery imports production's Places module. Populate its normal search
  // cache too; the frozen proposal has a separate module cache.
  const originalPool = (await replay(production)).pool
  const result = await replay(current)
  const selection = current.getPromptCandidateSelection(result.pool)
  const culture = selection.nearStops.find(c => current.hasConfirmedCulturalPrimaryPurpose(c))
  const restaurant = selection.foodStops.find(c => c.role === 'food' && getMealSuitability(c) === 'meal_likely')
  assert.ok(culture && restaurant)
  assert.ok([culture, restaurant].every(c => originalPool.allCandidates.some(p => p.placeId === c.placeId)))
  const asStop = (c, type) => ({ id: c.placeId, placeId: c.placeId, name: c.name, address: c.address, type, duration: 45, description: '' })
  const grounded = delivery.applyCandidateGroundingToPlan({ id: 'explore', type: 'explore', stops: [asStop(culture, 'food'), asStop(restaurant, 'food')],
    rainBackup: [], transportSegments: [{ fromStopId: culture.placeId, toStopId: restaurant.placeId, duration: 5, mode: 'scooter' }] }, result.pool)
  assert.equal(grounded.stops[0].type, 'main_activity')
  assert.deepEqual(await delivery.getDeliveryPlanIssues(grounded, short.input, 'search-v2-lunch', { candidates: result.pool }), [])
})

test('Search v2 rejection evidence: empty targeted responses lose matching candidates despite adequate aggregate pools', async t => {
  for (const saved of searchFixture.rejectedProposal.emptyCases) await t.test(saved.intent, async sub => {
    const row = { environment: 'city', input: saved.input }
    const replay = createSearchReplay(sub, row, { [saved.query]: [] })
    const before = await replay(baseline), proposal = await replay(current), kept = await replay(production)
    assert.deepEqual(before.summary, saved.before)
    assert.deepEqual(proposal.summary, saved.after)
    const theme = saved.intent === 'coffee' ? 'cafe' : saved.intent === 'outdoor' ? 'outdoor' : 'culture'
    assert.equal(proposal.summary.poolUses[theme], 0, 'Reproduces rejection; this is not a safety acceptance test')
    assert.ok(before.summary.poolUses[theme] > 0)
    assert.equal(proposal.summary.gapCalls, 0, 'Aggregate thresholds do not detect the lost theme')
    assert.deepEqual(kept.summary, before.summary, 'Production remains on the safe original strategy')
    assert.deepEqual(kept.requests, before.requests)
    observations.push({ rejectedEmptyQuery: saved.intent, before: describe(before), after: describe(proposal) })
  })
})

test.after(() => {
  if (process.env.CONTEXT_SEARCH_AUDIT_OUTPUT) writeFileSync(process.env.CONTEXT_SEARCH_AUDIT_OUTPUT,
    JSON.stringify({ baseline: searchFixture.baseline, decision: 'rejected; production restored to baseline',
      paidPlacesCalls: 0, observations }, null, 2) + '\n')
})
