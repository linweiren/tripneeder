/// <reference types="node" />

import https from 'node:https'
import { buildTripPrompt, buildRetryTripSkeletonPrompt, parseTripPlanSkeletonResponse } from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanSkeletonResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type { GenerateTripPlansRequest } from '../src/services/ai/types.js'
import { createClient } from '@supabase/supabase-js'
import {
  validateStopsWithPlaces,
  getNearbyPlaceCandidates,
  resolveLocation,
  formatNearbyRecommendations,
  type PlacesValidationResult,
  type NearbyPlaceCandidates,
  type VerifiedPlaceCandidate,
} from './_lib/google-places.js'
import { repairTransportSegments } from './_lib/google-routes.js'
import type { Stop, TripPlan } from '../src/types/trip.js'

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

type DbPersona = {
  persona_companion: string | null
  persona_budget: string | null
  persona_stamina: string | null
  persona_diet: string | null
  persona_transport_mode: TripPlan['transportMode'] | null
  persona_people: number | null
}

type PointsSupabaseClient = {
  rpc: <T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
  ) => RpcResult<T>
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        single: () => Promise<{ data: DbPersona | null; error: { message: string } | null }>
      }
    }
  }
}

const SYSTEM_DEFAULT_PERSONA = {
  companion: '情侶 / 約會',
  budget: '一般',
  stamina: '普通',
  diet: '無',
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

  let supabase: any
  let userId: string | undefined
  try {
    supabase = createUserScopedSupabaseClient(accessToken)
    userId = getUserIdFromToken(accessToken)
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
      // 解析失敗不阻斷，但給予 AI 警告，讓它知道要靠自己知識規劃
      locationWarning = `警告：系統無法精確定位起點「${request.input.location.name}」的經緯度。請 AI 依據您的知識庫判斷該地點大約位置，並圍繞該處規劃。若下方「起點附近的真實地點參考」為空，請自由發揮，不受「只能從清單挑選」的限制。`
    }
  }

  // 獲取並合併人設
  const persona = await getMergedPersona(supabase, userId, request.input)

  // 9D-7: 智慧前置搜尋 (Search-Inject)
  const nearbyPlaceCandidates = await getNearbyPlaceCandidates({
    ...request,
    persona,
  })
  const nearbyPlaces = formatNearbyRecommendations(nearbyPlaceCandidates)

  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('X-Accel-Buffering', 'no')

  const writeEvent = (event: Record<string, unknown>) => {
    res.write(`${JSON.stringify(event)}\n`)
  }

  try {
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        messages: [
          {
            role: 'user',
            content: buildPromptWithGroundingRules(
              buildTripPrompt(request.input, persona, nearbyPlaces, locationWarning),
              Boolean(nearbyPlaces),
            ),
          },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trip_plan_response',
            schema: tripPlanSkeletonResponseSchema,
            strict: true,
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
    const validatedPlans: TripPlan[] = []
    const invalidPlanIds: string[] = []
    const validationSummaries = new Map<string, string[]>()
    let placesValidationPerformed = true
    let routesApiFailed = false

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
          const bias = request.input.location.lat && request.input.location.lng
            ? { lat: request.input.location.lat, lng: request.input.location.lng }
            : undefined

          const groundedPlan = applyCandidateGroundingToPlan(
            plan as TripPlan,
            nearbyPlaceCandidates,
          )
          const validation = await validateStopsWithPlaces(groundedPlan, bias)
          if (!validation.validationPerformed) {
            placesValidationPerformed = false
          }
          const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
          const qualityIssues = getPlanQualityIssues(
            validatedPlan,
            request.input,
            validation.issues,
          )
          
          if (qualityIssues.length > 0) {
            if (!invalidPlanIds.includes(validatedPlan.id)) {
              invalidPlanIds.push(validatedPlan.id)
            }
            validationSummaries.set(validatedPlan.id, qualityIssues)
          }

          upsertValidatedPlan(validatedPlans, validatedPlan)
          writeEvent({ event: 'plan', plan: validatedPlan })
        }
      }
    }

    if (sseBuffer.trim()) {
      const delta = extractDeltaFromSseEvent(sseBuffer)
      if (delta) {
        fullText += delta
        const plans = extractor.push(delta)

        for (const plan of plans) {
          const bias = request.input.location.lat && request.input.location.lng
            ? { lat: request.input.location.lat, lng: request.input.location.lng }
            : undefined

          const groundedPlan = applyCandidateGroundingToPlan(
            plan as TripPlan,
            nearbyPlaceCandidates,
          )
          const validation = await validateStopsWithPlaces(groundedPlan, bias)
          if (!validation.validationPerformed) {
            placesValidationPerformed = false
          }
          const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
          const qualityIssues = getPlanQualityIssues(
            validatedPlan,
            request.input,
            validation.issues,
          )

          if (qualityIssues.length > 0) {
            if (!invalidPlanIds.includes(validatedPlan.id)) {
              invalidPlanIds.push(validatedPlan.id)
            }
            validationSummaries.set(validatedPlan.id, qualityIssues)
          }

          upsertValidatedPlan(validatedPlans, validatedPlan)
          writeEvent({ event: 'plan', plan: validatedPlan })
        }
      }
    }

    let finalResponse: any
    try {
      try {
        finalResponse = parseTripPlanSkeletonResponse(fullText)
      } catch (parseError) {
        if (validatedPlans.length > 0) {
          finalResponse = {
            plans: validatedPlans,
            warnings: ['部分方案產生不完整，已為您呈現已完成的行程。']
          }
        } else {
          throw parseError
        }
      }

      if (!finalResponse || !Array.isArray(finalResponse.plans)) {
        finalResponse = { plans: validatedPlans || [], warnings: [] }
      }

      for (const plan of finalResponse.plans) {
        const bias = request.input.location.lat && request.input.location.lng
          ? { lat: request.input.location.lat, lng: request.input.location.lng }
          : undefined
        const groundedPlan = applyCandidateGroundingToPlan(
          plan as TripPlan,
          nearbyPlaceCandidates,
        )
        const validation = await validateStopsWithPlaces(groundedPlan, bias)
        if (!validation.validationPerformed) {
          placesValidationPerformed = false
        }
        const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
        const qualityIssues = getPlanQualityIssues(
          validatedPlan,
          request.input,
          validation.issues,
        )
        upsertValidatedPlan(validatedPlans, validatedPlan)

        if (qualityIssues.length > 0) {
          if (!invalidPlanIds.includes(validatedPlan.id)) {
            invalidPlanIds.push(validatedPlan.id)
          }
          validationSummaries.set(validatedPlan.id, qualityIssues)
        } else {
          validationSummaries.delete(validatedPlan.id)
        }
      }

      // 9D-5: 自動重試失效方案
      if (invalidPlanIds.length > 0) {
        const retriedPlanIds = new Set<string>()
        try {
          const retryPrompt = buildRetryTripSkeletonPrompt(
            request.input,
            invalidPlanIds,
            persona,
            nearbyPlaces,
            formatRetryValidationSummaries(invalidPlanIds, validationSummaries),
          )
          const retryResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
              {
                role: 'user',
                content: buildPromptWithGroundingRules(retryPrompt, Boolean(nearbyPlaces)),
              },
            ],
            temperature: 0.2,
            response_format: {
              type: 'json_schema',
              json_schema: {
                  name: 'trip_plan_skeleton_response',
                  strict: true,
                  schema: tripPlanSkeletonResponseSchema,
                },
              },
            }),
          })

          if (retryResponse.ok) {
            const retryData = (await retryResponse.json()) as {
              choices: Array<{ message: { content: string } }>
            }
            const retryText = retryData.choices[0].message.content
            const retryParsed = parseTripPlanSkeletonResponse(retryText)

            for (const plan of retryParsed.plans) {
              if (invalidPlanIds.includes(plan.id)) {
                const bias = request.input.location.lat && request.input.location.lng
                  ? { lat: request.input.location.lat, lng: request.input.location.lng }
                  : undefined
                const groundedPlan = applyCandidateGroundingToPlan(
                  plan as TripPlan,
                  nearbyPlaceCandidates,
                )
                const validation = await validateStopsWithPlaces(groundedPlan, bias)
                if (!validation.validationPerformed) {
                  placesValidationPerformed = false
                }
                const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
                const qualityIssues = getPlanQualityIssues(
                  validatedPlan,
                  request.input,
                  validation.issues,
                )
                retriedPlanIds.add(plan.id)
                upsertValidatedPlan(validatedPlans, validatedPlan)
                if (qualityIssues.length > 0) {
                  validationSummaries.set(plan.id, qualityIssues)
                } else {
                  validationSummaries.delete(plan.id)
                }
              }
            }
          } else {
            invalidPlanIds.forEach((planId) => {
              if (!validationSummaries.has(planId)) {
                validationSummaries.set(planId, ['重試請求失敗'])
              }
            })
          }
        } catch (error) {
          console.error('Retry failed:', error)
          invalidPlanIds.forEach((planId) => {
            if (!validationSummaries.has(planId)) {
              validationSummaries.set(planId, ['重試請求失敗'])
            }
          })
        }

        invalidPlanIds.forEach((planId) => {
          if (!retriedPlanIds.has(planId)) {
            if (!validationSummaries.has(planId)) {
              validationSummaries.set(planId, ['重試後仍未取得可驗收方案'])
            }
          }
        })
      }

      // 用驗證過的 plans 覆寫 finalResponse 裡的內容，確保最終結果一致
      finalResponse.plans = (finalResponse.plans || []).map((p: any) => {
        const validated = validatedPlans.find((vp) => vp.id === p.id)
        return validated || p
      })

      finalResponse.plans = await Promise.all(
        (finalResponse.plans || []).map(async (plan: any) => {
          const { plan: repaired, routesFailed } = await repairPlanForDelivery(
            plan,
            request.input,
            nearbyPlaceCandidates,
          )
          if (routesFailed) routesApiFailed = true
          return repaired
        }),
      )

      if (!finalResponse.warnings) finalResponse.warnings = []
      if (!placesValidationPerformed) {
        finalResponse.warnings.push('Google Places 驗證未啟用，部分地點資訊可能不夠準確。')
      }
      if (routesApiFailed) {
        finalResponse.warnings.push('Google Routes API 未啟用，交通時間與距離為系統估算值。')
      }

      validationSummaries.clear()

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

