/// <reference types="node" />

import { createClient } from '@supabase/supabase-js'
import {
  buildTripDetailsPrompt,
  parseTripPlanDetailsResponse,
} from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanDetailsResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type { TripInput, TripPlan } from '../src/types/trip.js'

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
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const request = parseRequestBody(req.body)
  const accessToken = getBearerToken(req.headers?.authorization)

  if (!request) {
    res.status(400).json({ error: '行程資料不完整，請回到結果頁重新選擇。' })
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
    createUserScopedSupabaseClient(accessToken)

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
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
                text: buildTripDetailsPrompt(request.input, request.plan),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'trip_plan_details_response',
            schema: tripPlanDetailsResponseSchema,
            strict: false,
          },
        },
      }),
      signal: req.signal,
    })

    if (!openAiResponse.ok) {
      res.status(502).json({ error: await buildOpenAiErrorMessage(openAiResponse) })
      return
    }

    const data = (await openAiResponse.json()) as OpenAiResponse
    const text = extractOutputText(data)

    if (!text) {
      res.status(502).json({ error: '細節補充失敗，請稍後再試。' })
      return
    }

    res.status(200).json({
      plan: parseTripPlanDetailsResponse(text, request.plan),
    })
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : '細節補充失敗，請稍後再試。',
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
  })
}

function parseRequestBody(body: unknown): {
  input: TripInput
  plan: TripPlan
} | null {
  if (!isRecord(body) || !isRecord(body.input) || !isRecord(body.plan)) {
    return null
  }

  return body as { input: TripInput; plan: TripPlan }
}

function getBearerToken(value?: string) {
  if (!value?.startsWith('Bearer ')) {
    return ''
  }

  return value.slice('Bearer '.length).trim()
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

function extractOutputText(response: OpenAiResponse) {
  if (typeof response.output_text === 'string') {
    return response.output_text
  }

  return response.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? '')
    .join('')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type OpenAiResponse = {
  output_text?: string
  output?: Array<{
    content?: Array<{
      text?: string
    }>
  }>
}

type OpenAiErrorResponse = {
  error?: {
    message?: string
  }
}
