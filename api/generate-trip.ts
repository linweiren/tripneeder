/// <reference types="node" />

import { buildTripPrompt, parseTripPlanResponse } from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type { GenerateTripPlansRequest } from '../src/services/ai/types.js'
import { createClient } from '@supabase/supabase-js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: {
    authorization?: string
  }
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
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

  try {
    const supabase = createUserScopedSupabaseClient(accessToken)
    const balance = await getAvailablePoints(supabase)

    if (balance < ANALYSIS_COST) {
      res.status(402).json({
        error: `點數不足。每次分析需要 ${ANALYSIS_COST} 點，目前剩餘 ${balance} 點。`,
      })
      return
    }

    const text = await requestTripPlans(apiKey, request)
    const data = parseTripPlanResponse(text)
    await consumeAnalysisPoints(supabase)

    res.status(200).json(data)
  } catch (error) {
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : 'AI 分析失敗，請稍後再試。',
    })
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

async function requestTripPlans(
  apiKey: string,
  request: GenerateTripPlansRequest,
) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
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
          schema: tripPlanResponseSchema,
          strict: false,
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(await buildOpenAiErrorMessage(response))
  }

  const data = (await response.json()) as OpenAiResponse
  const text = extractOpenAiText(data)

  if (!text) {
    throw new Error('OpenAI 沒有回傳可解析的內容，請重新分析。')
  }

  return text
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

function extractOpenAiText(data: OpenAiResponse) {
  if (typeof data.output_text === 'string') {
    return data.output_text
  }

  for (const output of data.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text
      }
    }
  }

  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type OpenAiResponse = {
  output_text?: string
  output?: Array<{
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
}

type OpenAiErrorResponse = {
  error?: {
    message?: string
  }
}
