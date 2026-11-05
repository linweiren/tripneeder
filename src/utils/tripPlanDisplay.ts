import type { PlanType, TripPlan } from '../types/trip.js'
import { compareTripPlanStyles, getTripPlanStyleLabel, TRIP_PLAN_TYPES } from '../services/ai/tripPlanIdentity.js'

// Display positions belong to the currently visible list, never to a strategy.
export function getTripPlanDisplayLabel(index: number) {
  return `方案${['一', '二', '三'][index] ?? String(index + 1)}`
}

export function getGenerationDisplayStyles(progressStyles: readonly PlanType[]) {
  return [...new Set(progressStyles)].sort((left, right) =>
    compareTripPlanStyles({ type: left }, { type: right }))
}

// Some saved/API fallback titles contain only the old strategy name. Translate
// that label at render time; retain authored titles and all persisted plan data.
export function getTripPlanDisplayTitle(title: string, label = getTripPlanDisplayLabel(0)) {
  return /^(?:(?:保守|平衡|探索)型?方案|safe|balanced|explore)$/i.test(title.trim())
    ? label : title
}

export function getTripPlanDisplayWarning(warning: string, plans: readonly Pick<TripPlan, 'type'>[]) {
  // Missing strategies have no display position. Keep the availability notice
  // without inventing numbers for options that are not actually shown.
  const missing = /^目前僅 (\d+) 個風格方案通過驗收；未能提供的風格：.+。$/.exec(warning)
  if (missing) return `目前僅 ${missing[1]} 個方案通過驗收。`

  return warning.replace(/(?:保守|平衡|探索)型?方案|\b(?:safe|balanced|explore)\b/gi, name => {
    const type = TRIP_PLAN_TYPES.find(type =>
      getTripPlanStyleLabel(type) === name.replace('型', '') || type === name.toLowerCase())
    const index = plans.findIndex(plan => plan.type === type)
    return index < 0 ? '其他方案' : getTripPlanDisplayLabel(index)
  })
}
