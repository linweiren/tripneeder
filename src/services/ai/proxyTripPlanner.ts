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
    const response = await fetch('/api/generate-trip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.accessToken
          ? { Authorization: `Bearer ${request.accessToken}` }
          : {}),
      },
      body: JSON.stringify({
        input: request.input,
      }),
    })

    const data = (await response.json().catch(() => null)) as
      | GenerateTripPlansResponse
      | { error?: string }
      | null

    if (!response.ok) {
      throw new Error(
        data && 'error' in data && data.error
          ? data.error
          : 'AI 分析失敗，請稍後再試。',
      )
    }

    if (!isGenerateTripPlansResponse(data)) {
      throw new Error('這次 AI 產生的行程資料不夠完整，請重新分析一次。')
    }

    return data
  }

  async recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse> {
    void request
    throw new Error('Thin proxy 尚未接上，正式分享前 OpenAI API 需改走 proxy。')
  }
}

function isGenerateTripPlansResponse(
  value: unknown,
): value is GenerateTripPlansResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plans' in value &&
    Array.isArray(value.plans)
  )
}
