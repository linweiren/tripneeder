import { identityFixture } from './plan-identity.mjs'
import { FIXED_NOW } from './supplement-quality.mjs'

// Fixed inputs and existing preference signals; these are crafted AI responses,
// not evidence that a model obeys the style prompt. Durations are fixture data,
// never product thresholds or style scores.
export function styleGenerationFixture(kind = 'positioning') {
  const f = identityFixture()
  f.input = { ...f.input, category: 'explore', budget: 'standard', people: 2, tags: ['photo_first'] }
  const [museum, river, meal, dining] = f.candidates.allCandidates
  museum.types = ['museum']
  river.types = ['park']
  meal.types = dining.types = ['restaurant']
  const gallery = { ...museum, id: `${museum.id}-gallery`, placeId: `${museum.placeId}-gallery`,
    name: '地方藝術展覽館', lat: 22.613, distanceKm: 1.45, types: ['art_gallery'], duration: 60 }
  f.candidates.allCandidates.push(gallery)
  if (kind === 'sparse') f.candidates.allCandidates = [museum, river, meal]
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const from of f.candidates.allCandidates) for (const to of f.candidates.allCandidates) {
    if (from !== to) f.routes[`${from.placeId}>${to.placeId}`] = 4
  }
  if (kind !== 'sparse') {
    f.routes[`${museum.placeId}>${gallery.placeId}`] = 10
    f.routes[`${gallery.placeId}>${meal.placeId}`] = f.routes[`${gallery.placeId}>${dining.placeId}`] = 6
  }
  f.plans = f.plans.map(plan => {
    const durations = plan.type === 'safe' ? [150, 60, 45]
      : plan.type === 'balanced' ? [90, 75, 90] : [60, 75, 120]
    let stops = plan.stops.map((stop, index) => ({ ...stop, duration: durations[index] }))
    if (plan.type === 'explore' && kind === 'positioning') {
      stops = [{ ...stops[0], duration: 60 }, { ...gallery }, { ...stops[1], duration: 60 },
        { ...stops[2], duration: 75 }]
    }
    if (['identical', 'aliases', 'duplicate', 'missing', 'missing-balanced', 'unknown', 'conflict'].includes(kind)) {
      stops = structuredClone(f.plan.stops)
    }
    const transportSegments = stops.slice(1).map((stop, index) => ({ fromStopId: stops[index].id,
      toStopId: stop.id, mode: 'scooter', label: '', duration: f.routes[`${stops[index].placeId}>${stop.placeId}`] }))
    return { ...plan, stops, transportSegments, title: `原始${plan.type}體驗`, totalTime:
      stops.reduce((n, s) => n + s.duration, 0) + transportSegments.reduce((n, s) => n + s.duration, 0) }
  })
  f.aiPlans = structuredClone(f.plans)
  if (kind === 'aliases') f.aiPlans = [f.aiPlans[2], f.aiPlans[0], f.aiPlans[1]]
    .map((plan, index) => ({ ...plan, id: `explore-${index + 1}` }))
  if (kind === 'duplicate') f.aiPlans.forEach((plan, index) => { plan.id = `explore-${index + 1}`; plan.type = 'explore' })
  if (kind === 'missing') delete f.aiPlans[0].type
  if (kind === 'missing-balanced') delete f.aiPlans[1].type
  if (kind === 'unknown') f.aiPlans[0].type = 'unknown'
  if (kind === 'conflict') f.aiPlans[0].id = 'balanced'
  f.mockOptions = {
    persona: { persona_stamina: '普通', persona_diet: '無', persona_people: 2 },
    preferenceEvents: [
      { event_type: 'start_navigation', place_id: 'history-museum', place_name: '歷史文化展覽',
        stop_type: 'main_activity', google_types: ['museum'], candidate_role: 'main_activity',
        plan_type: 'balanced', input_category: 'explore', input_tags: ['photo_first'],
        created_at: new Date(FIXED_NOW - 86400000).toISOString() },
      { event_type: 'open_maps', place_id: 'history-gallery', place_name: '藝術展覽',
        stop_type: 'main_activity', google_types: ['art_gallery'], candidate_role: 'main_activity',
        plan_type: 'explore', input_category: 'explore', input_tags: ['photo_first'],
        created_at: new Date(FIXED_NOW - 2 * 86400000).toISOString() },
    ],
  }
  return f
}
