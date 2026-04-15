import type { TripPlan } from '../types/trip'

const TRIP_PLANS_STORAGE_KEY = 'tripneeder.generatedPlans'

export function saveGeneratedPlans(plans: TripPlan[]) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(plans))
}

export function loadGeneratedPlans() {
  const rawPlans = sessionStorage.getItem(TRIP_PLANS_STORAGE_KEY)

  if (!rawPlans) {
    return []
  }

  try {
    return JSON.parse(rawPlans) as TripPlan[]
  } catch {
    return []
  }
}
