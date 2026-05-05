/// <reference types="node" />

import https from 'node:https'
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
  resolveLocation,
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
const DETAIL_PERFORMANCE_LOG_EVENT = '[detail-performance]'

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
    const logPhase = createDetailPhaseTimer(request.plan.id)
    const supabase = createUserScopedSupabaseClient(accessToken)
    const userId = getUserIdFromToken(accessToken)

    // 若缺乏座標但有地名（手動輸入起點），先進行解析以補齊座標，否則搜尋會缺乏地理偏好
    let locationWarning = ''
    if (
      (!request.input.location.lat || !request.input.location.lng) &&
      request.input.location.name
    ) {
      const resolved = await resolveLocation(request.input.location.name)
      if (resolved) {
        request.input.location = {
          ...request.input.location,
          lat: resolved.lat,
          lng: resolved.lng,
          name: resolved.formattedName,
        }
      } else {
        // 解析失敗不阻斷，但給予 AI 警告
        locationWarning = `警告：系統無法精確定位起點「${request.input.location.name}」的經緯度。請 AI 依據您的知識庫為該處補齊雨天備案與詳情。`
      }
    }
    logPhase('location-ready')

    const persona = await getMergedPersona(supabase, userId, request.input)
    logPhase('persona-ready')

    const includeRainBackup = shouldRequestRainBackup(request.input)
    let nearbyIndoorPlaces = ''
    let nearbyIndoorCandidateCount = 0

    if (includeRainBackup) {
      // 獲取室內地點候選，供雨天備案使用
      const indoorInput = {
        ...request.input,
        tags: [...request.input.tags, 'indoor_first' as const],
      }
      const nearbyIndoorCandidates = await getNearbyPlaceCandidates({
        input: indoorInput,
        persona,
      })
      nearbyIndoorPlaces = formatNearbyRecommendations(nearbyIndoorCandidates)
      nearbyIndoorCandidateCount = nearbyIndoorCandidates.allCandidates.length
    }

    logPhase('indoor-candidates-ready', {
      candidateCount: nearbyIndoorCandidateCount,
      includeRainBackup,
    })

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
                  locationWarning,
                  { includeRainBackup },
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
    logPhase('openai-complete', {
      responseChars: text?.length ?? 0,
    })

    if (!text) {
      res.status(502).json({ error: '細節補充失敗，請稍後再試。' })
      return
    }

    const detailedPlan = parseTripPlanDetailsResponse(text, request.plan)
    logPhase('parse-complete', {
      stopCount: detailedPlan.stops.length,
      rainStopCount: detailedPlan.rainBackup?.length ?? 0,
    })

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
    const stableDetailedPlan = preserveMainStopIdentity(detailedPlan, request.plan)
    const stablePlan = await validateRainBackupWithPlaces(stableDetailedPlan, bias, request.input)
    logPhase('rain-places-validation-complete', {
      rainStopCount: stablePlan.rainBackup?.length ?? 0,
    })
    const routedPlan = await repairDetailedPlanRoutes(stablePlan, request.input)
    logPhase('routes-complete', {
      mainSegments: routedPlan.transportSegments.length,
      rainSegments: routedPlan.rainTransportSegments.length,
    })

    res.status(200).json({
      plan: routedPlan,
    })
    logPhase('done')
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : '細節補充失敗，請稍後再試。',
    })
  }
}

function createDetailPhaseTimer(planId: string) {
  const startedAt = Date.now()
  let previousAt = startedAt

  return (phase: string, details: Record<string, unknown> = {}) => {
    const now = Date.now()
    console.info(DETAIL_PERFORMANCE_LOG_EVENT, {
      planId,
      phase,
      phaseMs: now - previousAt,
      elapsedMs: now - startedAt,
      ...details,
    })
    previousAt = now
  }
}

