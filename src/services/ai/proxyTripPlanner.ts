import type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'

export class ProxyTripPlanner implements AiTripPlanner {
  async generateTripPlans(
    request: GenerateTripPlansRequest,
  ): Promise<GenerateTripPlansResponse> {
    void request
    throw new Error('Thin proxy 尚未接上，正式分享前 Gemini API 需改走 proxy。')
  }

  async recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse> {
    void request
    throw new Error('Thin proxy 尚未接上，正式分享前 Gemini API 需改走 proxy。')
  }
}
