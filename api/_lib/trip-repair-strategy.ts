import type { TripPlan } from '../../src/types/trip.js'
import {
  PLAN_DIVERSITY_ROTATION_STEP,
  PLAN_IDS,
  getCoverageBasisMinutes,
  getMinimumRequiredActualMinutes,
  getScheduleCapacityMinutes,
  getTargetCoverageRatio,
  type TripWindowInput,
} from './trip-planning-rules.js'

export function comparePlansByDisplayPriority(left: TripPlan, right: TripPlan) {
  return getPlanDisplayPriority(left.id) - getPlanDisplayPriority(right.id)
}

export function getPlanDisplayPriority(planId: string) {
  const index = PLAN_IDS.findIndex((candidateId) => candidateId === planId)
  return index >= 0 ? index : PLAN_IDS.length
}

export function getCoverageRepairTargetMinutes(input: TripWindowInput) {
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  const coverageBasisMinutes = getCoverageBasisMinutes(input) ?? scheduleCapacityMinutes
  const minimumMinutes = getMinimumRequiredActualMinutes(input) ?? 0

  if (!scheduleCapacityMinutes || !coverageBasisMinutes) return minimumMinutes

  return Math.max(
    minimumMinutes,
    Math.min(
      scheduleCapacityMinutes,
      Math.ceil(coverageBasisMinutes * getTargetCoverageRatio(coverageBasisMinutes)),
    ),
  )
}

export function getPlanDiversityOffset(planId: string | undefined, salt = 0) {
  const priority = getPlanDisplayPriority(planId ?? '')
  return priority * PLAN_DIVERSITY_ROTATION_STEP + salt
}

export function pickRotatedItem<T>(items: T[], offset: number) {
  if (items.length === 0) return null
  const normalizedOffset = ((Math.trunc(offset) % items.length) + items.length) % items.length
  return items[normalizedOffset]
}