async function validateRainBackupWithPlaces(
  plan: TripPlan,
  bias: { lat: number; lng: number } | undefined,
  input: TripInput,
): Promise<TripPlan> {
  const rainBackup = plan.rainBackup ?? []

  if (rainBackup.length === 0) {
    return {
      ...plan,
      rainBackup: [],
      rainTransportSegments: [],
    }
  }

  const validationPlan: TripPlan = {
    ...plan,
    stops: [],
    transportSegments: [],
    rainBackup,
    rainTransportSegments: plan.rainTransportSegments ?? [],
  }
  const validation = await validateStopsWithPlaces(validationPlan, bias, input)
  const invalidRainBackupStopIds = new Set(
    validation.issues
      .map((issue) => issue.stopId)
      .filter((stopId) => validation.validatedPlan.rainBackup?.some((stop) => stop.id === stopId)),
  )
  const validRainBackup = (validation.validatedPlan.rainBackup ?? []).filter(
    (stop) => !invalidRainBackupStopIds.has(stop.id),
  )
  const dedupedRainBackup = dedupeRainBackupStops(validRainBackup)
  const rainBackupChanged = dedupedRainBackup.length !== validRainBackup.length

  if (rainBackupChanged) {
    console.warn('[rain-backup-deduped]', {
      planId: plan.id,
      before: validRainBackup.map((stop) => stop.name),
      after: dedupedRainBackup.map((stop) => stop.name),
    })
  }

  return {
    ...plan,
    rainBackup: dedupedRainBackup,
    rainTransportSegments: rainBackupChanged
      ? []
      : (validation.validatedPlan.rainTransportSegments ?? []).filter(
          (segment) =>
            !invalidRainBackupStopIds.has(segment.fromStopId) &&
            !invalidRainBackupStopIds.has(segment.toStopId),
        ),
  }
}

function dedupeRainBackupStops(stops: TripPlan['stops']) {
  const seenKeys = new Set<string>()

  return stops.filter((stop) => {
    const key = getRainBackupStopKey(stop)
    if (seenKeys.has(key)) return false

    seenKeys.add(key)
    return true
  })
}

function getRainBackupStopKey(stop: TripPlan['stops'][number]) {
  return (
    stop.placeId?.trim() ||
    `${normalizeRainBackupText(stop.name)}|${normalizeRainBackupText(stop.address)}`
  )
}

function normalizeRainBackupText(value: string) {
  return value.trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
}

async function repairDetailedPlanRoutes(plan: TripPlan, input: TripInput): Promise<TripPlan> {
  const shouldRepairMainRoutes = !hasCompleteTransportSegments(
    plan.transportSegments || [],
    plan.stops || [],
  )
  const shouldRepairRainRoutes = (plan.rainBackup?.length ?? 0) >= 2

  if (shouldRepairMainRoutes) {
    console.warn('[detail-main-route-repair]', {
      planId: plan.id,
      segmentCount: plan.transportSegments?.length ?? 0,
      stopCount: plan.stops?.length ?? 0,
    })
  }

  const [mainRoutes, rainRoutes] = await Promise.all([
    shouldRepairMainRoutes
      ? repairTransportSegments(plan.transportSegments || [], plan.stops || [], plan.transportMode)
      : Promise.resolve({
          segments: plan.transportSegments || [],
          routesFailed: false,
        }),
    shouldRepairRainRoutes
      ? repairTransportSegments(
          plan.rainTransportSegments || [],
          plan.rainBackup || [],
          plan.transportMode,
        )
      : Promise.resolve({
          segments: [],
          routesFailed: false,
        }),
  ])

  const routedPlan = {
    ...plan,
    totalTime:
      (plan.stops || []).reduce((total, stop) => total + stop.duration, 0) +
      mainRoutes.segments.reduce((total, segment) => total + segment.duration, 0),
    transportSegments: mainRoutes.segments,
    rainTransportSegments: rainRoutes.segments,
  }

  const rainIssues = getRainBackupQualityIssues(routedPlan, input)
  if (rainIssues.length === 0) return routedPlan

  console.warn(`[rain-backup-quality] plan=${routedPlan.id} removed`, {
    issues: rainIssues,
    stopCount: routedPlan.rainBackup?.length ?? 0,
    actualMinutes: getRainBackupActualDuration(routedPlan),
  })

  return {
    ...routedPlan,
    rainBackup: [],
    rainTransportSegments: [],
  }
}

