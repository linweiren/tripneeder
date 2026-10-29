import type { Stop } from '../../src/types/trip.js'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.js'

export type FoodPurposeHint = 'meal' | 'coffee' | 'dessert' | 'drink' | 'uncertain'
export type FoodReplacementReason = 'grounding' | 'optional_diversity' | 'safety'
export type FoodPurposeProvenance = { baseline: Stop[]; replacements: Array<{
  stopId: string; fromPlaceId?: string; toPlaceId?: string; reason: FoodReplacementReason
}> }

// A single relative evidence assessment, not menu verification or independent bonuses.
// Mixed dining/refreshment evidence stays uncertain. Descriptions only disambiguate
// refreshment kinds already supported by the verified place evidence.
export function getFoodPurposeHint(stop: Stop): FoodPurposeHint {
  const suitability = getMealSuitability({ googleTypes: stop.googleTypes,
    name: stop.name, foodSubtype: stop.foodSubtype })
  if (suitability === 'meal_likely') return 'meal'
  if (suitability === 'uncertain') return 'uncertain'
  const types = stop.googleTypes ?? []
  const kinds: FoodPurposeHint[] = []
  if (types.some(t => ['cafe', 'coffee_shop', 'tea_house'].includes(t))) kinds.push('coffee')
  if (types.some(t => ['dessert_shop', 'dessert_restaurant', 'ice_cream_shop', 'bakery',
    'donut_shop', 'candy_store', 'chocolate_shop'].includes(t))) kinds.push('dessert')
  if (types.some(t => ['juice_shop'].includes(t))) kinds.push('drink')
  if (kinds.length === 0) {
    if (/(咖啡|coffee|cafe|珈琲)/i.test(stop.name)) kinds.push('coffee')
    if (/(甜點|蛋糕|冰品|烘焙|dessert|bakery)/i.test(stop.name)) kinds.push('dessert')
    if (/(飲料|手搖|果汁|juice)/i.test(stop.name)) kinds.push('drink')
    if (kinds.length === 0 && stop.foodSubtype === 'cafe') kinds.push('coffee')
    if (kinds.length === 0 && stop.foodSubtype === 'dessert') kinds.push('dessert')
  }
  if (kinds.length === 1) return kinds[0]
  if (kinds.includes('coffee') && /(咖啡休息|coffee break)/i.test(stop.description ?? '')) return 'coffee'
  if (kinds.includes('dessert') && /(甜點體驗|品嚐甜點|dessert tasting)/i.test(stop.description ?? '')) return 'dessert'
  return 'uncertain'
}

export function hasFoodPurposeConflict(original: Stop, replacement: Stop) {
  if (original.type !== 'food' || replacement.type !== 'food') return false
  const before = getFoodPurposeHint(original)
  const after = getFoodPurposeHint(replacement)
  return before !== 'uncertain' && after !== 'uncertain' && before !== after
}

export function recordFoodReplacement(trace: FoodPurposeProvenance | undefined,
  before: Stop, after: Stop, reason: FoodReplacementReason) {
  if (trace && before.placeId !== after.placeId && (before.type === 'food' || after.type === 'food')) {
    trace.replacements.push({ stopId: before.id, fromPlaceId: before.placeId,
      toPlaceId: after.placeId, reason })
  }
}

export function compareFoodPurposes(baseline: Stop[], finals: Stop[]) {
  let foodIdentityChanges = 0, foodPurposeChanges = 0, foodPurposeUncertainChanges = 0
  let foodRetainedStayLoss = 0, foodRemovedStops = 0
  const changes: Array<{ stopId: string; fromPlaceId?: string; toPlaceId?: string;
    before: FoodPurposeHint; after: FoodPurposeHint; confirmedHintChange: boolean }> = []
  for (const original of baseline.filter(stop => stop.type === 'food')) {
    const final = finals.find(stop => stop.id === original.id)
    if (!final) { foodRemovedStops++; continue }
    const identityChanged = original.placeId !== final.placeId
    if (identityChanged) foodIdentityChanges++
    else foodRetainedStayLoss += Math.max(0, original.duration - final.duration)
    if (final.type !== 'food') continue // Coarse-purpose diagnostics cover this separately.
    const before = getFoodPurposeHint(original), after = getFoodPurposeHint(final)
    const confirmedHintChange = hasFoodPurposeConflict(original, final)
    if (confirmedHintChange) foodPurposeChanges++
    if (identityChanged && (before === 'uncertain' || after === 'uncertain')) foodPurposeUncertainChanges++
    if (identityChanged || confirmedHintChange) changes.push({ stopId: original.id,
      fromPlaceId: original.placeId, toPlaceId: final.placeId, before, after, confirmedHintChange })
  }
  return { foodIdentityChanges, foodPurposeChanges, foodPurposeUncertainChanges,
    foodRetainedStayLoss, foodRemovedStops, changes }
}
