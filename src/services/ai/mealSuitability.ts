// A relative selection hint, never proof of a menu or a new validation requirement.
// Role/subtype are derived from Places types and text, so they are not separate bonuses.
type FoodEvidence = {
  types?: readonly string[]
  googleTypes?: readonly string[]
  name?: string
  foodSubtype?: string
}

export type MealSuitability = 'meal_likely' | 'uncertain' | 'refreshment_likely'

const DINING_TYPES = new Set([
  'restaurant', 'asian_restaurant', 'chinese_restaurant', 'taiwanese_restaurant',
  'european_restaurant', 'italian_restaurant', 'japanese_restaurant', 'korean_restaurant',
  'indian_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'seafood_restaurant',
  'steak_house', 'sushi_restaurant', 'ramen_restaurant', 'pizza_restaurant',
  'hamburger_restaurant', 'sandwich_shop', 'diner', 'deli', 'food_court', 'cafeteria',
  'fast_food_restaurant', 'vegetarian_restaurant', 'vegan_restaurant',
  'buffet_restaurant', 'barbecue_restaurant', 'brunch_restaurant', 'bistro',
])
const REFRESHMENT_TYPES = new Set([
  'cafe', 'coffee_shop', 'tea_house', 'juice_shop', 'dessert_shop', 'dessert_restaurant',
  'ice_cream_shop', 'bakery', 'donut_shop', 'candy_store', 'chocolate_shop',
])

export function getMealSuitability(candidate: FoodEvidence): MealSuitability {
  const types = candidate.types ?? candidate.googleTypes ?? []
  const dining = types.filter(type => DINING_TYPES.has(type))
  const refreshment = types.some(type => REFRESHMENT_TYPES.has(type)) ||
    /(咖啡|甜點|蛋糕|冰品|飲料|手搖|烘焙|coffee|cafe|dessert|bakery|juice)/i.test(candidate.name ?? '')
  // Specific dining evidence can coexist with cafe/rest semantics. A generic restaurant
  // plus refreshment evidence stays uncertain; neither label proves a full meal.
  if (dining.some(type => type !== 'restaurant') || (dining.length > 0 && !refreshment)) {
    return 'meal_likely'
  }
  if (dining.length > 0) return 'uncertain'
  if (refreshment) return 'refreshment_likely'
  // A derived subtype is only a fallback when the underlying types/text are uninformative.
  if (candidate.foodSubtype === 'cafe' || candidate.foodSubtype === 'dessert') return 'refreshment_likely'
  return 'uncertain'
}

export function getMealSuitabilityRank(candidate: FoodEvidence) {
  return { meal_likely: 2, uncertain: 1, refreshment_likely: 0 }[getMealSuitability(candidate)]
}

export const MEAL_SUITABILITY_PROMPT_RULE =
  'mealSuitability is a relative evidence hint, not verified menu information. For required lunch/dinner, ' +
  'prefer meal_likely over uncertain or refreshment_likely when quality is comparable and doing so does not ' +
  'increase travel or sacrifice useful existing stays. cafe, snacks and uncertain candidates remain allowed; ' +
  'restaurant does not guarantee suitability for every meal or user. Use the existing score once; ' +
  'do not add separate bonuses for types, foodSubtype, candidateRole or personalization. ' +
  'Avoid redundant consecutive food stops in ordinary trips; preserve food-first and food-tour experiences ' +
  'and distinct required meals. Do not claim that a type hint verifies full-meal service.'
