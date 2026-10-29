// Shared deterministic Coverage fixture support, extracted without changing behavior.
import { fixture, FIXED_NOW } from './supplement-quality.mjs'
import { durationQualityFixture } from './stop-duration-quality.mjs'
import { optionalActivityFixture } from './optional-activity-quality.mjs'
import { mealReliabilityFixture } from './meal-reliability.mjs'
import { finalQualityFixture } from './supplement-final-quality.mjs'

export const CASES = ['central-two-stop', 'central-culture', 'five-small', 'five-large', 'valuable', 'expensive',
  'ten-hour', 'night', 'night-one', 'booked-long', 'booked-extension', 'grounding-minimum',
  'optional-fallback', 'optional-coverage', 'route-failure', 'meal-alignment']
export const HANDLER_CASES = ['five-small', 'five-large', 'valuable', 'central-two-stop', 'night-one', 'ten-hour']
export function experimentFixture(kind, style = 'explore') {
  let f
  if (kind === 'central-two-stop') f = durationQualityFixture('two-stop', style)
  else if (kind === 'central-culture' || kind === 'booked-extension') f = mealReliabilityFixture('independent-meal')
  else if (kind === 'ten-hour') f = finalQualityFixture('long')
  else if (kind === 'night') f = finalQualityFixture('night')
  else if (kind.startsWith('optional')) f = optionalActivityFixture('same-purpose')
  else if (kind === 'meal-alignment') f = durationQualityFixture('meal', style)
  else f = fixture('city')
  if (['five-small', 'five-large', 'valuable', 'expensive', 'night-one', 'booked-long', 'grounding-minimum', 'route-failure'].includes(kind)) {
    f.plan.stops.forEach((s, i) => Object.assign(s, { name: i ? '河濱公園' : '中央公園', types: ['park'], googleTypes: ['park'] }))
    if (kind === 'five-small') [f.plan.stops[0].duration, f.plan.stops[1].duration] = [110, 95]
    else if (kind === 'five-large') [f.plan.stops[0].duration, f.plan.stops[1].duration] = [40, 45]
    else f.plan.stops.forEach(s => { s.duration = 90 })
    if (!['valuable', 'expensive'].includes(kind)) f.candidates.allCandidates = [...f.plan.stops]
    if (kind === 'valuable') f.extras.forEach(s => Object.assign(s, { name: '地方藝術館', types: ['art_gallery'], googleTypes: ['art_gallery'] }))
    if (kind === 'expensive') {
      f.candidates.allCandidates = [...f.plan.stops, f.extras[0]]
      Object.assign(f.routes, { 'A>far': 200, 'far>B': 200, 'B>far': 200 })
    }
    if (kind === 'night-one') {
      f.input.startTime = '23:00'; f.input.endTime = '01:00'
      f.plan.stops = [f.plan.stops[0]]; f.plan.stops[0].duration = 60
      f.candidates.allCandidates = [...f.plan.stops]
      f.candidates.allCandidates.forEach(s => { s.openingHours.windows[0].closeAt = new Date(FIXED_NOW + 2 * 86400000) })
      f.placeOverrides = Object.fromEntries(f.plan.stops.map(s => [s.placeId, { currentOpeningHours: { periods: [{
        open: { day: 4, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 8 } },
        close: { day: 6, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 10 } } }] } }]))
    }
    if (kind === 'booked-long') {
      f.plan.stops[0].name = '已預訂博物館活動'; f.plan.stops[0].duration = 180
      f.plan.stops[0].types = f.plan.stops[0].googleTypes = ['museum']; f.plan.stops[1].duration = 45
      f.evidence = [{ placeId: f.plan.stops[0].placeId, minutes: 180 }]
    }
    if (kind === 'grounding-minimum') f.plan.stops[0].duration = 10
    if (kind === 'route-failure') f.failRoutes = true
  }
  if (['central-culture', 'booked-extension'].includes(kind)) {
    const museum = f.candidates.allCandidates.find(s => /文物館/.test(s.name))
    museum.name = '高雄市立歷史博物館'
    f.plan.stops.find(s => s.placeId === museum.placeId).name = museum.name
  }
  if (kind === 'central-culture') {
    f.plan.stops = f.plan.stops.filter(s => /博物館|草圖/.test(s.name))
    f.plan.stops[0].duration = 90; f.plan.stops[1].duration = 45
    f.candidates.allCandidates = f.candidates.allCandidates.filter(s => f.plan.stops.some(p => p.placeId === s.placeId))
  }
  if (kind === 'booked-extension') {
    f.plan.stops = f.plan.stops.filter(s => /博物館|草圖/.test(s.name))
    f.plan.stops[0].duration = 60; f.plan.stops[1].duration = 70
    f.candidates.allCandidates = f.candidates.allCandidates.filter(s => f.plan.stops.some(p => p.placeId === s.placeId))
    f.evidence = [{ placeId: f.plan.stops[0].placeId, minutes: 150 }]
    f.routes[`${f.plan.stops[0].placeId}>${f.plan.stops[1].placeId}`] = 10
  }
  if (kind === 'optional-coverage') f.plan.stops.forEach((s, i) => { s.duration = i === 1 ? 45 : 60 })
  f.plan.id = f.plan.type = style
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({ fromStopId: f.plan.stops[i].id,
    toStopId: s.id, mode: f.plan.transportMode, duration: f.routes[`${f.plan.stops[i].placeId}>${s.placeId}`], label: 'fixture' }))
  f.plan.totalTime = f.plan.stops.reduce((n, s) => n + s.duration, 0) + f.plan.transportSegments.reduce((n, s) => n + s.duration, 0)
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(c => [c.placeId, {
    ...(f.placeOverrides?.[c.placeId] ?? {}), displayName: { text: c.name }, types: c.types }]))
  f.crossPlanUsed ??= new Set()
  if (kind.startsWith('optional')) f.crossPlanUsed.add(f.museum.placeId)
  f.evidenceClass = 'controlled_fixture_not_recovered_ai_json'
  return f
}
