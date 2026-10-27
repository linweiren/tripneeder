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
import { sameGenerationInput } from './generationInput.js'

class GenerationRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

type StreamEvent =
  | { event: 'progress'; style: 'safe' | 'balanced' | 'explore'; stage: string }
  | { event: 'plan'; plan: PartialTripPlan }
  | { event: 'done'; response: GenerateTripPlansResponse }
  | { event: 'error'; message: string }
  | { event: 'points_warning'; message: string }
  | { event: 'plan_warning'; message: string }

export class ProxyTripPlanner implements AiTripPlanner {
  async generateTripPlans(
    request: GenerateTripPlansRequest,
  ): Promise<GenerateTripPlansResponse> {
    if (!request.generationId) throw new Error('缺少生成編號，請重新開啟生成流程。')
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.generateOnce(request) } catch (error) {
        if (request.signal?.aborted) throw error
        if (error instanceof GenerationRequestError && [400, 401, 402, 403, 404, 409].includes(error.status)) throw error
        const recovered = await recoverGeneration(request)
        if (recovered) return recovered
        if (attempt === 1) throw error
      }
    }
    throw new Error('請使用原生成編號重試。')
  }

  private async generateOnce(request: GenerateTripPlansRequest): Promise<GenerateTripPlansResponse> {
    const response = await fetchTripApi('/api/generate-trip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.accessToken
          ? { Authorization: `Bearer ${request.accessToken}` }
          : {}),
      },
      body: JSON.stringify({
        generationId: request.generationId,
        input: request.input,
      }),
      signal: request.signal,
    })
    if (response.status === 202) throw new Error('生成仍在進行，正在確認原生成紀錄。')

    const contentType = response.headers.get('content-type') ?? ''
    const isNdjson = contentType.includes('application/x-ndjson')

    if (!response.ok && !isNdjson) {
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null

      throw new GenerationRequestError(
        data && 'error' in data && data.error
          ? data.error
          : 'AI 分析失敗，請稍後再試。', response.status,
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

        if (parsed.event === 'progress') {
          request.onProgress?.(parsed.style)
        } else if (parsed.event === 'plan') {
          request.onPlan?.(parsed.plan)
        } else if (parsed.event === 'done') {
          finalResponse = parsed.response
          await reader.cancel().catch(() => undefined)
          return mergeWarnings(finalResponse, warnings)
        } else if (parsed.event === 'error' || parsed.event === 'points_warning') {
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

    return mergeWarnings(finalResponse, warnings)
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
    const response = await fetchTripApi('/api/generate-trip-details', {
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

export type PaidGenerationStatus = {
  generationId: string
  status: 'running' | 'completed' | 'failed'
  retryable?: boolean
  response?: GenerateTripPlansResponse
  input?: GenerateTripPlansRequest['input']
}

export async function getPaidGeneration(id: string, accessToken?: string, signal?: AbortSignal): Promise<PaidGenerationStatus> {
  const response = await fetchTripApi(`/api/trip-generations?generationId=${encodeURIComponent(id)}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, signal, cache: 'no-store',
  })
  if (!response.ok) throw new Error('付款狀態暫時無法確認，請稍後使用原生成紀錄重試。')
  return response.json()
}

async function recoverGeneration(request: GenerateTripPlansRequest) {
  // No provider retry until the database confirms this attempt may be taken over.
  for (let poll = 0; poll < 125; poll++) {
    const generation = await getPaidGeneration(request.generationId!, request.accessToken, request.signal)
    if (generation.status === 'completed' && isGenerateTripPlansResponse(generation.response)) {
      if (!sameGenerationInput(generation.input, request.input)) throw new Error('生成編號與原始輸入不符，無法沿用已付款結果。')
      return generation.response
    }
    if (generation.status === 'failed') throw new Error('這次生成未完成，請使用重試按鈕繼續原生成紀錄。')
    if (generation.status === 'running' && generation.retryable) return null
    if (generation.status !== 'running') throw new Error('付款狀態尚未確認，請稍後重試原生成紀錄。')
    await new Promise<void>((resolve, reject) => {
      request.signal?.throwIfAborted()
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); resolve() }, 3000)
      request.signal?.addEventListener('abort', abort, { once: true })
    })
  }
  throw new Error('仍在確認付款狀態，請稍後使用原生成紀錄重試。')
}

async function fetchTripApi(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }

    throw new Error(
      '無法連線到行程生成服務，可能是本地 dev server 正在重啟、網路中斷，或串流連線被切斷。請等伺服器重新啟動完成後再試一次。',
    )
  }
}

function mergeWarnings(
  response: GenerateTripPlansResponse,
  warnings: string[],
) {
  const combinedWarnings = Array.from(
    new Set([...(response.warnings ?? []), ...warnings]),
  )

  return combinedWarnings.length > 0
    ? {
        ...response,
        warnings: combinedWarnings,
      }
    : response
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