function normalizePlanTotalTime(plan: TripPlan): TripPlan {
  return {
    ...plan,
    totalTime: getPlanActualDuration(plan),
  }
}

function upsertValidatedPlan(plans: TripPlan[], nextPlan: TripPlan) {
  const existingIndex = plans.findIndex((plan) => plan.id === nextPlan.id)

  if (existingIndex >= 0) {
    plans[existingIndex] = nextPlan
    return
  }

  plans.push(nextPlan)
}

function buildPromptWithGroundingRules(prompt: string, hasNearbyPlaces: boolean) {
  const groundingRules = hasNearbyPlaces
    ? `

Hard constraints for real places:
- Use the injected Google place candidates as the source of truth.
- Every stop must include a non-empty "name", "address", and "placeId".
- Copy "name", "address", and "placeId" exactly from one injected candidate. Do not paraphrase or invent venue names.
- When FIRST_STOP_CANDIDATES_WITHIN_2KM exists, stops[0] must come from that section.
- If a candidate list is provided but seems imperfect, still choose from that list instead of fabricating a place.
- Return JSON only. No markdown. No commentary.
`.trim()
    : ''

  return groundingRules ? `${prompt}\n\n${groundingRules}` : prompt
}

function applyCandidateGroundingToPlan(
  plan: TripPlan,
  candidates: NearbyPlaceCandidates,
): TripPlan {
  return {
    ...plan,
    stops: (plan.stops ?? []).map((stop, index) =>
      groundStopWithCandidate(stop, index, candidates),
    ),
    rainBackup: (plan.rainBackup ?? []).map((stop, index) =>
      groundStopWithCandidate(stop, index, candidates),
    ),
  }
}

