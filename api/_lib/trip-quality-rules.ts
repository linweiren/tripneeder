import type { Stop, TripPlan } from '../../src/types/trip.js'
import {
  getAllowedTripMinutes,
  getRequiredMealWindows,
  isStopAlignedWithMealWindow,
  type TripWindowInput,
} from './trip-planning-rules.js'
import {
  getDefaultStopDuration,
  getPlanActualDuration,
} from './trip-plan-metrics.js'
import { getEstimatedPlanArrivalMinutes } from './trip-timeline.js'

export type StopRhythmRole = 'food' | 'open_space' | 'shopping' | 'rest' | 'main_activity'

export function getMinimumMeaningfulStopDuration(stop: Stop) {
  if (stop.type === 'food') return 45
  return 40
}

export function getRequiredMealCoverageIssues(plan: TripPlan, input: TripWindowInput) {
  const mealWindows = getRequiredMealWindows(input)
  if (mealWindows.length < 2) return []

  const foodStops = plan.stops.filter((stop) => stop.type === 'food')
  if (foodStops.length < mealWindows.length) {
    return [
      `行程涵蓋${mealWindows.map((mealWindow) => mealWindow.label).join('與')}，至少需要 ${mealWindows.length} 個餐飲停留（目前 ${foodStops.length} 個）`,
    ]
  }

  const arrivals = getEstimatedPlanArrivalMinutes(plan, input)
  const uncoveredMealWindows = mealWindows.filter((mealWindow) =>
    !plan.stops.some((stop, index) => {
      if (stop.type !== 'food') return false

      return isStopAlignedWithMealWindow(
        arrivals[index],
        Number(stop.duration) || getDefaultStopDuration('food'),
        mealWindow,
      )
    }),
  )

  if (uncoveredMealWindows.length === 0) return []

  return [
    `餐飲停留未對齊${uncoveredMealWindows.map((mealWindow) => mealWindow.label).join('與')}時段`,
  ]
}

export function getPlanRhythmIssues(plan: TripPlan, input: TripWindowInput) {
  const issues: string[] = []
  const stops = plan.stops ?? []
  const allowedMinutes = getAllowedTripMinutes(input)
  const transportMinutes = (plan.transportSegments ?? []).reduce(
    (total, segment) => total + segment.duration,
    0,
  )
  const actualMinutes = getPlanActualDuration(plan)

  stops.forEach((stop, index) => {
    if (stop.duration < getMinimumMeaningfulStopDuration(stop)) {
      issues.push(`${stop.name} 停留時間過短（${stop.duration} 分鐘）`)
    }

    if (index > 0 && index < stops.length - 1 && stop.type === 'main_activity' && stop.duration < 45) {
      issues.push(`${stop.name} 作為中段主景點停留過短`)
    }
  })

  if (hasTooManySimilarStops(stops, 'open_space')) {
    issues.push('同一方案中開放空間/公園類景點過多，節奏過於單一')
  }

  if (hasConsecutiveSimilarStops(stops, 'open_space', 3)) {
    issues.push('連續安排過多公園或戶外開放空間')
  }

  if (actualMinutes > 0 && transportMinutes / actualMinutes > 0.35) {
    issues.push('交通時間占比過高，路線不夠緊湊')
  }

  if (allowedMinutes && actualMinutes < allowedMinutes * 0.78 && stops.length >= 4) {
    issues.push('站點數偏多但實際停留內容不足，像是在湊路線')
  }

  return issues
}

export function hasTooManySimilarStops(stops: Stop[], role: StopRhythmRole) {
  const count = stops.filter((stop) => inferStopRhythmRole(stop) === role).length
  return stops.length >= 3 && count >= 3
}

export function hasConsecutiveSimilarStops(
  stops: Stop[],
  role: StopRhythmRole,
  maxCount: number,
) {
  let streak = 0

  for (const stop of stops) {
    if (inferStopRhythmRole(stop) === role) {
      streak += 1
      if (streak >= maxCount) return true
    } else {
      streak = 0
    }
  }

  return false
}

export function inferStopRhythmRole(stop: Stop): StopRhythmRole {
  const text = `${stop.name} ${stop.address}`.toLocaleLowerCase('zh-TW')
  if (stop.type === 'food') return 'food'
  if (/(公園|步道|海邊|湖|山|森林|河濱|草地|濕地|park)/i.test(text)) return 'open_space'
  if (/(市場|商圈|老街|夜市|百貨|購物|mall|outlet)/i.test(text)) return 'shopping'
  if (/(咖啡|書店|茶|甜點|cafe|coffee)/i.test(text)) return 'rest'
  return 'main_activity'
}
