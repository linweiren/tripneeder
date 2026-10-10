import type { PlanType, TripPlan } from '../../types/trip.js'

export const TRIP_PLAN_TYPES = ['safe', 'balanced', 'explore'] as const

export function isTripPlanType(value: unknown): value is PlanType {
  return TRIP_PLAN_TYPES.some(type => type === value)
}

// Type is the model's explicit style declaration. Neither array position nor an
// ID alone is evidence of style; conflicting declarations need regeneration.
export function normalizeTripPlanIdentity(value: unknown): TripPlan | null {
  if (!value || typeof value !== 'object') return null
  const plan = value as Record<string, unknown>
  if (!isTripPlanType(plan.type) || typeof plan.id !== 'string' || !plan.id.trim()) return null
  // Only exact reserved IDs declare a style. Model/legacy aliases such as
  // explore-1 are names, not evidence that an explicitly safe type is wrong.
  if (isTripPlanType(plan.id) && plan.id !== plan.type) return null
  // Keep canonical objects intact, including the repair's WeakMap provenance.
  return plan.id === plan.type ? value as TripPlan : { ...plan, id: plan.type } as TripPlan
}

export function normalizeTripPlanIdentities(values: readonly unknown[]): TripPlan[] {
  const plans = new Map<PlanType, TripPlan>()
  for (const value of values) {
    const plan = normalizeTripPlanIdentity(value)
    // Preserve one source per declared style; never relabel a duplicate to fill
    // another slot. Missing slots go through the existing bounded refill path.
    if (plan && !plans.has(plan.type)) plans.set(plan.type, plan)
  }
  return TRIP_PLAN_TYPES.flatMap(type => {
    const plan = plans.get(type)
    return plan ? [plan] : []
  })
}

export function compareTripPlanStyles(left: { type?: unknown }, right: { type?: unknown }) {
  const priority = (type: unknown) => isTripPlanType(type) ? TRIP_PLAN_TYPES.indexOf(type) : TRIP_PLAN_TYPES.length
  return priority(left.type) - priority(right.type)
}

export function getTripPlanStyleLabel(type: unknown) {
  if (!isTripPlanType(type)) return null
  return { safe: '保守方案', balanced: '平衡方案', explore: '探索方案' }[type]
}
