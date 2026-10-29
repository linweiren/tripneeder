import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { FIXED_NOW, mockMatrix, metrics } from './fixtures/supplement-quality.mjs'
import { finalQualityFixture } from './fixtures/supplement-final-quality.mjs'
import { suitabilityFixture } from './fixtures/meal-suitability.mjs'
import { getMealSuitability, MEAL_SUITABILITY_PROMPT_RULE } from '../../src/services/ai/mealSuitability.ts'
import { buildTripPrompt } from '../../src/services/ai/tripPlanPrompt.ts'
import { formatNearbyRecommendations } from '../../api/_lib/google-places.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/generate-trip.ts')
// Freeze the independent v1-v1.2 baseline, without editing a checkout or calling live APIs.
const committed = execFileSync('git', ['show', '4e1c4565de0d8069404b370034c105d64053d30c:api/generate-trip.ts'],
  { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
const source = stripTypeScriptTypes(committed).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
  const url = specifier.startsWith('.')
    ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../api/generate-trip.ts', import.meta.url)).href
    : import.meta.resolve(specifier)
  return `from ${quote}${url}${quote}`
})
const before = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

async function compare(t, makeFixture) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const rows = []
  for (const implementation of [before, after]) {
    const f = makeFixture()
    const calls = mockMatrix(t, f)
    const result = await implementation.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
      new Set(), 'meal-suitability-regression')
    const issues = result.plan ? await implementation.getDeliveryPlanIssues(result.plan, f.input,
      'meal-suitability-final', { candidates: f.candidates }) : result.issues
    const row = result.plan ? metrics(f, result, issues, calls)
      : { valid: false, routeCalls: calls.length }
    rows.push({ f, result, row, calls })
    t.mock.restoreAll()
  }
  t.diagnostic(JSON.stringify({ before: rows[0].row, after: rows[1].row }))
  t.mock.timers.reset()
  return { old: rows[0], current: rows[1] }
}

test('meal evidence remains a relative hint and never adds derived role/subtype bonuses', () => {
  assert.equal(getMealSuitability({ types: ['restaurant'] }), 'meal_likely')
  assert.equal(getMealSuitability({ types: ['cafe', 'restaurant'], foodSubtype: 'cafe' }), 'uncertain')
  assert.equal(getMealSuitability({ types: ['cafe', 'chinese_restaurant', 'restaurant'] }), 'meal_likely')
  assert.equal(getMealSuitability({ types: ['dessert_shop', 'dessert_restaurant', 'food'] }), 'refreshment_likely')
  assert.equal(getMealSuitability({ types: ['juice_shop'] }), 'refreshment_likely')
  assert.equal(getMealSuitability({ types: ['food'], foodSubtype: 'restaurant' }), 'uncertain')
  assert.equal(getMealSuitability({ name: '傳統小吃', foodSubtype: 'snack' }), 'uncertain')
  assert.equal(getMealSuitability({ name: '簡餐', types: ['cafe', 'restaurant'] }), 'uncertain')
})

for (const kind of ['both', 'mixed']) test(`${kind}: comparable meal evidence wins without extra travel or original loss`, async t => {
  const { old, current } = await compare(t, () => suitabilityFixture(kind))
  assert.ok(old.result.plan && current.result.plan)
  assert.ok(old.row.selected.includes(old.f.dessert.placeId))
  assert.ok(current.row.selected.includes(current.f.dining.placeId))
  assert.equal(current.row.travel, old.row.travel)
  assert.equal(current.row.originalLoss, 0)
  assert.equal(current.row.valid, true)
})

for (const kind of ['uncertain', 'dessert-only']) test(`${kind}: uncertainty does not hard-ban a legal meal`, async t => {
  const { current } = await compare(t, () => suitabilityFixture(kind))
  assert.ok(current.result.plan)
  assert.ok(current.row.selected.includes(current.f.dessert.placeId))
  assert.equal(current.row.originalLoss, 0)
})

test('type evidence alone cannot buy a detour or compress original activities', async t => {
  const { old, current } = await compare(t, () => suitabilityFixture('detour'))
  assert.ok(current.result.plan)
  assert.ok(current.row.selected.includes(current.f.dessert.placeId))
  assert.equal(current.row.travel, old.row.travel)
  assert.equal(current.row.originalLoss, 0)
})

test('a clearly higher final score can still select a distant dining candidate', async t => {
  const { current } = await compare(t, () => suitabilityFixture('valuable'))
  assert.ok(current.result.plan)
  assert.ok(current.row.selected.includes(current.f.dining.placeId))
  assert.equal(current.row.originalLoss, 0)
})

