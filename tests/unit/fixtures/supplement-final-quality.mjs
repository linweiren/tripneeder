import { fixture } from './supplement-quality.mjs'

// All pairs are deterministic. No live Google request is needed to reproduce the full pipeline.
export function finalQualityFixture(kind) {
  const f = fixture('position')
  const [a, b, c] = f.plan.stops
  Object.assign(a, { name: '美濃文物館', duration: 90 })
  b.duration = 60
  c.duration = 60
  const pavilion = f.extras[0]
  pavilion.name = '中正亭'
  const meal = { ...pavilion, id: 'meal', placeId: 'meal', name: '午餐餐廳',
    type: 'food', role: 'food', duration: 60, lat: 22.605, score: 99 }
  f.input.tags = ['meinong', 'meal-route-growth', 'long', 'post-route-growth', 'required-deletion'].includes(kind)
    ? [] : ['no_full_meals']
  f.candidates.allCandidates = [a, b, c, pavilion, ...(f.input.tags.length ? [] : [meal])]
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(x => x.distanceKm <= 2)
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 3
  }
  Object.assign(f.routes, { 'A>B': 4, 'B>C': 3, 'A>meal': 2, 'meal>near': 2 })
  f.plan.transportSegments.forEach(s => { s.duration = f.routes[`${s.fromStopId}>${s.toStopId}`] })
  if (kind === 'no-room') {
    a.name = '一般景點 A'
    a.duration = b.duration = c.duration = 90
    f.input.endTime = '17:00'
  }
  if (kind === 'meal-route-growth') {
    Object.assign(f.routes, { 'A>meal': 35, 'meal>B': 35, 'meal>near': 35, 'near>meal': 35 })
  }
  if (kind === 'night') {
    f.input.startTime = '23:00'
    f.input.endTime = '01:00'
    f.plan.stops = [a, b]
    a.duration = b.duration = 50
    f.plan.transportSegments = [{ fromStopId: a.id, toStopId: b.id, duration: 4, mode: 'scooter', label: '' }]
    f.candidates.allCandidates.forEach(x => { x.openingHours.utcOffsetMinutes = 0
      x.openingHours.windows[0].closeAt = new Date('2026-10-10T00:00:00Z') })
    f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(x => [x.placeId, {
      currentOpeningHours: { periods: [{ open: { day: 4, hour: 0, minute: 0,
        date: { year: 2026, month: 10, day: 8 } }, close: { day: 6, hour: 0, minute: 0,
        date: { year: 2026, month: 10, day: 10 } } }] },
    }]))
  }
  if (kind === 'long' || kind === 'post-route-growth') {
    f.input.endTime = '20:00'
    a.name = '文化園區 A'
    b.name = '藝術園區 B'
    const dinner = { ...meal, id: 'dinner', placeId: 'dinner', name: '晚餐餐廳', lat: 22.615 }
    f.candidates.allCandidates.push(dinner)
    for (const x of f.candidates.allCandidates) if (x !== dinner) {
      f.routes[`${x.placeId}>dinner`] = f.routes[`dinner>${x.placeId}`] = 3
    }
    if (kind === 'post-route-growth') {
      a.name = '景點 A'
      b.name = '景點 B'
      a.duration = b.duration = c.duration = 90
      pavilion.openingHours = { ...pavilion.openingHours, windows: [{
        openAt: new Date('2026-10-08T15:50:00Z'), closeAt: new Date('2026-10-09T00:00:00Z'),
      }] }
      Object.assign(f.routes, { 'A>B': 20, 'B>C': 8, 'A>meal': 7, 'meal>B': 7,
        'C>dinner': 8, 'dinner>near': 1, 'C>near': 1, 'near>dinner': 140 })
      f.plan.transportSegments.forEach(s => { s.duration = f.routes[`${s.fromStopId}>${s.toStopId}`] })
    }
  }
  if (kind === 'required-deletion') {
    const d = { ...c, id: 'D', placeId: 'D', name: 'D', lat: 22.65, duration: 40 }
    a.duration = b.duration = c.duration = 40
    meal.duration = 45
    f.plan.stops = [a, b, c, d, meal]
    f.candidates.allCandidates.push(d)
    for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
      if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 35
    }
    f.plan.transportSegments = f.plan.stops.slice(1).map((x, i) => ({
      fromStopId: f.plan.stops[i].id, toStopId: x.id, mode: 'scooter', duration: 35, label: '',
    }))
  }
  if (kind === 'sparse') {
    f.candidates.allCandidates = f.candidates.firstStopCandidates = f.candidates.otherCandidates = [a, b, c]
  }
  if (kind === 'failure') f.failRoutes = true
  // Unique IDs prevent the existing Places cache from leaking another fixture's hours/name.
  const ids = new Map(f.candidates.allCandidates.map(x => [x.placeId, `${kind}-${x.placeId}`]))
  f.routes = Object.fromEntries(Object.entries(f.routes).map(([key, duration]) =>
    [key.split('>').map(id => ids.get(id)).join('>'), duration]))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(x => [ids.get(x.placeId), {
    displayName: { text: x.name }, ...(f.placeOverrides?.[x.placeId] ?? {}),
  }]))
  for (const x of f.candidates.allCandidates) {
    x.id = x.placeId = ids.get(x.placeId)
  }
  f.plan.transportSegments.forEach(s => {
    s.fromStopId = ids.get(s.fromStopId)
    s.toStopId = ids.get(s.toStopId)
  })
  f.id = id => `${kind}-${id}`
  return f
}