function groundStopWithCandidate(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
) {
  const candidate = findMatchingCandidateForStop(stop, index, candidates)
  return candidate ? applyCandidateToStop(stop, candidate) : stop
}

async function repairPlanForDelivery(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  const usedPlaceIds = new Set<string>()
  const repairedStops = plan.stops.map((stop, index) =>
    ensureStopHasVerifiedPlace(stop, index, candidates, usedPlaceIds),
  )
  const expandedStops = expandStopsForLongTrip(repairedStops, input, candidates, usedPlaceIds)
  const { segments: repairedSegments, routesFailed } = await repairTransportSegments(
    plan.transportSegments,
    expandedStops,
    plan.transportMode,
  )
  const repairedRainBackup = (plan.rainBackup ?? []).map((stop, index) =>
    ensureStopHasVerifiedPlace(stop, index, candidates, usedPlaceIds),
  )
  const { segments: repairedRainSegments } = await repairTransportSegments(
    plan.rainTransportSegments ?? [],
    repairedRainBackup,
    plan.transportMode,
  )
  const timeRepairedPlan = stretchPlanDurationToCoverage(
    {
      ...plan,
      stops: expandedStops,
      transportSegments: repairedSegments,
      rainBackup: repairedRainBackup,
      rainTransportSegments: repairedRainSegments,
    },
    input,
  )

  return {
    plan: {
      ...timeRepairedPlan,
      totalTime: getPlanActualDuration(timeRepairedPlan),
    },
    routesFailed,
  }
}