test('ordinary exploration realises its existing meal without adding redundant food', async t => {
  const { old, current } = await compare(t, () => suitabilityFixture('existing'))
  assert.ok(current.result.plan)
  assert.equal(current.result.plan.stops.filter(stop => stop.type === 'food').length, 1)
  assert.deepEqual(current.row.selected, old.row.selected)
})

for (const kind of ['food-first', 'food-tour']) test(`${kind} retains a legal consecutive food experience`, async t => {
  const { current } = await compare(t, () => suitabilityFixture(kind))
  assert.ok(current.result.plan)
  assert.equal(current.result.plan.stops[0].type, 'food')
  assert.equal(current.result.plan.stops[1].type, 'food')
})

test('coherent museum identity is preserved and a locally supported conflicting ID is corrected', async t => {
  const coherent = await compare(t, () => suitabilityFixture('museum-coherent'))
  assert.equal(coherent.current.result.plan.stops[0].name, '美濃客家文物館')
  const mismatch = await compare(t, () => suitabilityFixture('museum-id-mismatch'))
  // This is fixed local evidence, not a claim about the missing real Preview AI record.
  assert.equal(mismatch.old.result.plan.stops[0].name, '美濃莊餐廳')
  assert.equal(mismatch.current.result.plan.stops[0].name, '美濃客家文物館')
  assert.equal(mismatch.current.result.plan.stops[0].duration, 90)
  assert.equal(mismatch.current.result.plan.stops.filter(stop => stop.type === 'food').length, 1)
  assert.equal(mismatch.current.row.valid, true)
  assert.equal(mismatch.current.row.routeCalls, mismatch.old.row.routeCalls)
})

test('a locally impossible meal window consumes fewer Routes and remains safely refused', async t => {
  const { old, current } = await compare(t, () => suitabilityFixture('expired'))
  assert.equal(old.result.plan, null)
  assert.equal(current.result.plan, null)
  assert.ok(current.row.routeCalls < old.row.routeCalls)
})

test('local screening keeps a legal 45-minute meal starting between ten-minute grid points', async t => {
  const { current } = await compare(t, () => suitabilityFixture('minute-window'))
  assert.ok(current.result.plan)
  assert.equal(current.result.plan.stops.find(stop => stop.type === 'food').duration, 45)
  assert.equal(current.row.originalLoss, 0)
  assert.equal(current.row.valid, true)
})

test('bounded long-trip comparison preserves the necessary legal selection', async t => {
  const { old, current } = await compare(t, () => finalQualityFixture('long'))
  assert.deepEqual(current.row.selected, old.row.selected)
  assert.equal(current.row.valid, true)
  assert.equal(current.row.originalLoss, old.row.originalLoss)
  assert.equal(current.row.travel, old.row.travel)
  assert.ok(current.row.routeCalls <= old.row.routeCalls)
})

test('three styles softly diversify comparable meals and safely reuse when alternatives are exhausted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const used = new Set()
  const selected = []
  for (const id of ['safe', 'balanced', 'explore']) {
    const f = suitabilityFixture('diversity')
    f.plan.id = f.plan.type = id
    const calls = mockMatrix(t, f)
    const result = await after.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
      new Set(), 'suitability-diversity', used)
    assert.ok(result.plan)
    assert.deepEqual(await after.getDeliveryPlanIssues(result.plan, f.input, 'suitability-diversity-final',
      { candidates: f.candidates }), [])
    const food = result.plan.stops.find(stop => stop.type === 'food')
    assert.equal(getMealSuitability(food), 'meal_likely')
    selected.push(food.placeId)
    used.add(food.placeId)
    assert.ok(calls.length <= 9)
    t.mock.restoreAll()
  }
  assert.equal(new Set(selected.slice(0, 2)).size, 2)
  assert.ok(selected.slice(0, 2).includes(selected[2]))
})

test('AI candidate hints and meal prompt use the same uncertain suitability concept', () => {
  const f = suitabilityFixture('both')
  f.candidates.allCandidates.forEach(candidate => { candidate.availabilitySlots = ['early', 'middle', 'late'] })
  const context = formatNearbyRecommendations(f.candidates)
  assert.match(context, /mealSuitability=meal_likely/)
  assert.match(context, /mealSuitability=refreshment_likely/)
  const prompt = buildTripPrompt(f.input, undefined, context)
  assert.ok(prompt.includes(MEAL_SUITABILITY_PROMPT_RULE))
  assert.match(prompt, /not verified menu information/)
})
