import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { foodPurposeFixture, REPLAY_KINDS } from './fixtures/food-purpose-protection.mjs'
import { FIXED_NOW, mockMatrix } from './fixtures/supplement-quality.mjs'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.ts'
import { compareFoodPurposes, getFoodPurposeHint } from '../../api/_lib/trip-food-purpose.ts'

process.env.NODE_ENV = 'production'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
const current = await import('../../api/generate-trip.ts')
const committed = execFileSync('git', ['show', 'a5e7333794e8f7e66291162a1cdf2e1940c4c736:api/generate-trip.ts'],
  { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
const source = stripTypeScriptTypes(committed).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
  const url = specifier.startsWith('.')
    ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../api/generate-trip.ts', import.meta.url)).href
    : import.meta.resolve(specifier)
  return `from ${quote}${url}${quote}`
})
const before = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

async function deliver(t, implementation, kind, style, variant, mutate = () => {}) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Live fetch forbidden in fixture') })
  const f = foodPurposeFixture(kind, style, variant)
  mutate(f)
  const calls = mockMatrix(t, f)
  const grounded = implementation.applyCandidateGroundingToPlan(f.plan, f.candidates)
  const result = await implementation.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates,
    new Set(), 'food-purpose-regression', f.crossUsed)
  const issues = result.plan ? await implementation.getDeliveryPlanIssues(result.plan, f.input,
    'food-purpose-final', { candidates: f.candidates }) : result.issues
  const row = result.plan ? { names: result.plan.stops.map(s => s.name),
    foods: result.plan.stops.filter(s => s.type === 'food').map(s => ({ name: s.name,
      suitability: getMealSuitability(s), duration: s.duration, description: s.description })),
    stay: result.plan.stops.reduce((n, s) => n + s.duration, 0),
    travel: result.plan.transportSegments.reduce((n, s) => n + s.duration, 0),
    retainedOriginalFood: result.plan.stops.some(s => s.placeId === f.food.placeId),
    valid: issues.length === 0 && !result.routesFailed, routeCalls: calls.length } : { valid: false, routeCalls: calls.length }
  t.mock.restoreAll()
  t.mock.timers.reset()
  return { f, grounded, result, row }
}

for (const style of ['safe', 'balanced', 'explore']) for (const kind of REPLAY_KINDS) {
  test(`${style}: previous food-purpose fixture ${kind} retains safety and measured cost`, async t => {
    const old = await deliver(t, before, kind, style, 'before')
    const after = await deliver(t, current, kind, style, 'after')
    assert.equal(old.row.valid, true)
    assert.equal(after.row.valid, true)
    assert.equal(after.row.routeCalls, old.row.routeCalls)
    assert.equal(after.row.travel, old.row.travel)
    assert.equal(after.row.stay, old.row.stay)
    if (kind === 'lunch-to-dessert' || kind === 'coffee-to-dining') {
      assert.equal(old.row.retainedOriginalFood, false)
      assert.equal(after.row.retainedOriginalFood, true)
    } else {
      assert.deepEqual(after.row.names, old.row.names)
    }
    t.diagnostic(JSON.stringify({ kind, style, before: old.row, after: after.row }))
  })
}

for (const kind of ['same-meal', 'same-coffee', 'mixed', 'unknown']) test(`${kind}: comparable food variety remains allowed`, async t => {
  const { f, grounded, result, row } = await deliver(t, current, kind, 'explore', 'compatible')
  assert.equal(row.valid, true)
  assert.equal(result.plan.stops[1].placeId, f.alt.placeId)
  if (kind === 'mixed') assert.equal(getMealSuitability(result.plan.stops[1]), 'uncertain')
  const impact = current.getFoodPurposeImpact(grounded, result.plan.stops)
  assert.equal(impact.foodPurposeChanges, 0)
  assert.equal(impact.optionalFoodReplacements, 1)
  assert.equal(impact.foodPurposeUncertainChanges, ['mixed', 'unknown'].includes(kind) ? 1 : 0)
  assert.equal(row.routeCalls, 4) // Two changed edges, plus the bounded original-route comparison.
  assert.equal(result.plan.stops[1].description, '')
})

