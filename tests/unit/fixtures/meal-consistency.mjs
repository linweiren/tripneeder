import { fixture, FIXED_NOW } from './supplement-quality.mjs'

export function mealFixture(kind, planId = 'balanced') {
  const f = fixture('position')
  f.input.tags = []
  const [a, b, c] = f.plan.stops
  Object.assign(a, { name: '中央公園', duration: 120 })
  Object.assign(b, { name: '愛河灣', duration: 120, distanceKm: 1.8 })
  Object.assign(c, { name: '文化園區', duration: 165 })
  const food = { ...f.extras[0], id: 'food', placeId: 'food', name: '餐飲休息',
    type: 'food', role: 'food', foodSubtype: 'cafe', duration: 60, distanceKm: 1, score: 100 }
  const early = { ...food, id: 'early', placeId: 'early', lat: 22.603, name: '既有咖啡餐飲' }
  f.plan.stops = [a, b]
  f.candidates.allCandidates = [a, b, food]
  if (['balanced', 'two-stop'].includes(kind)) {
    b.duration = 150
    f.plan.stops = [early, b]
    f.candidates.allCandidates = [early, b, food]
  }
  if (kind === 'one-activity') {
    b.duration = 150
    f.plan.stops = [early, b, food]
    f.candidates.allCandidates = [early, b, food]
  }
  if (kind === 'no-full') f.input.tags = ['no_full_meals']
  if (kind === 'no-candidate') f.candidates.allCandidates = [a, b]
  if (kind === 'failure') f.failRoutes = true
  if (kind === 'unknown-food') food.openingHours = { isKnown: false, isNeverOpen: false, windows: [] }
  if (kind === 'closing-food') food.openingHours = { ...food.openingHours, windows: [{
    openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + (12 * 60 + 45) * 60000),
  }] }
  if (kind === 'minimum-food') {
    a.duration = 90
    food.openingHours = { ...food.openingHours, windows: [{
      openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + (12 * 60 + 55) * 60000),
    }] }
  }
  if (kind === 'shifted') {
    f.input.startTime = '10:30'
    f.input.endTime = '18:30'
    f.plan.scheduleStartTime = '12:30'
    a.duration = 60
    food.duration = 45
    f.plan.stops = [a, early, c, food]
    f.candidates.allCandidates = [a, early, c, food]
  }
  if (kind === 'meal-loss') {
    a.duration = b.duration = 100
    food.lat = 22.65
  }
  if (kind === 'night') {
    f.input.startTime = '23:00'
    f.input.endTime = '01:00'
    a.duration = b.duration = 50
    f.candidates.allCandidates = [a, b]
  }
  if (kind === 'outside-window') {
    f.input.startTime = '13:00'
    f.input.endTime = '15:00'
    a.duration = b.duration = 50
  }
  if (kind === 'overnight-dinner') {
    f.input.startTime = '16:00'
    f.input.endTime = '01:00'
    b.duration = 240
    f.plan.stops = [a, food, b]
  }
  f.plan.id = f.plan.type = planId
  const prefix = `v12-${kind}-${planId}`
  for (const stop of f.candidates.allCandidates) {
    stop.id = stop.placeId = `${prefix}-${stop.placeId}`
  }
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(stop => stop.distanceKm <= 2)
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 4
  }
  f.routes[`${a.placeId}>${b.placeId}`] = kind === 'meal-loss' ? 40 : kind === 'night' ? 4 : 32
  if (['balanced', 'two-stop', 'one-activity'].includes(kind)) {
    f.routes[`${early.placeId}>${b.placeId}`] = f.routes[`${b.placeId}>${early.placeId}`] = 9
  }
  if (kind === 'shifted') Object.keys(f.routes).forEach(key => { f.routes[key] = 10 })
  if (kind === 'overnight-dinner') Object.keys(f.routes).forEach(key => { f.routes[key] = 10 })
  if (kind === 'meal-loss') Object.keys(f.routes).forEach(key => { f.routes[key] = 40 })
  if (kind === 'meal-route-failure') {
    Object.keys(f.routes).filter(key => key.includes(food.placeId)).forEach(key => { delete f.routes[key] })
  }
  f.plan.transportSegments = f.plan.stops.slice(1).map((stop, i) => ({
    fromStopId: f.plan.stops[i].id, toStopId: stop.id, mode: 'scooter',
    duration: f.routes[`${f.plan.stops[i].id}>${stop.id}`], label: '',
  }))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(stop => [stop.placeId,
    { displayName: { text: stop.name } }]))
  if (kind === 'minimum-food') f.placeOverrides[food.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 12, minute: 55 } })),
  }
  if (kind === 'night' || kind === 'overnight-dinner') {
    for (const stop of f.candidates.allCandidates) {
      stop.openingHours.windows = [{ openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 2 * 86400000) }]
      f.placeOverrides[stop.placeId].currentOpeningHours = { periods: [{
        open: { day: 4, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 8 } },
        close: { day: 6, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 10 } },
      }] }
    }
  }
  return f
}
