/// <reference types="node" />

import { buildTripPrompt, parseTripPlanSkeletonResponse } from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanSkeletonResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type { GenerateTripPlansRequest } from '../src/services/ai/types.js'
import { createClient } from '@supabase/supabase-js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: {
    authorization?: string
  }
  signal?: AbortSignal
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => void
  end: () => void
}

type RpcResult<T> = PromiseLike<{
  data: T | null
  error: {
    message: string
  } | null
}>

type PointsSupabaseClient = {
  rpc: <T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
  ) => RpcResult<T>
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'
const ANALYSIS_COST = 20

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const request = parseRequestBody(req.body)
  const accessToken = getBearerToken(req.headers?.authorization)

  if (!request) {
    res.status(400).json({ error: '行程偏好資料不完整，請回到表單重新送出。' })
    return
  }

  if (!accessToken) {
    res.status(401).json({ error: '請登入以繼續使用本服務。' })
    return
  }

  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    res.status(500).json({
      error: '尚未在 Vercel Environment Variables 設定 OPENAI_API_KEY。',
    })
    return
  }

  let supabase: PointsSupabaseClient
  try {
    supabase = createUserScopedSupabaseClient(accessToken)
    const balance = await getAvailablePoints(supabase)

    if (balance < ANALYSIS_COST) {
      res.status(402).json({
        error: `點數不足。每次分析需要 ${ANALYSIS_COST} 點，目前剩餘 ${balance} 點。`,
      })
      return
    }
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'AI 分析失敗，請稍後再試。',
    })
    return
  }

  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('X-Accel-Buffering', 'no')

  const writeEvent = (event: Record<string, unknown>) => {
    res.write(`${JSON.stringify(event)}\n`)
  }

  try {
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: buildTripPrompt(request.input),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'trip_plan_response',
            schema: tripPlanSkeletonResponseSchema,
            strict: false,
          },
        },
      }),
      signal: req.signal,
    })

    if (!openAiResponse.ok || !openAiResponse.body) {
      const message = await buildOpenAiErrorMessage(openAiResponse)
      writeEvent({ event: 'error', message })
      res.end()
      return
    }

    const extractor = new PlanExtractor()
    let fullText = ''
    let pointsConsumed = false

    const reader = openAiResponse.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let sseBuffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      sseBuffer += decoder.decode(value, { stream: true })
      const events = sseBuffer.split('\n\n')
      sseBuffer = events.pop() ?? ''

      for (const rawEvent of events) {
        const delta = extractDeltaFromSseEvent(rawEvent)
        if (!delta) continue

        fullText += delta
        const plans = extractor.push(delta)

        for (const plan of plans) {
          writeEvent({ event: 'plan', plan })

          if (!pointsConsumed) {
            pointsConsumed = true
            try {
              await consumeAnalysisPoints(supabase)
            } catch (error) {
              writeEvent({
                event: 'points_warning',
                message:
                  error instanceof Error
                    ? error.message
                    : '扣點流程失敗，請稍後再試。',
              })
            }
          }
        }
      }
    }

    let finalResponse
    try {
      finalResponse = parseTripPlanSkeletonResponse(fullText)
    } catch (error) {
      writeEvent({
        event: 'error',
        message:
          error instanceof Error
            ? error.message
            : '這次 AI 產生的行程資料不夠完整，請重新分析一次。',
      })
      res.end()
      return
    }

    writeEvent({ event: 'done', response: finalResponse })
    res.end()
  } catch (error) {
    writeEvent({
      event: 'error',
      message:
        error instanceof Error ? error.message : 'AI 分析失敗，請稍後再試。',
    })
    res.end()
  }
}

function extractDeltaFromSseEvent(rawEvent: string): string {
  const lines = rawEvent.split('\n')
  let dataPayload = ''

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataPayload += line.slice(5).trimStart()
    }
  }

  if (!dataPayload || dataPayload === '[DONE]') {
    return ''
  }

  try {
    const parsed = JSON.parse(dataPayload) as {
      type?: string
      delta?: string
    }

    if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      return parsed.delta
    }
  } catch {
    // Ignore unparseable SSE frames.
  }

  return ''
}