test('distinctive dessert is not replaced by a drink just for variety', async t => {
  const { f, result, row } = await deliver(t, current, 'dessert-to-drink', 'explore', 'dessert')
  assert.equal(row.valid, true)
  assert.equal(result.plan.stops[1].placeId, f.food.placeId)
})

test('a comparable food detour restores the legal original using bounded trusted routes', async t => {
  const old = await deliver(t, before, 'costly-meal', 'explore', 'before')
  const after = await deliver(t, current, 'costly-meal', 'explore', 'after')
  assert.equal(old.row.retainedOriginalFood, false)
  assert.equal(after.row.retainedOriginalFood, true)
  assert.equal(after.row.travel, 8)
  assert.equal(after.row.valid, true)
  assert.equal(after.row.routeCalls, 4)
})

test('clearly higher-quality same-purpose food may retain its route cost', async t => {
  const { row } = await deliver(t, current, 'valuable-meal', 'explore', 'valuable')
  assert.equal(row.retainedOriginalFood, false)
  assert.equal(row.valid, true)
})

test('necessary cross-food safety replacement resets stale duration and description', async t => {
  const { f, grounded, result, row } = await deliver(t, current, 'closed-duration', 'explore', 'duration')
  assert.equal(row.valid, true)
  const food = result.plan.stops.find(s => s.id === f.food.id)
  assert.equal(food.placeId, f.alt.placeId)
  assert.equal(food.duration, 60)
  assert.equal(food.description, '')
  const impact = current.getFoodPurposeImpact(grounded, result.plan.stops)
  assert.equal(impact.foodIdentityChanges, 1)
  assert.equal(impact.foodPurposeChanges, 1)
  assert.equal(impact.necessarySafetyReplacements, 1)
  assert.equal(impact.optionalFoodReplacements, 0)
  assert.equal(impact.changes[0].reason, 'safety')
})

test('grounding still corrects a uniquely verified food name with the wrong placeId', async t => {
  const { f, grounded, result, row } = await deliver(t, current, 'mismatch', 'explore', 'identity')
  assert.equal(row.valid, true)
  assert.equal(grounded.stops[1].placeId, f.food.placeId)
  assert.equal(result.plan.stops[1].placeId, f.food.placeId)
  assert.equal(current.getOriginalActivityImpact(grounded, result.plan.stops).identityChanges, 1)
  const impact = current.getFoodPurposeImpact(grounded, result.plan.stops)
  assert.equal(impact.groundingCorrections, 1)
  assert.equal(impact.foodIdentityChanges, 0)
  assert.equal(impact.foodPurposeChanges, 0)
})

test('supported food descriptions disambiguate refreshment without asserting mixed dining intent', () => {
  const mixed = { id: 'mixed', name: '咖啡兼餐廳', type: 'food', googleTypes: ['cafe', 'restaurant'],
    duration: 60, address: '', description: '咖啡休息欣賞老屋' }
  assert.equal(getFoodPurposeHint(mixed), 'uncertain')
  assert.equal(getFoodPurposeHint({ ...mixed, googleTypes: ['cafe', 'dessert_shop'] }), 'coffee')
  assert.equal(getFoodPurposeHint({ ...mixed, googleTypes: ['cafe', 'dessert_shop'], description: '特色甜點體驗' }), 'dessert')
  const drink = { ...mixed, name: '果汁站', googleTypes: ['juice_shop'], description: '' }
  assert.equal(compareFoodPurposes([mixed], [{ ...drink, placeId: 'different' }]).foodPurposeChanges, 0)
})

test('shifted schedule legality protects a lunch that is closed only at the unshifted arrival', async t => {
  const { f, grounded, result, row } = await deliver(t, current, 'lunch-to-dessert', 'explore', 'shifted', f => {
    f.plan.scheduleStartTime = '10:20'
    f.food.openingHours = { ...f.food.openingHours, windows: [{
      openAt: new Date(FIXED_NOW + (11 * 60 + 45) * 60000), closeAt: new Date(FIXED_NOW + 16 * 60 * 60000),
    }] }
    f.placeOverrides[f.food.placeId].regularOpeningHours = { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 11, minute: 45 }, close: { day, hour: 16, minute: 0 },
    })) }
  })
  assert.equal(row.valid, true)
  assert.equal(result.plan.stops[1].placeId, f.food.placeId)
  assert.equal(current.getFoodPurposeImpact(grounded, result.plan.stops).necessarySafetyReplacements, 0)
})