function ensureStopHasVerifiedPlace(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
) {
  if (stop.placeId && stop.address && stop.googleMapsUrl) {
    usedPlaceIds.add(stop.placeId)
    return stop
  }

  const candidate = pickCandidateForStop(stop, index, candidates, usedPlaceIds)
  if (!candidate) return stop

  usedPlaceIds.add(candidate.placeId)
  return applyCandidateToStop(stop, candidate)
}

function pickCandidateForStop(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
) {
  const existingCandidate = findMatchingCandidateForStop(stop, index, candidates)

  if (existingCandidate && !usedPlaceIds.has(existingCandidate.placeId)) {
    return existingCandidate
  }

  const pool =
    index === 0
      ? candidates.firstStopCandidates.length > 0
        ? preferNonShortVisitCandidates(candidates.firstStopCandidates)
        : candidates.allCandidates
      : getCandidatePoolByStopType(stop, candidates)

  return (
    pool.find((candidate) => !usedPlaceIds.has(candidate.placeId)) ??
    candidates.allCandidates.find((candidate) => !usedPlaceIds.has(candidate.placeId)) ??
    pool[0] ??
    null
  )
}

function findMatchingCandidateForStop(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
) {
  const pool =
    index === 0 && candidates.firstStopCandidates.length > 0
      ? candidates.firstStopCandidates
      : candidates.allCandidates

  if (stop.placeId) {
    const placeIdMatch = pool.find((candidate) => candidate.placeId === stop.placeId)
    if (placeIdMatch) return placeIdMatch
  }

  const stopName = normalizeStopSearchText(stop.name)
  const stopAddress = normalizeStopSearchText(stop.address)

  let bestCandidate: VerifiedPlaceCandidate | null = null
  let bestScore = 0

  for (const candidate of pool) {
    const candidateName = normalizeStopSearchText(candidate.name)
    const candidateAddress = normalizeStopSearchText(candidate.address)
    const exactNameScore = stopName && stopName === candidateName ? 1 : 0
    const exactAddressScore = stopAddress && stopAddress === candidateAddress ? 0.9 : 0
    const partialNameScore =
      stopName && candidateName && (candidateName.includes(stopName) || stopName.includes(candidateName))
        ? 0.7
        : 0
    const partialAddressScore =
      stopAddress &&
      candidateAddress &&
      (candidateAddress.includes(stopAddress) || stopAddress.includes(candidateAddress))
        ? 0.55
        : 0
    const score = Math.max(exactNameScore, exactAddressScore, partialNameScore, partialAddressScore)

    if (score > bestScore) {
      bestCandidate = candidate
      bestScore = score
    }
  }

  return bestScore >= 0.7 ? bestCandidate : null
}

