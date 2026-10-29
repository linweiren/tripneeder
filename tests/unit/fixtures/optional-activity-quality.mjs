import { suitabilityFixture } from './meal-suitability.mjs'
import { FIXED_NOW, mockMatrix } from './supplement-quality.mjs'
import { assessVisitRequirements } from '../../../api/_lib/trip-demand-compliance.ts'
import { compareOriginalActivities } from '../../../api/_lib/trip-activity-purpose.ts'

// Controlled evidence, not a historical Google or AI record. All network responses
// are supplied by mockMatrix; route minutes are simulated, not real-world timings.
export function optionalActivityFixture(kind) {
  const f = suitabilityFixture('museum-coherent')
  const ids = new Map(f.candidates.allCandidates.map(c => [c.placeId, `${c.placeId}-${kind}`]))
  f.plan.stops = f.plan.stops.map(s => ({ ...s, id: `${s.id}-${kind}`, placeId: ids.get(s.placeId) }))
  f.candidates.allCandidates = f.candidates.allCandidates.map(c => ({ ...c,
    id: `${c.id}-${kind}`, placeId: ids.get(c.placeId) }))
  const [museum, park] = f.candidates.allCandidates
  Object.assign(museum, { name: '高雄市立歷史博物館', types: ['museum'] })
  park.types = ['park']
  Object.assign(f.plan.stops[0], { name: museum.name })
  f.input.customCategory = kind === 'generic' ? '' : '想參觀博物館'
  f.input.category = kind === 'generic' ? 'explore' : 'other'
  const alternative = { ...museum, id: `${museum.id}-alternative`, placeId: `${museum.placeId}-alternative`,
    name: '高雄鐵路地下化展示館', lat: 22.607, distanceKm: 1, score: 99 }
  if (kind === 'route-gain-demand-loss') alternative.types = ['cultural_center']
  if (kind === 'route-gain-shortens-activity' || kind === 'demand-gain-shortens-activity') {
    f.plan.stops[0].duration = museum.duration = 110
  }
  if (['demand-gain', 'demand-gain-shortens-activity', 'demand-gain-route-failure'].includes(kind)) {
    f.input.customCategory = '想參觀博物館與美術展覽'
    alternative.types = ['museum', 'art_gallery']
  }
  if (kind === 'demand-gain-route-failure') f.failRoutes = true
  if (kind === 'ranking-only' || kind === 'ranking-and-route') alternative.score = 110
  if (kind === 'unknown') museum.types = ['point_of_interest']
  if (kind === 'far-original') museum.distanceKm = 3
  if (kind === 'closed') museum.openingHours = { ...museum.openingHours, windows: [{
    openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 630 * 60000),
  }] }
  f.museum = museum; f.alternative = alternative
  f.candidates.allCandidates.push(alternative)
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const a of f.candidates.allCandidates) for (const b of f.candidates.allCandidates) if (a !== b) {
    f.routes[`${a.placeId}>${b.placeId}`] = 4
  }
  const meal = f.plan.stops[1]
  if (kind.startsWith('route-gain') || kind === 'ranking-and-route') f.routes[`${museum.placeId}>${meal.placeId}`] = 12
  if (kind === 'route-loss') f.routes[`${alternative.placeId}>${meal.placeId}`] = 12
  if (kind === 'fallback-route-failure') delete f.routes[`${museum.placeId}>${meal.placeId}`]
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({
    fromStopId: f.plan.stops[i].id, toStopId: s.id, mode: 'scooter',
    duration: f.routes[`${f.plan.stops[i].placeId}>${s.placeId}`] ?? 4, label: '',
  }))
  f.placeOverrides = Object.fromEntries(f.candidates.allCandidates.map(c => [c.placeId,
    { displayName: { text: c.name }, types: c.types ?? [] }]))
  if (kind === 'closed') f.placeOverrides[museum.placeId].regularOpeningHours = {
    periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0, minute: 0 },
      close: { day, hour: 10, minute: 30 } })),
  }
  return f
}

export async function replayOptionalActivity(t, api, kind, options = {}) {
  const f = optionalActivityFixture(kind)
  if (options.style) f.plan.id = f.plan.type = options.style
  const calls = mockMatrix(t, f)
  const attempts = [], transitions = []
  const debug = { beginRepairAttempt(_plan, phase) { attempts.push(phase); return phase },
    recordPlanTransition(_before, _after, phase, context) { transitions.push({ phase, ...context }) } }
  const start = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
  const result = await api.repairAndValidatePlanForDelivery(start, f.input, f.candidates, new Set(),
    'optional-quality', options.used ?? new Set([f.museum.placeId]), debug)
  const issues = result.plan ? await api.getDeliveryPlanIssues(result.plan, f.input, 'quality-final',
    { candidates: f.candidates }) : result.issues
  return { f, result, calls, attempts, transitions, metrics: {
    kind, style: f.plan.type, valid: Boolean(result.plan) && !result.routesFailed && issues.length === 0,
    issues, routeCalls: calls.length, uniqueRoutes: new Set(calls).size, repairAttempts: attempts.length,
    selected: result.plan?.stops.map(s => ({ placeId: s.placeId, name: s.name, duration: s.duration })),
    originalRequirements: assessVisitRequirements(start, f.input, f.candidates),
    requirements: result.plan && assessVisitRequirements(result.plan, f.input, f.candidates),
    impact: result.plan && compareOriginalActivities(start.stops, result.plan.stops),
    travel: result.plan?.transportSegments.reduce((sum, leg) => sum + leg.duration, 0),
    decisions: transitions.filter(item => item.phase.startsWith('fallback:activity-diversity')),
  } }
}
