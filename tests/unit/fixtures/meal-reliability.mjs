import { fixture, FIXED_NOW } from './supplement-quality.mjs'
import { foodPurposeFixture } from './food-purpose-protection.mjs'
import { suitabilityFixture } from './meal-suitability.mjs'

// Controlled versions of the observed meal identities/timings, not recovered AI
// JSON, real menus or current business hours. All dependencies are tracked fixtures.
export function mealReliabilityFixture(kind = 'sketch-safe') {
  if (['safety-to-cafe', 'optional-to-uncertain', 'optional-meal-protected', 'fallback-meal'].includes(kind)) {
    const f = foodPurposeFixture(kind === 'safety-to-cafe' ? 'closed-original'
      : kind === 'fallback-meal' ? 'costly-meal' : 'lunch-to-dessert', 'safe', kind)
    if (['safety-to-cafe', 'optional-to-uncertain'].includes(kind)) {
      Object.assign(f.alt, { name: kind === 'safety-to-cafe' ? '固定咖啡休息' : '咖啡兼餐廳',
        types: kind === 'safety-to-cafe' ? ['cafe'] : ['restaurant', 'cafe'], foodSubtype: 'cafe' })
      f.placeOverrides[f.alt.placeId] = { ...f.placeOverrides[f.alt.placeId],
        displayName: { text: f.alt.name }, types: f.alt.types }
    }
    return f
  }
  if (kind === 'uncertain-only') return suitabilityFixture('uncertain')
  const f = fixture('legal-gap'), base = f.plan.stops[0]
  f.input = { ...f.input, category: 'other', customCategory: '文化景點＋咖啡廳', tags: [] }
  const make = (id, name, duration, type, types) => ({ ...structuredClone(base), id: `${kind}-${id}`,
    placeId: `${kind}-${id}`, name, duration, type, types, googleTypes: types,
    role: type === 'food' ? 'food' : 'main_activity', candidateRole: type === 'food' ? 'food' : 'main_activity',
    foodSubtype: type !== 'food' ? undefined : types.includes('cafe') ? 'cafe' : 'restaurant',
    availabilitySlots: ['early', 'middle', 'late'], score: 100, description: '' })
  const park = make('park', '中央公園', 120, 'main_activity', ['park'])
  const art = make('art', '城市光廊', 40, 'main_activity', ['tourist_attraction'])
  const cafe = make('cafe', '草圖自家烘焙咖啡館 Sketch cafe & Roastery.', 60, 'food', ['cafe', 'dessert_shop', 'food'])
  const dining = make('dining', '固定正餐餐廳', 60, 'food', ['restaurant'])
  const bay = make('bay', '愛河灣', 150, 'main_activity', ['natural_feature'])
  let stops = [park, cafe, art], extras = [], legs = [4, 4], style = 'safe', start = '10:00'
  if (['better-candidate', 'closed-alternative', 'unknown-hours-alternative'].includes(kind)) extras = [dining]
  if (kind === 'thisball') {
    cafe.duration = 45
    const ball = make('ball', 'ThisBALL', 60, 'food', ['restaurant', 'dessert_shop', 'food'])
    const after = make('after', 'Furu Cafe', 45, 'food', ['cafe'])
    bay.duration = 90
    stops = [cafe, bay, ball, after]; legs = [9, 7, 3]; style = 'balanced'
  }
  if (kind === 'explore-coffee') { cafe.duration = 66; stops = [cafe, bay]; legs = [9]; start = '11:00'; style = 'explore' }
  if (kind === 'no-full') { f.input.tags = ['no_full_meals']; art.duration = 105; stops = [park, art]; legs = [4]; extras = [cafe, dining] }
  if (kind === 'independent-meal') {
    const museum = make('museum', '地方文物館', 90, 'main_activity', ['museum'])
    const gallery = make('gallery', '地方藝術館', 45, 'main_activity', ['art_gallery'])
    cafe.duration = 45; stops = [museum, dining, gallery, cafe]; legs = [4, 4, 4]
  }
  const all = [...stops, ...extras]
  all.forEach((s, i) => Object.assign(s, { lat: 22.6 + i * .003, lng: 120.3, distanceKm: i * .333 }))
  f.candidates = { allCandidates: all, otherCandidates: all, firstStopCandidates: all.filter(c => c.distanceKm <= 2) }
  f.routes = {}
  for (const a of all) for (const b of all) if (a !== b) f.routes[`${a.placeId}>${b.placeId}`] = 4
  legs.forEach((n, i) => { f.routes[`${stops[i].placeId}>${stops[i + 1].placeId}`] = n })
  f.plan = { ...f.plan, id: style, type: style, scheduleStartTime: start, stops: structuredClone(stops),
    transportSegments: stops.slice(1).map((s, i) => ({ fromStopId: stops[i].id, toStopId: s.id,
      mode: 'scooter', label: 'fixture', duration: legs[i] })) }
  f.plan.totalTime = stops.reduce((n, s) => n + s.duration, 0) + legs.reduce((a, b) => a + b, 0)
  f.placeOverrides = Object.fromEntries(all.map(c => [c.placeId, { displayName: { text: c.name }, types: c.types }]))
  if (kind === 'closed-alternative') dining.openingHours = { ...dining.openingHours,
    windows: [{ openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 11 * 60 * 60000) }] }
  if (kind === 'unknown-hours-alternative') dining.openingHours = undefined
  return f
}

export function mealReliabilityGenerationFixture(kind) {
  const f = mealReliabilityFixture(kind)
  f.plans = ['safe', 'balanced', 'explore'].map(type => ({ ...structuredClone(f.plan), id: type, type,
    title: `固定${type}方案`, subtitle: '固定回應免費重播', summary: '文化活動、必要餐飲與咖啡休息' }))
  f.aiPlans = structuredClone(f.plans)
  return f
}