function normalizeStopSearchText(value?: string) {
  return (value ?? '')
    .toLocaleLowerCase('zh-TW')
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    .trim()
}

function preferNonShortVisitCandidates(candidates: VerifiedPlaceCandidate[]) {
  const nonShortVisitCandidates = candidates.filter(
    (candidate) => !isShortVisitCandidate(candidate),
  )

  return nonShortVisitCandidates.length > 0 ? nonShortVisitCandidates : candidates
}

function getCandidatePoolByStopType(stop: Stop, candidates: NearbyPlaceCandidates) {
  const basePool =
    candidates.otherCandidates.length > 0 ? candidates.otherCandidates : candidates.allCandidates
  const typedPool = basePool.filter((candidate) => {
    const types = candidate.types ?? []
    const isShortVisit = isShortVisitCandidate(candidate)

    if (stop.type === 'food') {
      return types.some((type) =>
        ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food'].includes(type),
      )
    }

    return (
      !isShortVisit &&
      !types.some((type) =>
        ['restaurant', 'cafe', 'bakery', 'meal_takeaway'].includes(type),
      )
    )
  })

  return typedPool.length > 0 ? typedPool : basePool
}

function isShortVisitCandidate(candidate: VerifiedPlaceCandidate) {
  const text = `${candidate.name} ${candidate.address}`.toLocaleLowerCase('zh-TW')
  return /(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)
}

function applyCandidateToStop(stop: Stop, candidate: VerifiedPlaceCandidate): Stop {
  return {
    ...stop,
    name: candidate.name,
    address: candidate.address,
    placeId: candidate.placeId,
    googleMapsUrl: candidate.googleMapsUrl,
    lat: candidate.lat,
    lng: candidate.lng,
  }
}

function expandStopsForLongTrip(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
) {
  const allowedMinutes = getAllowedTripMinutes(input)
  if (!allowedMinutes) return stops

  const minimumMinutes = Math.ceil(allowedMinutes * getRequiredCoverageRatio(allowedMinutes))
  const expandedStops = [...stops]
  const candidatePool = preferNonShortVisitCandidates(
    candidates.otherCandidates.length > 0 ? candidates.otherCandidates : candidates.allCandidates,
  )

  while (
    getMaxPossibleStopDuration(expandedStops) + estimateTransportTotal(expandedStops) <
    minimumMinutes
  ) {
    const nextCandidate = candidatePool.find(
      (candidate) => !usedPlaceIds.has(candidate.placeId) && !isShortVisitCandidate(candidate),
    )
    if (!nextCandidate) break

    usedPlaceIds.add(nextCandidate.placeId)
    const insertionIndex = Math.max(expandedStops.length - 1, 1)
    expandedStops.splice(
      insertionIndex,
      0,
      applyCandidateToStop(
        {
          id: buildSupplementalStopId(input, expandedStops.length + 1),
          name: nextCandidate.name,
          type: inferStopTypeFromCandidate(nextCandidate),
          description: '',
          address: nextCandidate.address,
          duration: getDefaultStopDuration(inferStopTypeFromCandidate(nextCandidate)),
        },
        nextCandidate,
      ),
    )
  }

  return expandedStops
}

function getMaxPossibleStopDuration(stops: Stop[]) {
  return stops.reduce((total, stop) => total + getMaximumStopDuration(stop), 0)
}

function estimateTransportTotal(stops: Stop[]) {
  return Math.max(stops.length - 1, 0) * 18
}

function buildSupplementalStopId(input: GenerateTripPlansRequest['input'], index: number) {
  const prefix = input.category === 'other' ? 'main' : input.category
  return `supplemental-${prefix}-${index}`
}