test('an unavailable food proposal remains a safety repair even when cross-plan used', async t => {
  const { f, grounded, result, row } = await deliver(t, current, 'closed-original', 'explore', 'cross-closed', f => {
    f.crossUsed.add(f.food.placeId)
  })
  assert.equal(row.valid, true)
  assert.equal(result.plan.stops[1].placeId, f.alt.placeId)
  assert.equal(current.getFoodPurposeImpact(grounded, result.plan.stops).necessarySafetyReplacements, 1)
})

test('no legal alternative is safely refused rather than preserving a closed food identity', async t => {
  const { row } = await deliver(t, current, 'closed-original', 'explore', 'all-closed', f => {
    f.alt.openingHours = { isKnown: false, isNeverOpen: false, windows: [] }
    f.placeOverrides[f.alt.placeId].regularOpeningHours = undefined
  })
  assert.equal(row.valid, false)
})

test('Routes failure remains visible and never supplies a successful food comparison', async t => {
  const { row } = await deliver(t, current, 'same-meal', 'explore', 'failed-routes', f => { f.failRoutes = true })
  assert.equal(row.valid, false)
})

test('three styles diversify same-purpose meals and reuse when comparable choices run out', async t => {
  const names = [], costs = []
  for (const style of ['safe', 'balanced', 'explore']) {
    const usedNames = [...names]
    const { row } = await deliver(t, current, 'same-meal', style, 'three-plans', f => {
      f.crossUsed = new Set(f.candidates.allCandidates.filter(c => usedNames.includes(c.name)).map(c => c.placeId))
    })
    assert.equal(row.valid, true)
    names.push(row.foods[0].name)
    costs.push(row.routeCalls)
  }
  assert.deepEqual(names, ['原正餐餐廳', '替代正餐餐廳', '原正餐餐廳'])
  assert.deepEqual(costs, [2, 4, 2])
})

test('uncertain food serving a required lunch prefers comparable meal evidence locally', async t => {
  const { row } = await deliver(t, current, 'unknown', 'explore', 'meal-context', f => {
    const dining = { ...f.alt, id: 'context-dining', placeId: 'context-dining', lat: 22.612,
      name: '午餐替代餐廳', types: ['restaurant'], foodSubtype: 'restaurant', score: 98 }
    f.candidates.allCandidates.push(dining)
    for (const c of f.candidates.allCandidates) if (c !== dining) {
      f.routes[`${c.placeId}>${dining.placeId}`] = f.routes[`${dining.placeId}>${c.placeId}`] = 4
    }
    f.placeOverrides[dining.placeId] = { displayName: { text: dining.name }, types: dining.types }
  })
  assert.equal(row.valid, true)
  assert.equal(row.foods[0].name, '午餐替代餐廳')
  assert.equal(row.travel, 8)
})

test('cross-food safety replacement preserves a legal minimum visit instead of raising it to the default', async t => {
  const { f, result, row } = await deliver(t, current, 'closed-original', 'explore', 'minimum-window', f => {
    f.plan.stops[1].duration = f.food.duration = 45
    f.alt.openingHours = { ...f.alt.openingHours, windows: [{
      openAt: new Date(FIXED_NOW + (11 * 60 + 30) * 60000),
      closeAt: new Date(FIXED_NOW + (12 * 60 + 49) * 60000),
    }] }
    f.placeOverrides[f.alt.placeId].regularOpeningHours = { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 11, minute: 30 }, close: { day, hour: 12, minute: 49 },
    })) }
  })
  assert.equal(row.valid, true)
  assert.equal(result.plan.stops[1].placeId, f.alt.placeId)
  assert.equal(result.plan.stops[1].duration, 45)
})
