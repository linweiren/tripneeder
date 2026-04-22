/// <reference types="node" />

import { createClient } from '@supabase/supabase-js'
import {
  buildTripDetailsPrompt,
  parseTripPlanDetailsResponse,
} from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanDetailsResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type { TripInput, TripPlan } from '../src/types/trip.js'
import {
  validateStopsWithPlaces,
  getNearbyPlaceCandidates,
  formatNearbyRecommendations,
} from './_lib/google-places.js'
import { repairTransportSegments } from './_lib/google-routes.js'

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

const SYSTEM_DEFAULT_PERSONA = {
  companion: '情侶 / 約會',
  budget: '一般',
  stamina: '普通',
  diet: '無',
}

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
    const supabase = createUserScopedSupabaseClient(accessToken)
    const userId = getUserIdFromToken(accessToken)
    const persona = await getMergedPersona(supabase, userId, request.input)

    // 獲取室內地點候選，供雨天備案使用
    const indoorInput = {
      ...request.input,
      tags: [...request.input.tags, 'indoor_first' as const],
    }
    const nearbyIndoorCandidates = await getNearbyPlaceCandidates({
      input: indoorInput,
      persona,
    })
    const nearbyIndoorPlaces = formatNearbyRecommendations(nearbyIndoorCandidates)

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
                text: buildTripDetailsPrompt(
                  request.input,
                  request.plan,
                  persona,
                  nearbyIndoorPlaces,
                ),
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

    const detailedPlan = parseTripPlanDetailsResponse(text, request.plan)

    // 9D: 將第一階段已經驗證過的 placeId 補回第二階段
    // 這樣可以確保詳情頁依然保有精準的地圖連結
    detailedPlan.stops = detailedPlan.stops.map((stop) => {
      const originalStop = request.plan.stops.find((s) => s.id === stop.id)
      if (originalStop?.placeId) {
        return {
          ...stop,
          placeId: originalStop.placeId,
          googleMapsUrl: originalStop.googleMapsUrl,
          lat: originalStop.lat,
          lng: originalStop.lng,
          // 如果 AI 補完細節後名稱或地址變空泛了，可以用回第一階段 Google 驗證過的正式名稱
          name: originalStop.name,
          address: originalStop.address,
        }
      }
      return stop
    })

    // 同時對其餘景點（包含雨天備案）進行一次性的 Places 驗證
    const bias = request.input.location.lat && request.input.location.lng
      ? { lat: request.input.location.lat, lng: request.input.location.lng }
      : undefined
    const { validatedPlan } = await validateStopsWithPlaces(detailedPlan, bias)
    const stablePlan = preserveMainStopIdentity(validatedPlan, request.plan)
    const routedPlan = await repairDetailedPlanRoutes(stablePlan)

    res.status(200).json({
      plan: routedPlan,
    })
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : '細節補充失敗，請稍後再試。',
    })
  }
}

async function repairDetailedPlanRoutes(plan: TripPlan): Promise<TripPlan> {
  const [mainRoutes, rainRoutes] = await Promise.all([
    repairTransportSegments(plan.transportSegments || [], plan.stops || [], plan.transportMode),
    repairTransportSegments(
      plan.rainTransportSegments || [],
      plan.rainBackup || [],
      plan.transportMode,
    ),
  ])

  return {
    ...plan,
    totalTime:
      (plan.stops || []).reduce((total, stop) => total + stop.duration, 0) +
      mainRoutes.segments.reduce((total, segment) => total + segment.duration, 0),
    transportSegments: mainRoutes.segments,
    rainTransportSegments: rainRoutes.segments,
  }
}

function preserveMainStopIdentity(plan: TripPlan, originalPlan: TripPlan): TripPlan {
  return {
    ...plan,
    stops: plan.stops.map((stop) => {
      const originalStop = originalPlan.stops.find((candidate) => candidate.id === stop.id)

      if (!originalStop?.placeId) {
        return stop
      }

      return {
        ...stop,
        name: originalStop.name,
        address: originalStop.address,
        placeId: originalStop.placeId,
        googleMapsUrl: originalStop.googleMapsUrl,
        lat: originalStop.lat,
        lng: originalStop.lng,
      }
    }),
    // 確保 rainBackup 與其餘欄位也被包含
    rainBackup: plan.rainBackup || [],
    rainTransportSegments: plan.rainTransportSegments || [],
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

function getUserIdFromToken(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64').toString(),
    )
    return payload.sub
  } catch {
    return undefined
  }
}

type DbPersona = {
  persona_companion: string | null
  persona_budget: string | null
  persona_stamina: string | null
  persona_diet: string | null
  persona_transport_mode: TripPlan['transportMode'] | null
  persona_people: number | null
}

async function getMergedPersona(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string | undefined,
  input: TripInput,
) {
  let dbPersona: Partial<DbPersona> = {}

  if (userId) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('persona_companion, persona_budget, persona_stamina, persona_diet, persona_transport_mode, persona_people')
        .eq('id', userId)
        .single()
      if (data) {
        dbPersona = data
      }
    } catch {
      // Ignore DB errors
    }
  }

  const budgetLabels: Record<string, string> = {
    budget: '小資',
    standard: '一般',
    premium: '輕奢',
    luxury: '豪華',
  }

  const companionLabels: Record<string, string> = {
    date: '情侶 / 約會',
    relax: '放鬆',
    explore: '探索',
    food: '美食',
    outdoor: '戶外',
    indoor: '室內',
    solo: '獨旅',
    other: '其他',
  }

  return {
    companion:
      (input.category ? companionLabels[input.category] : undefined) ||
      dbPersona.persona_companion ||
      SYSTEM_DEFAULT_PERSONA.companion,
    budget:
      (input.budget ? budgetLabels[input.budget] : undefined) ||
      dbPersona.persona_budget ||
      SYSTEM_DEFAULT_PERSONA.budget,
    stamina: dbPersona.persona_stamina || SYSTEM_DEFAULT_PERSONA.stamina,
    diet: dbPersona.persona_diet || SYSTEM_DEFAULT_PERSONA.diet,
    transportMode: input.transportMode || dbPersona.persona_transport_mode || undefined,
    people: input.people || dbPersona.persona_people || 2,
  }
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
