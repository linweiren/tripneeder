import type { TripInput, TripPlan, TransportMode } from '../../types/trip'

export type GenerateTripPlansRequest = {
  input: TripInput
  accessToken?: string
}

export type GenerateTripPlansResponse = {
  plans: TripPlan[]
}

export type RecalculateTransportRequest = {
  plan: TripPlan
  transportMode: TransportMode
  allowedMinutes: number
}

export type RecalculateTransportResponse = {
  plan: TripPlan
  isOverTime: boolean
  overTimeReason?: string
}

export interface AiTripPlanner {
  generateTripPlans(
    request: GenerateTripPlansRequest,
  ): Promise<GenerateTripPlansResponse>

  recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse>
}
