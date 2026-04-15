import type { TripInput, TripPlan } from '../types/trip'

const TRIP_PLANS_STORAGE_KEY = 'tripneeder.generatedPlans'
const TRIP_INPUT_STORAGE_KEY = 'tripneeder.lastInput'

export function saveGeneratedPlans(plans: TripPlan[], input?: TripInput) {
  sessionStorage.setItem(TRIP_PLANS_STORAGE_KEY, JSON.stringify(plans))

  if (input) {
    sessionStorage.setItem(TRIP_INPUT_STORAGE_KEY, JSON.stringify(input))
  }
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

export function loadLastTripInput() {
  const rawInput = sessionStorage.getItem(TRIP_INPUT_STORAGE_KEY)

  if (!rawInput) {
    return null
  }

  try {
    return JSON.parse(rawInput) as TripInput
  } catch {
    return null
  }
}