class PlanExtractor {
  private state: 'before_plans' | 'in_array' | 'in_plan' | 'after_plans' = 'before_plans'
  private preBuf = ''
  private depth = 0
  private inString = false
  private escape = false
  private planBuf = ''

  push(chunk: string): unknown[] {
    const emitted: unknown[] = []

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]

      if (this.state === 'before_plans') {
        this.preBuf += ch
        const plansIdx = this.preBuf.indexOf('"plans"')
        if (plansIdx >= 0) {
          const bracketIdx = this.preBuf.indexOf('[', plansIdx)
          if (bracketIdx >= 0) {
            this.state = 'in_array'
            this.preBuf = ''
          }
        }
        continue
      }

      if (this.state === 'in_array') {
        if (ch === '{') {
          this.state = 'in_plan'
          this.depth = 1
          this.planBuf = '{'
          this.inString = false
          this.escape = false
        } else if (ch === ']') {
          this.state = 'after_plans'
        }
        continue
      }

      if (this.state === 'in_plan') {
        this.planBuf += ch

        if (this.escape) {
          this.escape = false
          continue
        }
        if (ch === '\\') {
          this.escape = true
          continue
        }
        if (ch === '"') {
          this.inString = !this.inString
          continue
        }
        if (this.inString) continue

        if (ch === '{') {
          this.depth++
        } else if (ch === '}') {
          this.depth--
          if (this.depth === 0) {
            try {
              emitted.push(JSON.parse(this.planBuf))
            } catch {
              // Ignore partial / malformed plan; final validation will catch issues.
            }
            this.state = 'in_array'
            this.planBuf = ''
          }
        }
      }
    }

    return emitted
  }
}

function createUserScopedSupabaseClient(accessToken: string) {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('尚未設定 Supabase server-side 環境變數。')
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
    },
  }) as unknown as PointsSupabaseClient
}

async function getAvailablePoints(
  supabase: PointsSupabaseClient,
): Promise<number> {
  const { error: initializeError } = await supabase.rpc('initialize_user_profile')

  if (initializeError) {
    throw new Error('無法初始化使用者點數資料，請稍後再試。')
  }

  const { data, error } = await supabase.rpc('get_my_points_balance')

  if (error || typeof data !== 'number') {
    throw new Error('無法讀取點數餘額，請稍後再試。')
  }

  return data
}

async function consumeAnalysisPoints(supabase: PointsSupabaseClient) {
  const { error } = await supabase.rpc('consume_points_for_analysis', {
    cost: ANALYSIS_COST,
    reason: 'AI 行程分析',
  })

  if (error) {
    if (error.message.includes('Insufficient points')) {
      throw new Error('點數不足，請先到點數管理確認餘額。')
    }

    throw new Error('行程已產生，但扣點流程失敗，請稍後再試。')
  }
}

function getBearerToken(value?: string) {
  if (!value?.startsWith('Bearer ')) {
    return ''
  }

  return value.slice('Bearer '.length).trim()
}

function parseRequestBody(body: unknown): GenerateTripPlansRequest | null {
  if (!isRecord(body) || !isRecord(body.input)) {
    return null
  }

  return body as GenerateTripPlansRequest
}

async function buildOpenAiErrorMessage(response: Response) {
  const detail = await readOpenAiErrorDetail(response)

  if (response.status === 401) {
    return 'OpenAI API key 無法通過驗證，請確認 Vercel 的 OPENAI_API_KEY。'
  }

  if (response.status === 429) {
    return detail
      ? `OpenAI 額度或請求量暫時受限：${detail}`
      : 'OpenAI 額度或請求量暫時受限，請確認帳戶額度或稍後再試。'
  }

  return detail
    ? `OpenAI API 呼叫失敗：${detail}`
    : 'OpenAI API 呼叫失敗，請稍後再試。'
}

async function readOpenAiErrorDetail(response: Response) {
  try {
    const data = (await response.json()) as OpenAiErrorResponse

    return data.error?.message ?? ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type OpenAiErrorResponse = {
  error?: {
    message?: string
  }
}
