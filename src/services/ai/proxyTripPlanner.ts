import type {
  AiTripPlanner,
  CompleteTripPlanDetailsRequest,
  CompleteTripPlanDetailsResponse,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  PartialTripPlan,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'

type StreamEvent =
  | { event: 'plan'; plan: PartialTripPlan }
  | { event: 'done'; response: GenerateTripPlansResponse }
  | { event: 'error'; message: string }
  | { event: 'points_warning'; message: string }
  | { event: 'plan_warning'; message: string }

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
      signal: request.signal,
    })

    const contentType = response.headers.get('content-type') ?? ''
    const isNdjson = contentType.includes('application/x-ndjson')

    if (!response.ok && !isNdjson) {
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null

      throw new Error(
        data && 'error' in data && data.error
          ? data.error
          : 'AI 分析失敗，請稍後再試。',
      )
    }

    if (!isNdjson || !response.body) {
      const data = (await response.json().catch(() => null)) as
        | GenerateTripPlansResponse
        | { error?: string }
        | null

      if (!isGenerateTripPlansResponse(data)) {
        throw new Error('這次 AI 產生的行程資料不夠完整，請重新分析一次。')
      }

      return data
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let finalResponse: GenerateTripPlansResponse | null = null
    let errorMessage: string | null = null
    const warnings: string[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let parsed: StreamEvent
        try {
          parsed = JSON.parse(trimmed) as StreamEvent
        } catch {
          continue
        }

        if (parsed.event === 'plan') {
          request.onPlan?.(parsed.plan)
        } else if (parsed.event === 'done') {
          finalResponse = parsed.response
        } else if (parsed.event === 'error') {
          errorMessage = parsed.message
        } else if (parsed.event === 'plan_warning') {
          warnings.push(parsed.message)
          request.onWarning?.(parsed.message)
        }
      }
    }

    if (errorMessage) {
      throw new Error(errorMessage)
    }

    if (!isGenerateTripPlansResponse(finalResponse)) {
      throw new Error('這次 AI 產生的行程資料不夠完整，請重新分析一次。')
    }

    const combinedWarnings = Array.from(
      new Set([...(finalResponse.warnings ?? []), ...warnings]),
    )
    if (combinedWarnings.length > 0) {
      finalResponse = {
        ...finalResponse,
        warnings: combinedWarnings,
      }
    }

    return finalResponse
  }

  async recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse> {
    void request
    throw new Error('Thin proxy 尚未接上，正式分享前 OpenAI API 需改走 proxy。')
  }

  async completeTripPlanDetails(
    request: CompleteTripPlanDetailsRequest,
  ): Promise<CompleteTripPlanDetailsResponse> {
    const response = await fetch('/api/generate-trip-details', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.accessToken
          ? { Authorization: `Bearer ${request.accessToken}` }
          : {}),
      },
      body: JSON.stringify({
        input: request.input,
        plan: request.plan,
      }),
      signal: request.signal,
    })

    const data = (await response.json().catch(() => null)) as
      | CompleteTripPlanDetailsResponse
      | { error?: string }
      | null

    if (!response.ok) {
      throw new Error(
        data && 'error' in data && data.error
          ? data.error
          : '細節補充失敗，請稍後再試。',
      )
    }

    if (!isCompleteTripPlanDetailsResponse(data)) {
      throw new Error('細節補充失敗，請稍後再試。')
    }

    return data
  }
}

function isGenerateTripPlansResponse(
  value: unknown,
): value is GenerateTripPlansResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plans' in value &&
    Array.isArray((value as { plans: unknown }).plans)
  )
}

function isCompleteTripPlanDetailsResponse(
  value: unknown,
): value is CompleteTripPlanDetailsResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plan' in value &&
    typeof (value as { plan: unknown }).plan === 'object' &&
    (value as { plan: unknown }).plan !== null
  )
}
