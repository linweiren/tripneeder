import { fixture } from './supplement-quality.mjs'
import { FIXED_NOW } from './supplement-quality.mjs'

// Reuse the seven previous investigation cases, with the same four-minute matrix.
export const REPLAY_KINDS = ['lunch-to-dessert', 'coffee-to-dining', 'weak-alternative',
  'closed-original', 'food-tour', 'two-cafes', 'scarce-reuse']

export function foodPurposeFixture(kind, style = 'explore', variant = '') {
  const f = fixture('legal-gap')
  f.input.category = 'explore'
  f.input.tags = []
  f.plan.id = f.plan.type = style
  const [a, b] = f.plan.stops
  a.duration = b.duration = 90
  a.name = '地方文物館'
  b.name = '河畔公園'
  const food = { ...f.extras[0], id: 'meal', placeId: 'meal', lat: 22.605, distanceKm: 1,
    score: 100, name: '原正餐餐廳', type: 'food', role: 'food', foodSubtype: 'restaurant',
    types: ['restaurant'], duration: 60, description: '午餐享用客家家常菜' }
  const alt = { ...food, id: 'alt', placeId: 'alt', lat: 22.61, score: 99,
    name: '甜點休息店', types: ['dessert_shop'], foodSubtype: 'dessert', description: '' }
  if (['coffee-to-dining', 'two-cafes', 'same-coffee'].includes(kind)) {
    Object.assign(food, { name: '原咖啡休息', types: ['cafe'], foodSubtype: 'cafe',
      description: '咖啡休息欣賞老屋' })
  }
  if (kind === 'coffee-to-dining') {
    Object.assign(alt, { name: '一般正餐餐廳', types: ['restaurant'], foodSubtype: 'restaurant' })
    f.input.tags = ['no_full_meals']
  }
  if (['weak-alternative', 'same-meal', 'costly-meal', 'valuable-meal'].includes(kind)) {
    Object.assign(alt, { name: '替代正餐餐廳', types: ['restaurant'], foodSubtype: 'restaurant',
      score: kind === 'weak-alternative' ? 70 : kind === 'valuable-meal' ? 120 : 99 })
  }
  if (['closed-original', 'closed-duration'].includes(kind)) {
    food.openingHours = { ...food.openingHours, windows: [{ openAt: new Date(FIXED_NOW),
      closeAt: new Date(FIXED_NOW + (10 * 60 + 30) * 60000) }] }
    if (kind === 'closed-duration') food.duration = 90
  }
  if (kind === 'two-cafes' || kind === 'same-coffee') {
    Object.assign(alt, { name: '第二咖啡休息', types: ['cafe'], foodSubtype: 'cafe' })
    if (kind === 'two-cafes') a.duration = b.duration = 60
  }
  if (kind === 'food-tour') {
    alt.name = '特色甜點'
    f.input.tags = ['food_first']
    a.duration = b.duration = 60
  }
  if (kind === 'mixed') {
    Object.assign(food, { name: '咖啡兼餐廳', types: ['cafe', 'restaurant'], foodSubtype: 'cafe', description: '' })
    Object.assign(alt, { name: '另一咖啡兼餐廳', types: ['restaurant', 'cafe'], foodSubtype: 'restaurant' })
  }
  if (kind === 'unknown') Object.assign(food, { name: '用途未確認', types: ['food'], foodSubtype: undefined, description: '' })
  if (kind === 'dessert-to-drink') {
    Object.assign(food, { name: '特色甜點店', types: ['dessert_shop'], foodSubtype: 'dessert', description: '特色甜點體驗' })
    Object.assign(alt, { name: '果汁飲料店', types: ['juice_shop'], foodSubtype: undefined })
  }
  const selected = ['food-tour', 'two-cafes'].includes(kind) ? [a, food, b, alt] : [a, food, b]
  f.candidates.allCandidates = kind === 'scarce-reuse' ? [a, b, food] : [a, b, food, alt]
  for (const c of f.candidates.allCandidates) {
    c.id = c.placeId = `${kind}-${style}-${variant}-${c.id}`
  }
  // Stops carry Google evidence, not the candidate-only types field.
  f.plan.stops = selected.map(c => {
    const { types, role, ...stop } = c
    return { ...stop, googleTypes: types, candidateRole: role }
  })
  if (kind === 'mismatch') {
    f.plan.stops[1].placeId = alt.placeId // Unique verified restaurant name corrects this ID.
  }
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 4
  }
  if (kind === 'costly-meal' || kind === 'valuable-meal') {
    f.routes[`${a.placeId}>${alt.placeId}`] = f.routes[`${alt.placeId}>${b.placeId}`] = 20
  }
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({ fromStopId: f.plan.stops[i].id,
    toStopId: s.id, mode: 'scooter', duration: 4, label: '' }))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(c => [c.placeId,
    { displayName: { text: c.name }, types: c.types ?? [], location: { latitude: c.lat, longitude: c.lng } }]))
  if (kind.startsWith('closed')) f.placeOverrides[food.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 10, minute: 30 } })),
  }
  f.crossUsed = new Set(['closed-original', 'closed-duration', 'food-tour', 'two-cafes', 'mismatch'].includes(kind)
    ? [] : [food.placeId])
  f.food = food
  f.alt = alt
  return f
}
