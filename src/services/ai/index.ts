import { OpenAiTripPlanner } from './openAiTripPlanner'
import { ProxyTripPlanner } from './proxyTripPlanner'
import type { AiTripPlanner } from './types'

const USE_PROXY = false

function createTripPlanner(): AiTripPlanner {
  if (USE_PROXY) {
    return new ProxyTripPlanner()
  }

  return new OpenAiTripPlanner()
}

export const tripPlanner: AiTripPlanner = createTripPlanner()

export type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'
