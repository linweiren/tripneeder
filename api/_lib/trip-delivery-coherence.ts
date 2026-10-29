import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { getTripPlanStyleLabel } from '../../src/services/ai/tripPlanIdentity.js'
import { estimatePlanBudget } from './trip-plan-metrics.js'
import { rememberPlanTextTransition } from './trip-plan-text-consistency.js'

const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-TW').replace(/\s+/g, '').trim()
const stopIdentity = (stop: Stop) => stop.placeId?.trim() || JSON.stringify([normalized(stop.name), normalized(stop.address)])
const routeKey = (plan: TripPlan) => JSON.stringify([plan.transportMode, plan.stops.map(stopIdentity)])
const costKey = (plan: TripPlan) => JSON.stringify([routeKey(plan), plan.stops.map(stop => stop.type)])
const minutes = (time?: string) => time && /^\d\d:\d\d$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null

export function areDeliveryChoicesEquivalent(left: TripPlan, right: TripPlan) {
  if (routeKey(left) !== routeKey(right)) return false
  const startLeft = minutes(left.scheduleStartTime), startRight = minutes(right.scheduleStartTime)
  if (startLeft !== null && startRight !== null) {
    const gap = Math.abs(startLeft - startRight)
    if (Math.min(gap, 1440 - gap) >= 30) return false
  }
  // Preserve real depth/rhythm choices; minor timing jitter alone is not a new option.
  // Never change durations to pass this comparison.
  return left.stops.reduce((total, stop, index) => total + Math.abs(stop.duration - right.stops[index].duration), 0) < 30
}

function finalTitle(plan: TripPlan) {
  // Closed, affirmative landmark-title forms only. No broad entity guessing.
  const claim = /^(.{2,}?(?:潭|公園|風景區|夜市|老街|博物館|美術館))(?:浪漫|悠閒|輕鬆|特色)?(?:夜景|散步|漫遊|小旅行|之旅|體驗)$/.exec(plan.title.trim())?.[1]
  if (!claim || plan.stops.some(stop => normalized(stop.name).includes(normalized(claim)))) return plan
  const title = [...new Set(plan.stops.map(stop => stop.name.trim()).filter(Boolean))].slice(0, 2).join('・')
  return rememberPlanTextTransition(plan, { ...plan, title: title || getTripPlanStyleLabel(plan.type)! })
}

export function finalizeDeliveryChoices(plans: TripPlan[], input: TripInput, sourcePlans: TripPlan[] = []) {
  const groups = new Map<string, TripPlan[]>()
  for (const plan of plans) groups.set(costKey(plan), [...(groups.get(costKey(plan)) ?? []), plan])
  const warnings: string[] = [], delivered: TripPlan[] = []
  for (const source of plans) {
    let plan = finalTitle(source)
    const original = sourcePlans.find(previous => previous.type === plan.type)
    const group = groups.get(costKey(plan))!
    // No fee breakdown exists in the model contract. Do not preserve conflicting
    // style-only prices or a stale quote after a venue/purpose replacement.
    if ((original && costKey(original) !== costKey(plan)) || new Set(group.map(value => value.budget)).size > 1) {
      const people = Math.max(2, input.people ?? 2)
      plan = rememberPlanTextTransition(plan, { ...plan, budget: estimatePlanBudget(plan.stops, input),
        budgetEstimateNote: `以${people}人基準、餐飲每站350元、其他停留120元粗估（以上站點費用為2人基準，依人數比例放大，最低300元）；非票價或店家報價，實際消費與交通費另確認。` })
    }
    const same = delivered.find(previous => areDeliveryChoicesEquivalent(previous, plan))
    if (same) {
      warnings.push(`${getTripPlanStyleLabel(plan.type)}與${getTripPlanStyleLabel(same.type)}的實際路線與活動安排沒有足夠差異，本次合併顯示。`)
    } else delivered.push(plan)
  }
  return { plans: delivered, warnings }
}