function inferStopTypeFromCandidate(candidate: VerifiedPlaceCandidate): Stop['type'] {
  const types = candidate.types ?? []
  if (types.some((type) => ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food'].includes(type))) {
    return 'food'
  }

  return 'main_activity'
}

function getDefaultStopDuration(type: Stop['type']) {
  if (type === 'food') return 60
  if (type === 'ending_or_transition') return 45

  return 75
}

function stretchPlanDurationToCoverage(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const allowedMinutes = getAllowedTripMinutes(input)
  if (!allowedMinutes || plan.stops.length === 0) return normalizePlanTotalTime(plan)

  const minimumMinutes = Math.ceil(allowedMinutes * getRequiredCoverageRatio(allowedMinutes))
  const currentMinutes = getPlanActualDuration(plan)
  const extraMinutes = minimumMinutes - currentMinutes

  if (extraMinutes <= 0) return normalizePlanTotalTime(plan)

  const durations = plan.stops.map((stop) =>
    clamp(stop.duration, getMinimumStopDuration(stop), getMaximumStopDuration(stop)),
  )
  let remainingExtra =
    minimumMinutes -
    (durations.reduce((total, duration) => total + duration, 0) +
      plan.transportSegments.reduce((total, segment) => total + segment.duration, 0))
  const weights = plan.stops.map(getStopStretchWeight)

  while (remainingExtra > 0) {
    const candidates = plan.stops
      .map((stop, index) => ({
        index,
        room: getMaximumStopDuration(stop) - durations[index],
        weight: weights[index],
      }))
      .filter((candidate) => candidate.room > 0 && candidate.weight > 0)
      .sort((left, right) => right.weight - left.weight || right.room - left.room)

    if (candidates.length === 0) break

    for (const candidate of candidates) {
      if (remainingExtra <= 0) break
      const addMinutes = Math.min(candidate.room, Math.max(5, candidate.weight * 5), remainingExtra)
      durations[candidate.index] += addMinutes
      remainingExtra -= addMinutes
    }
  }

  return normalizePlanTotalTime({
    ...plan,
    stops: plan.stops.map((stop, index) => ({
      ...stop,
      duration: durations[index],
    })),
  })
}

function getMinimumStopDuration(stop: Stop) {
  if (stop.type === 'food') return 45

  return 30
}

function getMaximumStopDuration(stop: Stop) {
  const text = `${stop.name} ${stop.address}`.toLocaleLowerCase('zh-TW')

  if (stop.type === 'food') return 90
  if (/(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)) {
    return 45
  }
  if (/(市場|商圈|老街|夜市|百貨|購物|mall|outlet)/i.test(text)) return 150
  if (/(博物館|美術館|展覽|園區|文化|文創|藝術|science|museum)/i.test(text)) return 150
  if (/(公園|步道|海邊|湖|山|森林|河濱|草地|park)/i.test(text)) return 120
  if (/(咖啡|書店|茶|甜點|cafe|coffee)/i.test(text)) return 100

  return 90
}

function getStopStretchWeight(stop: Stop) {
  const maxDuration = getMaximumStopDuration(stop)

  if (maxDuration <= 45) return 0
  if (stop.type === 'food') return 1
  if (maxDuration >= 150) return 4
  if (maxDuration >= 120) return 3

  return 2
}

function getPlanQualityIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  placesIssues: PlacesValidationResult['issues'],
) {
  const issues = placesIssues.map((issue) => formatPlacesValidationReason(issue.reason))
  const allowedMinutes = getAllowedTripMinutes(input)

  if (allowedMinutes) {
    const actualMinutes = getPlanActualDuration(plan)
    const minimumMinutes = Math.ceil(allowedMinutes * getRequiredCoverageRatio(allowedMinutes))

    if (actualMinutes < minimumMinutes) {
      issues.push(
        `行程時長不足（目前 ${actualMinutes} 分鐘，至少需要 ${minimumMinutes} 分鐘）`,
      )
    }
  }

  return Array.from(new Set(issues))
}

function formatRetryValidationSummaries(
  invalidPlanIds: string[],
  validationSummaries: Map<string, string[]>,
) {
  return invalidPlanIds.map((planId) => {
    const summary = validationSummaries.get(planId)?.join('、') || '未通過品質檢查'
    return `${getPlanLabel(planId)}：${summary}`
  })
}

function getPlanActualDuration(plan: TripPlan) {
  return (
    plan.stops.reduce((total, stop) => total + stop.duration, 0) +
    plan.transportSegments.reduce((total, segment) => total + segment.duration, 0)
  )
}

