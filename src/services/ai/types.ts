import type { TripInput, TripPlan, TransportMode } from '../../types/trip'

export type PartialTripPlan = Partial<TripPlan> & {
  type?: TripPlan['type']
  title?: string
  subtitle?: string
  summary?: string
}

export type GenerateTripPlansRequest = {
  input: TripInput
  accessToken?: string
  signal?: AbortSignal
  onPlan?: (plan: PartialTripPlan) => void
}

export type GenerateTripPlansResponse = {
  plans: TripPlan[]
}

export type CompleteTripPlanDetailsRequest = {
  input: TripInput
  plan: TripPlan
  accessToken?: string
  signal?: AbortSignal
}

export type CompleteTripPlanDetailsResponse = {
  plan: TripPlan
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

  completeTripPlanDetails(
    request: CompleteTripPlanDetailsRequest,
  ): Promise<CompleteTripPlanDetailsResponse>
}
