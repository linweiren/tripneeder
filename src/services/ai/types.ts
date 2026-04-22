import type { TripInput, TripPlan, TransportMode } from '../../types/trip'

export type PartialTripPlan = Partial<TripPlan> & {
  type?: TripPlan['type']
  title?: string
  subtitle?: string
  summary?: string
}

export type Persona = {
  companion?: string
  budget?: string
  stamina?: string
  diet?: string
}

export type GenerateTripPlansRequest = {
  input: TripInput
  persona?: Persona
  accessToken?: string
  signal?: AbortSignal
  onPlan?: (plan: PartialTripPlan) => void
  onWarning?: (message: string) => void
}

export type GenerateTripPlansResponse = {
  plans: TripPlan[]
  warnings?: string[]
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
