import { ProxyTripPlanner } from './proxyTripPlanner'
import type { AiTripPlanner } from './types'

export const tripPlanner: AiTripPlanner = new ProxyTripPlanner()

export type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'