function getAllowedTripMinutes(input: GenerateTripPlansRequest['input']) {
  const start = parseTimeToMinutes(input.startTime)
  const end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null

  return end >= start ? end - start : end + 24 * 60 - start
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function getPlanLabel(planId: string) {
  const planLabelMap: Record<string, string> = {
    safe: '保守型方案',
    balanced: '平衡型方案',
    explore: '探索型方案',
  }

  return planLabelMap[planId] ?? `方案 ${planId}`
}

function formatPlacesValidationReason(reason: string) {
  const labelMap: Record<string, string> = {
    not_found: '查無此地',
    low_similarity: '搜尋結果相似度不足',
    generic_name: '地點名稱過於空泛',
    first_stop_too_far: '第一站距離起點超過 2 公里',
    closed: '地點疑似停業',
    maps_uri_missing: 'Google Maps 官方連結缺失',
  }

  return labelMap[reason] ?? reason
}

function extractDeltaFromSseEvent(rawEvent: string): string {
  const lines = rawEvent.split('\n')
  const payloads: string[] = []

  for (const line of lines) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trimStart()
      if (payload) {
        payloads.push(payload)
      }
    }
  }

  let text = ''

  for (const dataPayload of payloads) {
    if (!dataPayload || dataPayload === '[DONE]') {
      continue
    }

    try {
      const parsed = JSON.parse(dataPayload) as {
        choices?: Array<{
          delta?: {
            content?:
              | string
              | Array<{
                  type?: string
                  text?: string
                }>
          }
          message?: {
            content?: string
          }
        }>
      }

      const choice = parsed.choices?.[0]
      const delta = choice?.delta?.content

      if (typeof delta === 'string') {
        text += delta
        continue
      }

      if (Array.isArray(delta)) {
        text += delta
          .map((part) => (part?.type === 'text' || typeof part?.text === 'string' ? part.text ?? '' : ''))
          .join('')
        continue
      }

      if (typeof choice?.message?.content === 'string') {
        text += choice.message.content
      }
    } catch {
      // Ignore unparseable SSE frames.
    }
  }

  return text
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
        const plansMatch = this.preBuf.match(/"plans"\s*:\s*\[/)
        if (plansMatch) {
          this.state = 'in_array'
          this.preBuf = ''
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

function createUserScopedSupabaseClient(accessToken: string): any {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const supabaseServerKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''

  if (!supabaseUrl || !supabaseServerKey) {
    console.error('Missing Supabase environment variables:', {
      url: !!supabaseUrl,
      key: !!supabaseServerKey,
    })
    throw new Error('伺服器設定不完整 (Supabase 設定缺失)，請聯絡管理員。')
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

async function getAvailablePoints(
  supabase: any,
): Promise<number> {
  // Try to initialize, ignore if already exists (though RPC handles conflict)
  const { error: initializeError } = await supabase.rpc('initialize_user_profile')

  if (initializeError) {
    console.error('RPC initialize_user_profile failed:', initializeError)
    if (isFetchFailedError(initializeError)) {
      throw new Error('無法連線到點數服務，剛剛可能是網路中斷或 Supabase 暫時無回應，請再試一次。')
    }
    throw new Error(`無法初始化使用者點數資料: ${initializeError.message}`)
  }

  const { data, error } = await supabase.rpc('get_my_points_balance')

  if (error || typeof data !== 'number') {
    console.error('RPC get_my_points_balance failed:', error)
    if (isFetchFailedError(error)) {
      throw new Error('無法連線到點數服務，剛剛可能是網路中斷或 Supabase 暫時無回應，請再試一次。')
    }
    throw new Error(`無法讀取點數餘額: ${error?.message || '未知錯誤'}`)
  }

  return data
}

function isFetchFailedError(error: { message?: string } | null | undefined) {
  return typeof error?.message === 'string' && /fetch failed/i.test(error.message)
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

async function getMergedPersona(
  supabase: PointsSupabaseClient,
  userId: string | undefined,
  input: GenerateTripPlansRequest['input'],
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
      // Ignore DB errors, fallback to defaults
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type OpenAiErrorResponse = {
  error?: {
    message?: string
  }
}