function hasCompleteTransportSegments(
  segments: TripPlan['transportSegments'],
  stops: TripPlan['stops'],
) {
  const expectedLength = Math.max(stops.length - 1, 0)

  if (segments.length !== expectedLength) return false

  return segments.every((segment, index) => {
    const nextStop = stops[index + 1]

    return (
      segment.fromStopId === stops[index]?.id &&
      segment.toStopId === nextStop?.id &&
      Number.isFinite(segment.duration) &&
      segment.duration > 0
    )
  })
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

function getRainBackupQualityIssues(plan: TripPlan, input: TripInput) {
  const issues: string[] = []
  const stops = plan.rainBackup ?? []
  const allowedMinutes = getAllowedTripMinutes(input)
  const actualMinutes = getRainBackupActualDuration(plan)

  if (stops.length > 0 && stops.length < 2) {
    issues.push('雨天備案站點數不足')
  }

  stops.forEach((stop) => {
    const minimumDuration = stop.type === 'food' ? 45 : 35
    if (stop.duration < minimumDuration) {
      issues.push(`${stop.name} 雨天備案停留時間過短`)
    }
  })

  if (allowedMinutes && stops.length > 0) {
    const minimumMinutes = Math.ceil(allowedMinutes * getRequiredCoverageRatio(allowedMinutes))
    if (actualMinutes < minimumMinutes) {
      issues.push(`雨天備案時長不足（目前 ${actualMinutes} 分鐘，至少需要 ${minimumMinutes} 分鐘）`)
    }
    if (actualMinutes > allowedMinutes) {
      issues.push(`雨天備案超出可用時間（目前 ${actualMinutes} 分鐘，最多 ${allowedMinutes} 分鐘）`)
    }
  }

  return Array.from(new Set(issues))
}

function getRainBackupActualDuration(plan: TripPlan) {
  return (
    (plan.rainBackup ?? []).reduce((total, stop) => total + stop.duration, 0) +
    (plan.rainTransportSegments ?? []).reduce((total, segment) => total + segment.duration, 0)
  )
}

function getAllowedTripMinutes(input: TripInput) {
  const start = parseTimeToMinutes(input.startTime)
  const end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null

  return end >= start ? end - start : end + 24 * 60 - start
}

function shouldRequestRainBackup(input: TripInput) {
  const allowedMinutes = getAllowedTripMinutes(input)

  return allowedMinutes === null || allowedMinutes <= 8 * 60
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function getRequiredCoverageRatio(allowedMinutes: number) {
  if (allowedMinutes <= 4 * 60) return 0.7
  if (allowedMinutes <= 8 * 60) return 0.75
  if (allowedMinutes <= 12 * 60) return 0.8

  return 0.7
}

function createUserScopedSupabaseClient(accessToken: string) {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const supabaseServerKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''

  if (!supabaseUrl || !supabaseServerKey) {
    throw new Error('尚未設定 Supabase server-side 環境變數。')
  }

  return createClient(supabaseUrl, supabaseServerKey, {
    global: {
      fetch: createNodeHttpsFetch(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

function createNodeHttpsFetch(): typeof fetch {
  return async (input, init) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET'
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
    const body = init?.body

    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        requestUrl,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          res.on('end', () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                statusText: res.statusMessage ?? '',
                headers: new Headers(
                  Object.entries(res.headers).flatMap(([key, value]) =>
                    value === undefined
                      ? []
                      : Array.isArray(value)
                        ? [[key, value.join(', ')]]
                        : [[key, value]],
                  ),
                ),
              }),
            )
          })
        },
      )

      req.on('error', reject)

      if (init?.signal) {
        init.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('The operation was aborted.')),
          { once: true },
        )
      }

      if (typeof body === 'string' || body instanceof Uint8Array) {
        req.write(body)
      } else if (body == null) {
        // no-op
      } else {
        req.write(String(body))
      }

      req.end()
    })
  }
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
