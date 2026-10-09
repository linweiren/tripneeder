import { mealFixture } from './meal-consistency.mjs'
import { FIXED_NOW } from './supplement-quality.mjs'

export function suitabilityFixture(kind) {
  const f = mealFixture('explore', `v13-${kind}`)
  f.plan.id = f.plan.type = 'balanced'
  f.input.category = 'explore'
  const [a, b, dessert] = f.candidates.allCandidates
  Object.assign(dessert, { name: '甜點休息', types: ['dessert_shop', 'food'],
    foodSubtype: 'dessert', score: 104 })
  const dining = { ...dessert, id: `${dessert.id}-dining`, placeId: `${dessert.placeId}-dining`,
    name: '正餐候選', lat: 22.617, types: ['restaurant'], foodSubtype: 'restaurant', score: 100 }
  if (kind === 'mixed') {
    dining.types = ['cafe', 'restaurant']
    dining.foodSubtype = 'cafe'
    dining.name = '咖啡餐飲候選'
  }
  if (kind === 'uncertain') {
    dessert.types = ['food', 'point_of_interest']
    dessert.name = '未知餐飲能力'
    dessert.foodSubtype = 'restaurant'
  }
  const hasAlternative = ['both', 'mixed', 'detour', 'valuable', 'existing', 'diversity', 'food-first',
    'food-tour', 'museum-id-mismatch', 'museum-coherent'].includes(kind)
  if (hasAlternative) f.candidates.allCandidates.push(dining)
  if (kind === 'diversity') f.candidates.allCandidates.push({ ...dining,
    id: `${dining.id}-second`, placeId: `${dining.placeId}-second`, name: '第二正餐候選', lat: 22.618 })
  if (kind === 'valuable') {
    a.duration = b.duration = 90
    dining.score = 125
  }
  if (kind === 'expired') {
    dessert.openingHours = { ...dessert.openingHours, windows: [{
      openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + (11 * 60 + 30) * 60000),
    }] }
  }
  if (kind === 'minute-window') {
    f.input.startTime = '10:21'
    a.name = '文化園區'
    a.duration = 150
    b.duration = 60
    dessert.openingHours = { ...dessert.openingHours, windows: [{
      openAt: new Date(FIXED_NOW + (12 * 60 + 55) * 60000),
      closeAt: new Date(FIXED_NOW + (14 * 60 + 10) * 60000),
    }] }
  }
  if (kind === 'existing') {
    b.duration = 90
    f.plan.stops = [a, dessert, b]
  }
  if (kind === 'food-first' || kind === 'food-tour') {
    if (kind === 'food-first') f.input.tags = ['food_first']
    else f.input.category = 'food'
    dessert.duration = dining.duration = 60
    f.plan.stops = [dessert, dining, b]
  }
  if (kind.startsWith('museum-')) {
    a.name = '美濃客家文物館'
    a.duration = b.duration = dining.duration = 90
    Object.assign(dining, { name: '美濃莊餐廳', distanceKm: 1 })
    Object.assign(dessert, { name: '美濃合家歡客家菜', types: ['restaurant'],
      foodSubtype: 'restaurant', duration: 75 })
    // A characterized risk path, NOT the missing original Google/AI record.
    f.plan.stops = [kind === 'museum-id-mismatch' ? { ...a, placeId: dining.placeId } : a, dessert, b]
  }
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(stop => stop.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 4
  }
  f.routes[`${a.placeId}>${b.placeId}`] = 32
  if (kind === 'detour' || kind === 'valuable') {
    for (const stop of [a, b]) {
      f.routes[`${stop.placeId}>${dining.placeId}`] =
        f.routes[`${dining.placeId}>${stop.placeId}`] = kind === 'detour' ? 30 : 20
    }
  }
  f.plan.transportSegments = f.plan.stops.slice(1).map((stop, i) => ({
    fromStopId: f.plan.stops[i].id, toStopId: stop.id, mode: 'scooter',
    duration: f.routes[`${f.plan.stops[i].placeId}>${stop.placeId}`], label: '',
  }))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(stop => [stop.placeId,
    { displayName: { text: stop.name }, types: stop.types ?? [] }]))
  if (kind === 'expired') f.placeOverrides[dessert.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 11, minute: 30 } })),
  }
  if (kind === 'minute-window') f.placeOverrides[dessert.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 12, minute: 55 },
      close: { day, hour: 14, minute: 10 } })),
  }
  f.dining = dining
  f.dessert = dessert
  return f
}
