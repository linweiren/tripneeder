import { GeminiTripPlanner } from './geminiTripPlanner'
import { ProxyTripPlanner } from './proxyTripPlanner'
import type { AiTripPlanner } from './types'

const USE_PROXY = false

export const tripPlanner: AiTripPlanner = USE_PROXY
  ? new ProxyTripPlanner()
  : new GeminiTripPlanner()

export type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'
