import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { getScheduleCapacityMinutes, type TripWindowInput } from './trip-planning-rules.js'

export function getPlanActualDuration(plan: TripPlan) {
  return (
    plan.stops.reduce((total, stop) => total + stop.duration, 0) +
    plan.transportSegments.reduce((total, segment) => total + segment.duration, 0)
  )
}

export function estimateTransportTotal(stops: Stop[]) {
  return Math.max(stops.length - 1, 0) * 18
}

// Existing local-fallback assumptions, shared when final routes need re-estimation.
// This is not a quote or verified admission/menu/transport pricing.
export function estimatePlanBudget(stops: Stop[], input: Pick<TripInput, 'people'>) {
  const base = stops.reduce((total, stop) => total + (stop.type === 'food' ? 350 : 120), 0)
  const people = input.people ?? 2
  return Math.max(300, Math.round(base * Math.max(1, people / 2)))
}

export function getMinimumStopCountForLongTrip(input: TripWindowInput) {
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  if (!scheduleCapacityMinutes) return 2

  if (scheduleCapacityMinutes > 16 * 60) return 6
  if (scheduleCapacityMinutes > 12 * 60) return 5
  if (scheduleCapacityMinutes > 8 * 60) return 4
  if (scheduleCapacityMinutes > 4 * 60) return 3

  return 2
}

export function getDefaultStopDuration(type: Stop['type']) {
  if (type === 'food') return 60
  if (type === 'ending_or_transition') return 45

  return 75
}

export function getMinimumStopDuration(stop: Stop) {
  if (stop.type === 'food') return 45
  return 40
}

export function getReasonablePlanDuration(stops: Stop[]) {
  return stops.reduce((total, stop) => total + getReasonableStopDuration(stop), 0)
}

export function getReasonableStopDuration(stop: Stop) {
  return Math.min(getMaximumStopDuration(stop), Math.max(getMinimumStopDuration(stop), getDefaultStopDuration(stop.type)))
}

// Shared stay/rhythm evidence only. Street and district names are not venue
// semantics. Keep the existing name-based duration references: an outdoor type
// supports a rhythm hint, but does not by itself justify a longer stay.
function hasOutdoorStopName(stop: Pick<Stop, 'name'>) {
  return /(公園|步道|海邊|湖|山|森林|河濱|草地|park)/i.test(stop.name)
}

export function hasOutdoorStopEvidence(stop: Pick<Stop, 'name' | 'googleTypes'>) {
  return (stop.googleTypes ?? []).some(type =>
    ['park', 'city_park', 'national_park', 'hiking_area'].includes(type)) ||
    hasOutdoorStopName(stop)
}

export function getMaximumStopDuration(stop: Stop) {
  const text = stop.name.toLocaleLowerCase('zh-TW')

  if (stop.type === 'food') return 90
  if (/(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)) {
    return 45
  }
  if (/(市場|商圈|老街|夜市|百貨|購物|mall|outlet)/i.test(text)) return 150
  if (/(博物館|美術館|展覽|園區|文化|文創|藝術|science|museum)/i.test(text)) return 150
  if (hasOutdoorStopName(stop)) return 120
  if (/(咖啡|書店|茶|甜點|cafe|coffee)/i.test(text)) return 100

  return 90
}

export function getStopStretchWeight(stop: Stop) {
  const maxDuration = getMaximumStopDuration(stop)

  if (maxDuration <= 45) return 0
  if (stop.type === 'food') return 1
  if (maxDuration >= 150) return 4
  if (maxDuration >= 120) return 3

  return 2
}
