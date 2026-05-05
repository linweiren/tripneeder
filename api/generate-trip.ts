/// <reference types="node" />

import https from 'node:https'
import { appendFileSync } from 'node:fs'
import { buildTripPrompt, buildRetryTripSkeletonPrompt, parseTripPlanSkeletonResponse } from '../src/services/ai/tripPlanPrompt.js'
import { tripPlanSkeletonResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type {
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  Persona,
} from '../src/services/ai/types.js'
import { createClient } from '@supabase/supabase-js'
import {
  validateStopsWithPlaces,
  validatePlanOpeningHours,
  resolveOpeningHoursTimelineStart,
  isCandidateOpenForVisit,
  getNearbyPlaceCandidates,
  resolveLocation,
  formatNearbyRecommendations,
  type OpeningHoursValidationIssue,
  type PlacesValidationResult,
  type NearbyPlaceCandidates,
  type VerifiedPlaceCandidate,
} from './_lib/google-places.js'
import { repairTransportSegments } from './_lib/google-routes.js'
import {
  PLAN_IDS,
  TIMELINE_START_GRANULARITY_MINUTES,
  POST_TIMING_ALIGNMENT_MAX_PASSES,
  MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES,
  clamp,
  formatMinutesAsTime,
  getAllowedTripMinutes,
  getCoverageBasisMinutes,
  getMealInsertionTargetMinutes,
  getMinimumRequiredActualMinutes,
  getOpeningHoursSearchStartMinutes,
  getRequiredMealWindows,
  getScheduleCapacityMinutes,
  getVisitMealWindowOverlapMinutes,
  isStopAlignedWithMealWindow,
  parseTimeToMinutes,
  tripOverlapsMealWindow,
  type PlanId,
  type RequiredMealWindow,
} from './_lib/trip-planning-rules.js'
import {
  estimateTransportTotal,
  getDefaultStopDuration,
  getMaximumStopDuration,
  getMinimumStopCountForLongTrip,
  getMinimumStopDuration,
  getPlanActualDuration,
  getReasonablePlanDuration,
  getStopStretchWeight,
} from './_lib/trip-plan-metrics.js'
import {
  findMealWindowInsertionIndex,
  getEstimatedArrivalMinutesForStop,
  getRequiredAvailabilitySlotForStop,
} from './_lib/trip-timeline.js'
import {
  getMinimumMeaningfulStopDuration,
  getPlanRhythmIssues,
  getRequiredMealCoverageIssues,
  inferStopRhythmRole,
} from './_lib/trip-quality-rules.js'
import {
  comparePlansByDisplayPriority,
  getCoverageRepairTargetMinutes,
  getPlanDisplayPriority,
  getPlanDiversityOffset,
  pickRotatedItem,
} from './_lib/trip-repair-strategy.js'
import type { Stop, TripPlan } from '../src/types/trip.js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: {
    authorization?: string
  }
  signal?: AbortSignal
}

const SUPABASE_FETCH_TIMEOUT_MS = 10000

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
const ENABLE_LOCAL_FALLBACK_REFILL = process.env.ENABLE_LOCAL_FALLBACK_REFILL === 'true'
const GENERATE_DEBUG_LOG_PATH = '.tripneeder-generate-debug.log'

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
      locationWarning = `警告：系統無法精確定位起點「${request.input.location.name}」的經緯度。若下方「起點附近的真實地點參考」為空，不可使用泛稱或不確定存在的地點硬湊方案。`
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
  if (nearbyPlaceCandidates.allCandidates.length === 0) {
    const message = '目前這個時間窗附近沒有可驗證且營業時間已知的候選地點，系統不會用 AI 自創地點硬湊方案。請調整開始時間或拉長行程後再試。'
    writeGenerateDebugLog('candidate-pool-empty-aborted', {
      startTime: request.input.startTime,
      endTime: request.input.endTime,
      location: request.input.location,
    })
    res.status(422).json({ error: message })
    return
  }
  if (
    request.input.location.lat &&
    request.input.location.lng &&
    nearbyPlaceCandidates.firstStopCandidates.length === 0
  ) {
    const message = '目前起點 2 公里內沒有可驗證且營業時間已知的第一站候選，系統不會改用遠方地點硬湊方案。請調整起點、開始時間或拉長行程後再試。'
    writeGenerateDebugLog('first-stop-candidate-empty-aborted', {
      startTime: request.input.startTime,
      endTime: request.input.endTime,
      location: request.input.location,
      candidateCount: nearbyPlaceCandidates.allCandidates.length,
    })
    res.status(422).json({ error: message })
    return
  }
  const tripPrompt = buildPromptWithGroundingRules(
    buildTripPrompt(request.input, persona, nearbyPlaces, locationWarning),
    Boolean(nearbyPlaces),
  )

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
            content: tripPrompt,
          },
        ],
        max_completion_tokens: 12000,
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
    const streamFinishReasons: string[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      sseBuffer += decoder.decode(value, { stream: true })
      const events = sseBuffer.split('\n\n')
      sseBuffer = events.pop() ?? ''

      for (const rawEvent of events) {
        const delta = extractDeltaFromSseEvent(rawEvent)
        const finishReason = extractFinishReasonFromSseEvent(rawEvent)
        if (finishReason) streamFinishReasons.push(finishReason)
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
          const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
          if (!validation.validationPerformed) {
            placesValidationPerformed = false
          }
          const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
          logPlanQualitySummary(validatedPlan, request.input, 'stream')
          const blockingIssues = getHardPlanQualityIssues(
            validatedPlan,
            request.input,
            validation.issues,
          )
          logSoftPlanQualityIssues(validatedPlan, request.input, validation.issues, 'stream')
          
          if (blockingIssues.length > 0) {
            markPlanInvalid(invalidPlanIds, validationSummaries, validatedPlan.id, blockingIssues)
          } else {
            markPlanValid(invalidPlanIds, validationSummaries, validatedPlan.id)
          }

          upsertValidatedPlan(validatedPlans, validatedPlan)
          writeEvent({ event: 'plan', plan: validatedPlan })
        }
      }
    }

    if (sseBuffer.trim()) {
      const delta = extractDeltaFromSseEvent(sseBuffer)
      const finishReason = extractFinishReasonFromSseEvent(sseBuffer)
      if (finishReason) streamFinishReasons.push(finishReason)
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
          const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
          if (!validation.validationPerformed) {
            placesValidationPerformed = false
          }
          const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
          logPlanQualitySummary(validatedPlan, request.input, 'stream-tail')
          const blockingIssues = getHardPlanQualityIssues(
            validatedPlan,
            request.input,
            validation.issues,
          )
          logSoftPlanQualityIssues(validatedPlan, request.input, validation.issues, 'stream-tail')

          if (blockingIssues.length > 0) {
            markPlanInvalid(invalidPlanIds, validationSummaries, validatedPlan.id, blockingIssues)
          } else {
            markPlanValid(invalidPlanIds, validationSummaries, validatedPlan.id)
          }

          upsertValidatedPlan(validatedPlans, validatedPlan)
          writeEvent({ event: 'plan', plan: validatedPlan })
        }
      }
    }

    let finalResponse: GenerateTripPlansResponse
    try {
      try {
        finalResponse = parseTripPlanSkeletonResponse(fullText)
      } catch {
        if (validatedPlans.length > 0) {
          finalResponse = {
            plans: validatedPlans,
            warnings: ['部分方案產生不完整，已為您呈現已完成的行程。']
          }
        } else {
          console.warn('[trip-json-parse-failed]', {
            textLength: fullText.length,
            finishReasons: Array.from(new Set(streamFinishReasons)),
            textTail: fullText.slice(-500),
          })
          finalResponse = await fetchSkeletonPlansNonStreaming(
            apiKey,
            tripPrompt,
            'initial-json-repair',
          )
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
        const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
        if (!validation.validationPerformed) {
          placesValidationPerformed = false
        }
        const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
        logPlanQualitySummary(validatedPlan, request.input, 'final-parse')
        const blockingIssues = getHardPlanQualityIssues(
          validatedPlan,
          request.input,
          validation.issues,
        )
        logSoftPlanQualityIssues(validatedPlan, request.input, validation.issues, 'final-parse')
        upsertValidatedPlan(validatedPlans, validatedPlan)

        if (blockingIssues.length > 0) {
          markPlanInvalid(invalidPlanIds, validationSummaries, validatedPlan.id, blockingIssues)
        } else {
          markPlanValid(invalidPlanIds, validationSummaries, validatedPlan.id)
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
            max_completion_tokens: 12000,
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
                const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
                if (!validation.validationPerformed) {
                  placesValidationPerformed = false
                }
                const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
                logPlanQualitySummary(validatedPlan, request.input, 'retry')
                const blockingIssues = getHardPlanQualityIssues(
                  validatedPlan,
                  request.input,
                  validation.issues,
                )
                logSoftPlanQualityIssues(validatedPlan, request.input, validation.issues, 'retry')
                retriedPlanIds.add(plan.id)
                if (blockingIssues.length > 0) {
                  markPlanInvalid(invalidPlanIds, validationSummaries, plan.id, blockingIssues)
                } else {
                  upsertValidatedPlan(validatedPlans, validatedPlan)
                  markPlanValid(invalidPlanIds, validationSummaries, plan.id)
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
      finalResponse.plans = (finalResponse.plans || []).map((p: TripPlan) => {
        const validated = validatedPlans.find((vp) => vp.id === p.id)
        return validated || p
      })
      for (const validatedPlan of validatedPlans) {
        if (!finalResponse.plans.some((plan) => plan.id === validatedPlan.id)) {
          finalResponse.plans.push(validatedPlan)
        }
      }
      finalResponse.plans = finalResponse.plans.sort(comparePlansByDisplayPriority)

      const finalRepairResults = await Promise.all((finalResponse.plans || []).map(async (plan) => {
        const result = await repairAndValidatePlanForDelivery(
          plan,
          request.input,
          nearbyPlaceCandidates,
          new Set(),
          'final-repair',
        )

        return {
          sourcePlan: plan,
          ...result,
        }
      }))

      const openingHoursSafePlans: TripPlan[] = []
      for (const repairResult of finalRepairResults) {
        if (repairResult.routesFailed) routesApiFailed = true
        if (!repairResult.plan) {
          validationSummaries.set(repairResult.sourcePlan.id, repairResult.issues)
          continue
        }
        logPlanOverlapForDiagnostics(repairResult.plan, openingHoursSafePlans, 'final-repair')
        openingHoursSafePlans.push(repairResult.plan)
      }
      finalResponse.plans = openingHoursSafePlans

      if (finalResponse.plans.length < PLAN_IDS.length) {
        const existingPlanIds = new Set(finalResponse.plans.map((plan) => plan.id))
        const missingPlanIds = PLAN_IDS.filter((planId) => !existingPlanIds.has(planId))

        if (missingPlanIds.length > 0) {
          try {
            for (const missingPlanId of missingPlanIds) {
              const retryPlans = await fetchRetrySkeletonPlans(
                apiKey,
                request.input,
                [missingPlanId],
                persona,
                nearbyPlaces,
                validationSummaries,
              )
              if (retryPlans.length === 0) {
                validationSummaries.set(missingPlanId, ['補案模型未回傳方案'])
                continue
              }

              let acceptedRetryPlan = false
              const candidateRetryPlans = getRetryPlansForMissingId(
                retryPlans as TripPlan[],
                missingPlanId,
              )

              for (const plan of candidateRetryPlans) {
                const normalizedRetryPlan = normalizeRefillPlanForMissingId(
                  plan as TripPlan,
                  missingPlanId,
                )

                const bias = request.input.location.lat && request.input.location.lng
                  ? { lat: request.input.location.lat, lng: request.input.location.lng }
                  : undefined
                const groundedPlan = applyCandidateGroundingToPlan(
                  normalizedRetryPlan,
                  nearbyPlaceCandidates,
                )
                const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
                if (!validation.validationPerformed) {
                  placesValidationPerformed = false
                }
                const validatedPlan = normalizePlanTotalTime(validation.validatedPlan)
                logPlanQualitySummary(validatedPlan, request.input, 'refill')
                const preliminaryIssues = getHardPlanQualityIssues(
                  validatedPlan,
                  request.input,
                  validation.issues,
                )
                logSoftPlanQualityIssues(validatedPlan, request.input, validation.issues, 'refill')
                if (preliminaryIssues.length > 0) {
                  writeGenerateDebugLog('refill-pre-repair-issues', {
                    planId: validatedPlan.id,
                    issues: preliminaryIssues,
                  })
                }

                const nonRepairableIssues = getNonRepairableRefillIssues(validation.issues)
                if (nonRepairableIssues.length > 0) {
                  validationSummaries.set(validatedPlan.id, nonRepairableIssues)
                  continue
                }

                const repairResult = await repairAndValidatePlanForDelivery(
                  validatedPlan,
                  request.input,
                  nearbyPlaceCandidates,
                  new Set(),
                  'refill-final-repair',
                )
                if (repairResult.routesFailed) routesApiFailed = true
                if (!repairResult.plan) {
                  validationSummaries.set(validatedPlan.id, repairResult.issues)
                  continue
                }
                logPlanOverlapForDiagnostics(
                  repairResult.plan,
                  finalResponse.plans,
                  'refill-final-repair',
                )

                upsertValidatedPlan(finalResponse.plans, repairResult.plan)
                validationSummaries.delete(repairResult.plan.id)
                acceptedRetryPlan = true
                break
              }

              if (candidateRetryPlans.length === 0) {
                validationSummaries.set(missingPlanId, ['補案模型未回傳指定方案 ID'])
              } else if (!acceptedRetryPlan && !validationSummaries.has(missingPlanId)) {
                validationSummaries.set(missingPlanId, ['補案未通過最終驗證'])
              }
            }
          } catch (error) {
            console.error('Final plan refill retry failed:', error)
          }
        }
      }

      if (ENABLE_LOCAL_FALLBACK_REFILL && finalResponse.plans.length < PLAN_IDS.length) {
        const localMissingPlanIds = PLAN_IDS.filter(
          (planId) => !finalResponse.plans.some((plan) => plan.id === planId),
        )

        for (const missingPlanId of localMissingPlanIds) {
          const localPlans = buildLocalFallbackPlanCandidates(
            missingPlanId,
            request.input,
            nearbyPlaceCandidates,
            finalResponse.plans,
          ).slice(0, 12)
          if (localPlans.length === 0) {
            if (!validationSummaries.has(missingPlanId)) {
              validationSummaries.set(missingPlanId, ['本地補案候選不足'])
            }
            continue
          }

          let acceptedLocalPlan = false
          let lastLocalIssues = ['本地補案未通過最終驗證']

          for (const localPlan of localPlans) {
            const repairResult = await repairAndValidatePlanForDelivery(
              localPlan,
              request.input,
              nearbyPlaceCandidates,
              new Set(),
              'local-refill-final-repair',
            )
            if (repairResult.routesFailed) routesApiFailed = true
            if (!repairResult.plan) {
              lastLocalIssues = repairResult.issues
              continue
            }
            logPlanOverlapForDiagnostics(
              repairResult.plan,
              finalResponse.plans,
              'local-refill-final-repair',
            )

            upsertValidatedPlan(finalResponse.plans, repairResult.plan)
            validationSummaries.delete(repairResult.plan.id)
            acceptedLocalPlan = true
            break
          }

          if (!acceptedLocalPlan) {
            validationSummaries.set(missingPlanId, lastLocalIssues)
          }
        }
      } else if (finalResponse.plans.length < PLAN_IDS.length) {
        const localRefillPayload = {
          shownPlanIds: finalResponse.plans.map((plan) => plan.id),
          missingPlanIds: PLAN_IDS.filter(
            (planId) => !finalResponse.plans.some((plan) => plan.id === planId),
          ),
        }
        console.info('[local-refill-disabled]', localRefillPayload)
        writeGenerateDebugLog('local-refill-disabled', localRefillPayload)
      }

      finalResponse.plans = finalResponse.plans.sort(comparePlansByDisplayPriority)

      const finalPlanIds = new Set(finalResponse.plans.map((plan) => plan.id))
      const unresolvedPlanIds = PLAN_IDS.filter((planId) => !finalPlanIds.has(planId))
      if (unresolvedPlanIds.length > 0) {
        logMissingPlanSummary(
          unresolvedPlanIds,
          validationSummaries,
          finalResponse.plans,
          nearbyPlaceCandidates,
        )
      }

      if (finalResponse.plans.length === 0) {
        const noPlanMessage = buildNoAvailablePlansMessage(validationSummaries)
        const noPlanPayload = {
          reasons: formatValidationSummaryForLog(validationSummaries),
        }
        console.warn('[no-available-plans]', noPlanPayload)
        writeGenerateDebugLog('no-available-plans', noPlanPayload)
        throw new Error(noPlanMessage)
      }

      if (!finalResponse.warnings) finalResponse.warnings = []
      if (!placesValidationPerformed) {
        finalResponse.warnings.push('Google Places 驗證未啟用，部分地點資訊可能不夠準確。')
      }
      if (routesApiFailed) {
        finalResponse.warnings.push('Google Routes API 未啟用，交通時間與距離為系統估算值。')
      }
      if (finalResponse.plans.length < PLAN_IDS.length) {
        finalResponse.warnings.push(
          `目前附近營業中的景點較少，僅 ${finalResponse.plans.length} 個可用方案。`,
        )
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

    writeGenerateDebugLog('generate-trip-done', {
      planIds: finalResponse.plans.map((plan) => plan.id),
      planCount: finalResponse.plans.length,
      warnings: finalResponse.warnings ?? [],
    })
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

function markPlanInvalid(
  invalidPlanIds: string[],
  validationSummaries: Map<string, string[]>,
  planId: string,
  issues: string[],
) {
  if (!invalidPlanIds.includes(planId)) {
    invalidPlanIds.push(planId)
  }
  validationSummaries.set(planId, issues)
}

function markPlanValid(
  invalidPlanIds: string[],
  validationSummaries: Map<string, string[]>,
  planId: string,
) {
  const existingIndex = invalidPlanIds.indexOf(planId)
  if (existingIndex >= 0) {
    invalidPlanIds.splice(existingIndex, 1)
  }
  validationSummaries.delete(planId)
}

function getRetryPlansForMissingId(
  retryPlans: TripPlan[],
  missingPlanId: PlanId,
) {
  const targetPlans = retryPlans.filter((plan) => plan.id === missingPlanId)
  if (targetPlans.length > 0) {
    return targetPlans
  }

  const usablePlans = retryPlans.filter((plan) => Array.isArray(plan.stops) && plan.stops.length > 0)
  if (usablePlans.length === 0) return []

  console.info('[plan-refill-id-normalized]', {
    targetPlanId: missingPlanId,
    returnedPlanIds: retryPlans.map((plan) => plan.id),
  })
  writeGenerateDebugLog('plan-refill-id-normalized', {
    targetPlanId: missingPlanId,
    returnedPlanIds: retryPlans.map((plan) => plan.id),
  })

  return [usablePlans[0]]
}

function normalizeRefillPlanForMissingId(plan: TripPlan, missingPlanId: PlanId): TripPlan {
  const shouldReplaceTitle = plan.id !== missingPlanId || hasPlanNumberTitle(plan.title)

  return {
    ...plan,
    id: missingPlanId,
    type: missingPlanId,
    title: shouldReplaceTitle ? getRefillPlanFallbackTitle(missingPlanId) : plan.title,
  }
}

function hasPlanNumberTitle(title?: string) {
  return /方案[一二三123]|保守型方案|平衡型方案|探索型方案/.test(title ?? '')
}

function getRefillPlanFallbackTitle(planId: PlanId) {
  const titleMap: Record<PlanId, string> = {
    safe: '穩定路線',
    balanced: '均衡路線',
    explore: '探索路線',
  }

  return titleMap[planId]
}

function getNonRepairableRefillIssues(issues: PlacesValidationResult['issues']) {
  const repairablePlaceIssueReasons: Array<PlacesValidationResult['issues'][number]['reason']> = [
    'outside_opening_hours',
  ]

  return issues
    .filter((issue) => !repairablePlaceIssueReasons.includes(issue.reason))
    .map(formatPlacesValidationIssue)
}

function getPlanPlaceIds(plan: TripPlan) {
  return (plan.stops ?? [])
    .map((stop) => stop.placeId)
    .filter((placeId): placeId is string => Boolean(placeId))
}

function arePlansOverlapping(left: TripPlan, right: TripPlan) {
  const leftPlaceIds = getPlanPlaceIds(left)
  const rightPlaceIds = getPlanPlaceIds(right)

  if (leftPlaceIds.length > 0 && rightPlaceIds.length > 0) {
    const rightSet = new Set(rightPlaceIds)
    const overlapCount = leftPlaceIds.filter((placeId) => rightSet.has(placeId)).length
    const overlapRatio = overlapCount / Math.min(leftPlaceIds.length, rightPlaceIds.length)

    if (overlapCount >= 2 && overlapRatio >= 0.8) {
      return true
    }
  }

  const leftSignature = getPlanNameSignature(left)
  const rightSignature = getPlanNameSignature(right)
  return Boolean(leftSignature && leftSignature === rightSignature)
}

function getPlanNameSignature(plan: TripPlan) {
  return (plan.stops ?? [])
    .map((stop) => normalizeStopSearchText(stop.name))
    .filter(Boolean)
    .join('|')
}

function buildPromptWithGroundingRules(prompt: string, hasNearbyPlaces: boolean) {
  const groundingRules = hasNearbyPlaces
    ? `

Hard constraints for real places:
- Use the injected Google place candidates as the source of truth.
- Every stop must include a non-empty "name", "address", and "placeId".
- Copy "name", "address", and "placeId" exactly from one injected candidate. Do not paraphrase or invent venue names.
- Prefer higher score candidates. Use FOOD_CANDIDATES for food stops and MAIN_ACTIVITY_CANDIDATES for main activity stops.
- Do not force every plan to include a food stop. Include food only when the trip overlaps lunch/dinner and a FOOD_CANDIDATE can be scheduled inside its opening window for at least 45 minutes.
- Keep the three plans meaningfully different. Avoid reusing the same placeId across different plans when there are viable alternatives, but reuse is allowed if the candidate pool is too constrained.
- If the user did not explicitly choose food-first, prefer FOOD_CANDIDATES with foodSubtype=cafe, dessert, or restaurant over snack/traditional street food, because they are better rest stops inside a short trip.
- Every selected candidate must have known Google opening hours. Schedule it only inside that available window, make sure the visit ends no later than leaveBy, and do not select a candidate whose opening window cannot support at least 40 minutes of visit time in the user's trip window (45 minutes for food).
- Treat bestSlots as the allowed position hint: early belongs in the first third, middle in the middle third, late in the final third. Do not place a candidate with only late availability in the first half of the route.
- When FIRST_STOP_CANDIDATES_WITHIN_2KM exists, stops[0] must come from that section.
- If a candidate list is provided but seems imperfect, still choose from that list instead of fabricating a place.
- Return JSON only. No markdown. No commentary.
`.trim()
    : ''

  return groundingRules ? `${prompt}\n\n${groundingRules}` : prompt
}

async function fetchRetrySkeletonPlans(
  apiKey: string,
  input: GenerateTripPlansRequest['input'],
  planIds: readonly string[],
  persona: Persona,
  nearbyPlaces: string,
  validationSummaries: Map<string, string[]>,
) {
  const retryPrompt = buildRetryTripSkeletonPrompt(
    input,
    [...planIds],
    persona,
    nearbyPlaces,
    formatRetryValidationSummaries([...planIds], validationSummaries),
  )
  const retryResponseSchema = buildTripPlanRefillResponseSchema(planIds.length)
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
      max_completion_tokens: 12000,
      temperature: 0.15,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'trip_plan_skeleton_response',
          strict: true,
          schema: retryResponseSchema,
        },
      },
    }),
  })

  if (!retryResponse.ok) return []

  const retryData = (await retryResponse.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  return parseTripPlanSkeletonResponse(retryData.choices[0].message.content).plans
}

function buildTripPlanRefillResponseSchema(planCount: number) {
  const minItems = Math.max(1, planCount)
  const plansSchema = tripPlanSkeletonResponseSchema.properties.plans

  return {
    ...tripPlanSkeletonResponseSchema,
    properties: {
      ...tripPlanSkeletonResponseSchema.properties,
      plans: {
        ...plansSchema,
        minItems,
        maxItems: minItems,
      },
    },
  }
}

async function fetchSkeletonPlansNonStreaming(
  apiKey: string,
  prompt: string,
  phase: string,
): Promise<GenerateTripPlansResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
          content: prompt,
        },
      ],
      max_completion_tokens: 12000,
      temperature: 0.15,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'trip_plan_response',
          schema: tripPlanSkeletonResponseSchema,
          strict: true,
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(await buildOpenAiErrorMessage(response))
  }

  const data = (await response.json()) as {
    choices: Array<{
      finish_reason?: string
      message: { content: string }
    }>
  }
  const choice = data.choices[0]
  if (choice?.finish_reason) {
    console.info('[trip-json-fallback-finish]', {
      phase,
      finishReason: choice.finish_reason,
    })
  }

  return parseTripPlanSkeletonResponse(choice.message.content)
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

async function validateStopsWithPlanningTimeline(
  plan: TripPlan,
  bias: { lat: number; lng: number } | undefined,
  input: GenerateTripPlansRequest['input'],
) {
  const placeResolution = await validateStopsWithPlaces(plan, bias)
  if (!placeResolution.validationPerformed || placeResolution.invalidCount > 0) {
    return placeResolution
  }

  const timelineInput = await getOpeningHoursTimelineInput(placeResolution.validatedPlan, input)
  const validation = await validateStopsWithPlaces(placeResolution.validatedPlan, bias, timelineInput)

  return {
    ...validation,
    validatedPlan: annotatePlanScheduleStart(validation.validatedPlan, timelineInput.startTime),
  }
}

async function repairPlanForDelivery(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string> = new Set(),
  options: { allowCoverageRepair?: boolean } = {},
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  const allowCoverageRepair = options.allowCoverageRepair ?? true
  const usedPlaceIds = new Set<string>()
  const repairedStops = plan.stops.map((stop, index) =>
    ensureStopHasVerifiedPlace(stop, index, candidates, usedPlaceIds, avoidedPlaceIds),
  )
  const scheduleAlignedStops = allowCoverageRepair
    ? alignStopsWithCandidateAvailability(
        repairedStops,
        input,
        candidates,
        avoidedPlaceIds,
        plan.transportSegments,
      )
    : repairedStops
  usedPlaceIds.clear()
  scheduleAlignedStops.forEach((stop) => {
    if (stop.placeId) usedPlaceIds.add(stop.placeId)
  })
  const expandedStops = allowCoverageRepair
    ? expandStopsForLongTrip(scheduleAlignedStops, input, candidates, usedPlaceIds, plan.id)
    : scheduleAlignedStops
  const deliveryStops = allowCoverageRepair
    ? ensureMealStopForTrip(expandedStops, input, candidates, usedPlaceIds, plan.id)
    : expandedStops
  const temporallyAlignedStops = allowCoverageRepair
    ? realignFoodStopsForMealWindows(deliveryStops, input)
    : deliveryStops
  const { segments: repairedSegments, routesFailed } = await repairTransportSegments(
    plan.transportSegments,
    temporallyAlignedStops,
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
  const routeRepairedPlan = {
    ...plan,
    stops: temporallyAlignedStops,
    transportSegments: repairedSegments,
    rainBackup: repairedRainBackup,
    rainTransportSegments: repairedRainSegments,
  }
  const coverageRepairedPlan = allowCoverageRepair
    ? stretchPlanDurationToCoverage(routeRepairedPlan, input)
    : normalizePlanTotalTime(routeRepairedPlan)
  const capacityRepairedPlan = allowCoverageRepair
    ? shrinkPlanDurationToScheduleCapacity(coverageRepairedPlan, input)
    : coverageRepairedPlan
  const trimmedPlan = allowCoverageRepair
    ? await trimPlanToTimeWindow(capacityRepairedPlan, input)
    : coverageRepairedPlan
  const postCoverageMealAlignment = allowCoverageRepair
    ? await realignPlanMealsAfterTiming(trimmedPlan, input)
    : { plan: trimmedPlan, routesFailed: false }
  const postTimingAlignment = allowCoverageRepair
    ? await realignPlanCandidatesAfterTiming(
        postCoverageMealAlignment.plan,
        input,
        candidates,
        avoidedPlaceIds,
      )
    : { plan: postCoverageMealAlignment.plan, routesFailed: false }
  const finalMealAlignment = allowCoverageRepair
    ? await realignPlanMealsAfterTiming(postTimingAlignment.plan, input)
    : { plan: postTimingAlignment.plan, routesFailed: false }
  const finalTimingAlignment = allowCoverageRepair
    ? await realignPlanCandidatesAfterTiming(
        finalMealAlignment.plan,
        input,
        candidates,
        avoidedPlaceIds,
      )
    : { plan: finalMealAlignment.plan, routesFailed: false }
  const finalPlan = normalizePlanTotalTime(finalTimingAlignment.plan)

  if (allowCoverageRepair) {
    const coveragePayload = {
      planId: plan.id,
      stopCount: finalPlan.stops.length,
      actualMinutes: getPlanActualDuration(finalPlan),
      minimumMinutes: getMinimumRequiredActualMinutes(input),
      targetMinutes: getCoverageRepairTargetMinutes(input),
      scheduleCapacityMinutes: getScheduleCapacityMinutes(input),
      foodStops: finalPlan.stops
        .filter((stop) => stop.type === 'food')
        .map((stop) => stop.name),
    }
    console.info('[coverage-repair-result]', coveragePayload)
    writeGenerateDebugLog('coverage-repair-result', coveragePayload)
  }

  return {
    plan: {
      ...finalPlan,
      totalTime: getPlanActualDuration(finalPlan),
    },
    routesFailed:
      routesFailed ||
      postCoverageMealAlignment.routesFailed ||
      postTimingAlignment.routesFailed ||
      finalMealAlignment.routesFailed ||
      finalTimingAlignment.routesFailed,
  }
}

async function realignPlanMealsAfterTiming(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  const alignedStops = realignFoodStopsForMealWindows(plan.stops, input)
  if (!haveStopOrderChanged(plan.stops, alignedStops)) {
    return { plan, routesFailed: false }
  }

  const { segments, routesFailed } = await repairTransportSegments(
    plan.transportSegments ?? [],
    alignedStops,
    plan.transportMode,
  )
  const alignedPlan = normalizePlanTotalTime({
    ...plan,
    stops: alignedStops,
    transportSegments: segments,
  })

  writeGenerateDebugLog('post-timing-meal-realignment', {
    planId: plan.id,
    foodStops: alignedPlan.stops
      .filter((stop) => stop.type === 'food')
      .map((stop) => stop.name),
    actualMinutes: getPlanActualDuration(alignedPlan),
  })

  return {
    plan: alignedPlan,
    routesFailed,
  }
}

function haveStopOrderChanged(before: Stop[], after: Stop[]) {
  if (before.length !== after.length) return true

  return before.some((stop, index) => stop.id !== after[index]?.id)
}

async function realignPlanCandidatesAfterTiming(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  let nextPlan = normalizePlanTotalTime(plan)
  let routesFailed = false
  let appliedPasses = 0

  for (let pass = 1; pass <= POST_TIMING_ALIGNMENT_MAX_PASSES; pass += 1) {
    const alignedStops = alignStopsWithCandidateAvailability(
      nextPlan.stops,
      input,
      candidates,
      avoidedPlaceIds,
      nextPlan.transportSegments,
    )

    if (!haveStopsChangedForTimingAlignment(nextPlan.stops, alignedStops)) break

    let alignedSegments = nextPlan.transportSegments ?? []
    if (
      haveStopRouteEndpointsChanged(nextPlan.stops, alignedStops) ||
      alignedSegments.length !== Math.max(alignedStops.length - 1, 0)
    ) {
      const routeRepair = await repairTransportSegments(
        nextPlan.transportSegments ?? [],
        alignedStops,
        nextPlan.transportMode,
      )
      alignedSegments = routeRepair.segments
      routesFailed = routesFailed || routeRepair.routesFailed
    }

    nextPlan = shrinkPlanDurationToScheduleCapacity(
      normalizePlanTotalTime({
        ...nextPlan,
        stops: alignedStops,
        transportSegments: alignedSegments,
      }),
      input,
    )
    appliedPasses = pass
  }

  if (appliedPasses > 0) {
    writeGenerateDebugLog('post-timing-candidate-alignment', {
      planId: plan.id,
      passes: appliedPasses,
      stopCount: nextPlan.stops.length,
      actualMinutes: getPlanActualDuration(nextPlan),
    })
  }

  return {
    plan: nextPlan,
    routesFailed,
  }
}

function haveStopsChangedForTimingAlignment(before: Stop[], after: Stop[]) {
  if (before.length !== after.length) return true

  return before.some((stop, index) => {
    const nextStop = after[index]
    return (
      stop.placeId !== nextStop?.placeId ||
      stop.name !== nextStop?.name ||
      stop.address !== nextStop?.address ||
      stop.type !== nextStop?.type ||
      stop.duration !== nextStop?.duration ||
      stop.googleMapsUrl !== nextStop?.googleMapsUrl ||
      stop.lat !== nextStop?.lat ||
      stop.lng !== nextStop?.lng
    )
  })
}

function haveStopRouteEndpointsChanged(before: Stop[], after: Stop[]) {
  if (before.length !== after.length) return true

  return before.some((stop, index) => {
    const nextStop = after[index]
    return (
      stop.placeId !== nextStop?.placeId ||
      stop.address !== nextStop?.address ||
      stop.lat !== nextStop?.lat ||
      stop.lng !== nextStop?.lng
    )
  })
}

async function repairAndValidatePlanForDelivery(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
  phase: string,
): Promise<{ plan: TripPlan | null; routesFailed: boolean; issues: string[] }> {
  const firstAttempt = await repairPlanForDelivery(plan, input, candidates, avoidedPlaceIds, {
    allowCoverageRepair: false,
  })
  const firstIssues = await getDeliveryPlanIssues(firstAttempt.plan, input, phase)

  if (firstIssues.length === 0) {
    console.info('[plan-repair-preserved]', {
      phase,
      planId: plan.id,
    })
    return {
      plan: await annotatePlanWithScheduleStart(firstAttempt.plan, input),
      routesFailed: firstAttempt.routesFailed,
      issues: [],
    }
  }

  const coverageAttempt = await repairPlanForDelivery(plan, input, candidates, avoidedPlaceIds, {
    allowCoverageRepair: true,
  })
  const coverageIssues = await getDeliveryPlanIssues(
    coverageAttempt.plan,
    input,
    `${phase}-coverage-repair`,
  )

  if (coverageIssues.length === 0) {
    console.info('[plan-repair-coverage-applied]', {
      phase,
      planId: plan.id,
      originalIssues: firstIssues,
    })
    return {
      plan: await annotatePlanWithScheduleStart(coverageAttempt.plan, input),
      routesFailed: firstAttempt.routesFailed || coverageAttempt.routesFailed,
      issues: [],
    }
  }

  if (avoidedPlaceIds.size === 0) {
    const coverageFailedPayload = {
      phase,
      planId: plan.id,
      originalIssues: firstIssues,
      coverageIssues,
    }
    console.info('[plan-repair-coverage-failed]', coverageFailedPayload)
    writeGenerateDebugLog('plan-repair-coverage-failed', coverageFailedPayload)

    return {
      plan: null,
      routesFailed: firstAttempt.routesFailed || coverageAttempt.routesFailed,
      issues: coverageIssues.length > 0 ? coverageIssues : firstIssues,
    }
  }

  console.info('[plan-diversity-fallback]', {
    planId: plan.id,
    phase,
    avoidedCount: avoidedPlaceIds.size,
    issues: firstIssues,
  })

  const fallbackAttempt = await repairPlanForDelivery(plan, input, candidates, new Set(), {
    allowCoverageRepair: false,
  })
  const fallbackIssues = await getDeliveryPlanIssues(fallbackAttempt.plan, input, `${phase}-fallback`)

  return {
    plan:
      fallbackIssues.length === 0
        ? await annotatePlanWithScheduleStart(fallbackAttempt.plan, input)
        : null,
    routesFailed: firstAttempt.routesFailed || coverageAttempt.routesFailed || fallbackAttempt.routesFailed,
    issues: fallbackIssues.length === 0 ? [] : fallbackIssues,
  }
}

async function getDeliveryPlanIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  phase: string,
) {
  logPlanQualitySummary(plan, input, phase)

  const hardIssues = getHardPlanQualityIssues(plan, input, [])
  if (hardIssues.length > 0) {
    return hardIssues
  }

  const openingHoursIssues = await validatePlanOpeningHours(
    plan,
    await getOpeningHoursTimelineInput(plan, input),
  )
  if (openingHoursIssues.length > 0) {
    logOpeningHoursIssues(plan.id, openingHoursIssues)
    return openingHoursIssues.map(formatOpeningHoursValidationIssue)
  }

  return []
}

async function annotatePlanWithScheduleStart(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const timelineInput = await getOpeningHoursTimelineInput(plan, input)
  return annotatePlanScheduleStart(plan, timelineInput.startTime)
}

function annotatePlanScheduleStart(plan: TripPlan, scheduleStartTime: string) {
  return {
    ...plan,
    scheduleStartTime,
  }
}

function buildLocalFallbackPlanCandidates(
  planId: (typeof PLAN_IDS)[number],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  existingPlans: TripPlan[],
) {
  const usedPlaceIds = new Set(existingPlans.flatMap(getPlanPlaceIds))
  const firstPool = getLocalFallbackPool(
    candidates.firstStopCandidates.length > 0
      ? candidates.firstStopCandidates
      : candidates.allCandidates,
    usedPlaceIds,
    'main_activity',
  ).slice(0, 8)
  const activityPool = getLocalFallbackPool(
    candidates.otherCandidates.length > 0 ? candidates.otherCandidates : candidates.allCandidates,
    usedPlaceIds,
    'main_activity',
  ).slice(0, 12)
  const foodPool = getLocalFallbackPool(
    candidates.otherCandidates.length > 0 ? candidates.otherCandidates : candidates.allCandidates,
    usedPlaceIds,
    'food',
  ).slice(0, 8)
  const wantsFoodStop = shouldLocalFallbackIncludeFood(input)
  const candidatePlans: Array<{ plan: TripPlan; score: number }> = []

  for (const firstCandidate of firstPool) {
    const secondPools = wantsFoodStop
      ? [
          { pool: foodPool, type: 'food' as const },
          { pool: activityPool, type: 'main_activity' as const },
        ]
      : [
          { pool: activityPool, type: 'main_activity' as const },
          { pool: foodPool, type: 'food' as const },
        ]

    for (const secondPool of secondPools) {
      for (const secondCandidate of secondPool.pool) {
        if (secondCandidate.placeId === firstCandidate.placeId) continue

        const stops = [
          buildLocalFallbackStop(planId, firstCandidate, 1, 'main_activity'),
          buildLocalFallbackStop(planId, secondCandidate, 2, secondPool.type),
        ]
        candidatePlans.push({
          plan: buildLocalFallbackPlanFromStops(planId, input, stops),
          score: scoreLocalFallbackStops(
            stops,
            [firstCandidate, secondCandidate],
            input,
            usedPlaceIds,
          ),
        })

        if (!wantsFoodStop && activityPool.length >= 2) {
          const thirdCandidate = activityPool.find(
            (candidate) =>
              candidate.placeId !== firstCandidate.placeId &&
              candidate.placeId !== secondCandidate.placeId,
          )
          if (thirdCandidate) {
            const threeStopPlan = [
              ...stops,
              buildLocalFallbackStop(planId, thirdCandidate, 3, 'main_activity'),
            ]
            candidatePlans.push({
              plan: buildLocalFallbackPlanFromStops(planId, input, threeStopPlan),
              score: scoreLocalFallbackStops(
                threeStopPlan,
                [firstCandidate, secondCandidate, thirdCandidate],
                input,
                usedPlaceIds,
              ) - 4,
            })
          }
        }
      }
    }
  }

  return candidatePlans
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.plan)
}

function buildLocalFallbackPlanFromStops(
  planId: (typeof PLAN_IDS)[number],
  input: GenerateTripPlansRequest['input'],
  stops: Stop[],
) {
  const transportMode = input.transportMode ?? 'scooter'

  return normalizePlanTotalTime({
    id: planId,
    type: planId,
    title: getLocalFallbackPlanTitle(planId),
    subtitle: '附近可用候選組合',
    summary: '依附近營業中地點組成的可用備選路線。',
    budget: estimateLocalFallbackBudget(stops, input),
    transportMode,
    stops,
    transportSegments: stops.slice(0, -1).map((stop, index) => ({
      fromStopId: stop.id,
      toStopId: stops[index + 1].id,
      mode: transportMode,
      duration: 18,
      label: '約 18 分鐘（系統估算）',
    })),
    rainBackup: [],
    rainTransportSegments: [],
    totalTime: 0,
  })
}

function getLocalFallbackPool(
  pool: VerifiedPlaceCandidate[],
  usedPlaceIds: Set<string>,
  stopType: Stop['type'],
) {
  const filteredPool = pool.filter((candidate) => {
    if (isShortVisitCandidate(candidate)) return false

    const candidateType = inferStopTypeFromCandidate(candidate)
    if (stopType === 'food') return candidateType === 'food'
    return candidateType !== 'food'
  })

  return filteredPool.sort((left, right) => {
    const usedDelta = Number(usedPlaceIds.has(left.placeId)) - Number(usedPlaceIds.has(right.placeId))
    if (usedDelta !== 0) return usedDelta

    return (right.score ?? 0) - (left.score ?? 0)
  })
}

function shouldLocalFallbackIncludeFood(input: GenerateTripPlansRequest['input']) {
  return (
    !input.tags.includes('no_full_meals') &&
    (tripOverlapsMealWindow(input, 11 * 60, 13 * 60) ||
      tripOverlapsMealWindow(input, 17 * 60, 19 * 60) ||
      input.tags.includes('food_first'))
  )
}

function scoreLocalFallbackStops(
  stops: Stop[],
  sourceCandidates: VerifiedPlaceCandidate[],
  input: GenerateTripPlansRequest['input'],
  usedPlaceIds: Set<string>,
) {
  const coverageBasisMinutes = getCoverageBasisMinutes(input)
  const stopMinutes = stops.reduce((total, stop) => total + stop.duration, 0)
  const estimatedTotal = stopMinutes + estimateTransportTotal(stops)
  const coverageScore = coverageBasisMinutes
    ? Math.max(0, 30 - Math.abs(coverageBasisMinutes * 0.85 - estimatedTotal) / 4)
    : 10
  const diversityScore = stops.filter((stop) => !stop.placeId || !usedPlaceIds.has(stop.placeId)).length * 12
  const foodScore = shouldLocalFallbackIncludeFood(input)
    ? stops.some((stop) => stop.type === 'food') ? 18 : -10
    : stops.some((stop) => stop.type === 'food') ? 4 : 8
  const candidateScore =
    sourceCandidates.reduce((total, candidate) => total + (candidate.score ?? 0), 0) /
    Math.max(sourceCandidates.length, 1)

  return candidateScore + coverageScore + diversityScore + foodScore - Math.max(0, stops.length - 2) * 3
}

function buildLocalFallbackStop(
  planId: string,
  candidate: VerifiedPlaceCandidate,
  index: number,
  type: Stop['type'],
): Stop {
  return {
    id: `${planId}-local-${index}`,
    name: candidate.name,
    type,
    description: '',
    address: candidate.address,
    duration: getDefaultStopDuration(type),
    googleMapsUrl: candidate.googleMapsUrl,
    placeId: candidate.placeId,
    lat: candidate.lat,
    lng: candidate.lng,
  }
}

function getLocalFallbackPlanTitle(planId: string) {
  const titleMap: Record<string, string> = {
    safe: '保守備選方案',
    balanced: '平衡備選方案',
    explore: '探索備選方案',
  }

  return titleMap[planId] ?? '備選方案'
}

function estimateLocalFallbackBudget(stops: Stop[], input: GenerateTripPlansRequest['input']) {
  const base = stops.reduce((total, stop) => total + (stop.type === 'food' ? 350 : 120), 0)
  const people = input.people ?? 2
  return Math.max(300, Math.round(base * Math.max(1, people / 2)))
}

function ensureStopHasVerifiedPlace(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  avoidedPlaceIds: Set<string> = new Set(),
) {
  if (
    stop.placeId &&
    stop.address &&
    stop.googleMapsUrl &&
    !usedPlaceIds.has(stop.placeId) &&
    !avoidedPlaceIds.has(stop.placeId)
  ) {
    const existingCandidate = findMatchingCandidateForStop(stop, index, candidates)
    usedPlaceIds.add(stop.placeId)
    return existingCandidate ? applyCandidateToStop(stop, existingCandidate) : stop
  }

  const candidate = pickCandidateForStop(stop, index, candidates, usedPlaceIds, avoidedPlaceIds)
  if (!candidate) return stop

  usedPlaceIds.add(candidate.placeId)
  return applyCandidateToStop(stop, candidate)
}

function pickCandidateForStop(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  avoidedPlaceIds: Set<string> = new Set(),
) {
  const existingCandidate = findMatchingCandidateForStop(stop, index, candidates)

  if (
    existingCandidate &&
    !usedPlaceIds.has(existingCandidate.placeId) &&
    !avoidedPlaceIds.has(existingCandidate.placeId)
  ) {
    return existingCandidate
  }

  const pool =
    stop.type === 'food'
      ? getCandidatePoolByStopType(stop, candidates)
      : index === 0
      ? candidates.firstStopCandidates.length > 0
        ? preferNonShortVisitCandidates(candidates.firstStopCandidates)
        : candidates.allCandidates
      : getCandidatePoolByStopType(stop, candidates)

  if (stop.type === 'food') {
    return (
      pool.find(
        (candidate) =>
          !usedPlaceIds.has(candidate.placeId) && !avoidedPlaceIds.has(candidate.placeId),
      ) ??
      pool.find((candidate) => !usedPlaceIds.has(candidate.placeId)) ??
      null
    )
  }

  return (
    pool.find(
      (candidate) =>
        !usedPlaceIds.has(candidate.placeId) && !avoidedPlaceIds.has(candidate.placeId),
    ) ??
    candidates.allCandidates.find(
      (candidate) =>
        !usedPlaceIds.has(candidate.placeId) && !avoidedPlaceIds.has(candidate.placeId),
    ) ??
    pool.find((candidate) => !usedPlaceIds.has(candidate.placeId)) ??
    pool[0] ??
    null
  )
}

function alignStopsWithCandidateAvailability(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
  transportSegments?: TripPlan['transportSegments'],
) {
  const usedPlaceIds = new Set<string>()

  return stops.map((stop, index) => {
    const requiredSlot = getRequiredAvailabilitySlotForStop(stops, index, input, transportSegments)
    const estimatedArrivalMinutes = getEstimatedArrivalMinutesForStop(
      stops,
      index,
      input,
      transportSegments,
    )
    const estimatedDuration = Math.max(getMinimumStopDuration(stop), Number(stop.duration) || 0)
    const existingCandidate = findMatchingCandidateForStop(stop, index, candidates)

    if (
      existingCandidate &&
      isCandidateAvailableForSchedule(
        existingCandidate,
        requiredSlot,
        estimatedArrivalMinutes,
        estimatedDuration,
      ) &&
      !usedPlaceIds.has(existingCandidate.placeId) &&
      !avoidedPlaceIds.has(existingCandidate.placeId)
    ) {
      usedPlaceIds.add(existingCandidate.placeId)
      return applyCandidateToStop(stop, existingCandidate)
    }

    const replacementCandidate = pickCandidateForStopAvailabilitySlot(
      stop,
      index,
      candidates,
      usedPlaceIds,
      avoidedPlaceIds,
      requiredSlot,
      estimatedArrivalMinutes,
      estimatedDuration,
    )

    if (!replacementCandidate) {
      if (stop.placeId) usedPlaceIds.add(stop.placeId)
      return stop
    }

    usedPlaceIds.add(replacementCandidate.placeId)
    const replacementStop = applyCandidateToStop(stop, replacementCandidate)

    if (existingCandidate?.placeId !== replacementCandidate.placeId) {
      console.info('[schedule-candidate-replaced]', {
        stopId: stop.id,
        from: existingCandidate?.name ?? stop.name,
        to: replacementCandidate.name,
        requiredSlot,
        estimatedArrival: formatMinutesAsTime(estimatedArrivalMinutes),
      })
      writeGenerateDebugLog('schedule-candidate-replaced', {
        stopId: stop.id,
        from: existingCandidate?.name ?? stop.name,
        to: replacementCandidate.name,
        requiredSlot,
        estimatedArrival: formatMinutesAsTime(estimatedArrivalMinutes),
      })
    }

    return replacementStop
  })
}

function pickCandidateForStopAvailabilitySlot(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  avoidedPlaceIds: Set<string>,
  requiredSlot: string,
  estimatedArrivalMinutes: number,
  estimatedDuration: number,
) {
  const basePool =
    stop.type === 'food'
      ? getCandidatePoolByStopType(stop, candidates)
      : index === 0 && candidates.firstStopCandidates.length > 0
      ? preferNonShortVisitCandidates(candidates.firstStopCandidates)
      : getCandidatePoolByStopType(stop, candidates)
  const fallbackPool =
    stop.type === 'food'
      ? basePool
      : index === 0 && candidates.firstStopCandidates.length > 0
      ? candidates.firstStopCandidates
      : candidates.allCandidates
  const pools = basePool === fallbackPool ? [basePool] : [basePool, fallbackPool]

  for (const pool of pools) {
    const candidate = pool.find(
      (item) =>
        !usedPlaceIds.has(item.placeId) &&
        !avoidedPlaceIds.has(item.placeId) &&
        isCandidateAvailableForSchedule(
          item,
          requiredSlot,
          estimatedArrivalMinutes,
          estimatedDuration,
        ),
    )
    if (candidate) return candidate
  }

  return null
}

function isCandidateAvailableForSchedule(
  candidate: VerifiedPlaceCandidate,
  requiredSlot: string,
  estimatedArrivalMinutes: number,
  estimatedDuration: number,
) {
  void requiredSlot
  return isCandidateOpenForVisit(candidate, estimatedArrivalMinutes, estimatedDuration)
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
    const isShortVisit = isShortVisitCandidate(candidate)

    if (stop.type === 'food') {
      return isFoodCandidate(candidate)
    }

    return (
      !isShortVisit &&
      !isFoodCandidate(candidate)
    )
  })

  if (stop.type === 'food') return typedPool

  return typedPool.length > 0 ? typedPool : basePool
}

function ensureMealStopForTrip(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  planId?: string,
) {
  const nextStops = [...stops]
  const mealWindows = getRequiredMealWindows(input)
  if (mealWindows.length === 0) return nextStops

  const missingMealWindows = getMissingMealWindows(nextStops, input, mealWindows)
  if (missingMealWindows.length === 0) return nextStops

  for (const mealWindow of missingMealWindows) {
    const foodCandidate = selectMealCandidate(candidates, usedPlaceIds, mealWindow, planId)
    if (!foodCandidate) continue

    usedPlaceIds.add(foodCandidate.placeId)
    const mealStop = applyCandidateToStop(
      {
        id: buildSupplementalStopId(input, nextStops.length + 1),
        name: foodCandidate.name,
        type: 'food',
        description: '',
        address: foodCandidate.address,
        duration: getDefaultStopDuration('food'),
      },
      foodCandidate,
    )
    const insertionIndex = findMealWindowInsertionIndex(
      nextStops.filter((stop) => stop.type !== 'food'),
      input,
      getMealInsertionTargetMinutes(mealWindow),
    )
    const actualInsertionIndex = getActualInsertionIndexForNonFoodPosition(nextStops, insertionIndex)
    nextStops.splice(actualInsertionIndex, 0, mealStop)

    const mealStopPayload = {
      stopName: mealStop.name,
      mealWindow: mealWindow.id,
      insertionIndex: actualInsertionIndex,
      startTime: input.startTime,
      endTime: input.endTime,
    }
    console.info('[meal-stop-added]', mealStopPayload)
    writeGenerateDebugLog('meal-stop-added', mealStopPayload)
  }

  return nextStops
}

function getMissingMealWindows(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  mealWindows: RequiredMealWindow[],
) {
  return mealWindows.filter(
    (mealWindow) =>
      !stops.some((stop, index) => {
        if (stop.type !== 'food') return false

        return isStopAlignedWithMealWindow(
          getEstimatedArrivalMinutesForStop(stops, index, input),
          Number(stop.duration) || getDefaultStopDuration('food'),
          mealWindow,
        )
      }),
  )
}

function getActualInsertionIndexForNonFoodPosition(stops: Stop[], nonFoodInsertionIndex: number) {
  if (nonFoodInsertionIndex <= 0) return 0

  let nonFoodSeen = 0
  for (let index = 0; index < stops.length; index += 1) {
    if (stops[index].type === 'food') continue

    nonFoodSeen += 1
    if (nonFoodSeen >= nonFoodInsertionIndex) return index + 1
  }

  return stops.length
}

function selectMealCandidate(
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  mealWindow: RequiredMealWindow,
  planId?: string,
) {
  const foodCandidates = mergeCandidatePools(
    candidates.otherCandidates,
    candidates.allCandidates,
    candidates.firstStopCandidates,
  )
    .filter((candidate) => isFoodCandidate(candidate) && !usedPlaceIds.has(candidate.placeId))

  const mealWindowCandidates = foodCandidates.filter((candidate) =>
    isCandidateOpenDuringMealWindow(candidate, mealWindow),
  )
  const pool = mealWindowCandidates.length > 0 ? mealWindowCandidates : foodCandidates

  const rankedCandidates = pool
    .sort((left, right) => {
      const leftSlotScore = getMealCandidateSlotScore(left, mealWindow)
      const rightSlotScore = getMealCandidateSlotScore(right, mealWindow)
      if (leftSlotScore !== rightSlotScore) return rightSlotScore - leftSlotScore

      return (right.score ?? 0) - (left.score ?? 0)
    })

  return pickRotatedItem(
    rankedCandidates.slice(0, Math.min(3, rankedCandidates.length)),
    getPlanDisplayPriority(planId ?? '') + (mealWindow.id === 'dinner' ? 1 : 0),
  )
}

function getMealCandidateSlotScore(
  candidate: VerifiedPlaceCandidate,
  mealWindow: RequiredMealWindow,
) {
  const slots = candidate.availabilitySlots ?? []
  let score = 0

  if (isCandidateOpenDuringMealWindow(candidate, mealWindow)) score += 8
  if (slots.includes(mealWindow.preferredSlot)) score += 4
  if (slots.includes('middle')) score += mealWindow.id === 'lunch' ? 3 : 1
  if (slots.includes('late')) score += mealWindow.id === 'dinner' ? 3 : 1
  if (slots.includes('early')) score += 1

  return score
}

function isCandidateOpenDuringMealWindow(
  candidate: VerifiedPlaceCandidate,
  mealWindow: RequiredMealWindow,
) {
  const durationMinutes = getDefaultStopDuration('food')
  const earliestStart = mealWindow.start - durationMinutes + MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES
  const latestStart = mealWindow.end - MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES
  const searchStart =
    Math.floor(earliestStart / TIMELINE_START_GRANULARITY_MINUTES) *
    TIMELINE_START_GRANULARITY_MINUTES
  const searchEnd =
    Math.ceil(latestStart / TIMELINE_START_GRANULARITY_MINUTES) *
    TIMELINE_START_GRANULARITY_MINUTES

  for (
    let arrivalMinutes = searchStart;
    arrivalMinutes <= searchEnd;
    arrivalMinutes += TIMELINE_START_GRANULARITY_MINUTES
  ) {
    if (
      getVisitMealWindowOverlapMinutes(arrivalMinutes, durationMinutes, mealWindow) <
      MEAL_ALIGNMENT_MIN_OVERLAP_MINUTES
    ) {
      continue
    }

    if (isCandidateOpenForVisit(candidate, arrivalMinutes, durationMinutes)) return true
  }

  return false
}

function realignFoodStopsForMealWindows(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
) {
  if (stops.length < 3 || input.tags.includes('no_full_meals')) return stops
  if (!shouldMoveFoodStopsTowardMealWindow(input)) return stops
  const mealWindows = getRequiredMealWindows(input)
  if (mealWindows.length === 0) return stops

  const foodStops = stops.filter((stop) => stop.type === 'food')
  if (foodStops.length === 0) return stops

  const nonFoodStops = stops.filter((stop) => stop.type !== 'food')
  if (nonFoodStops.length < 2) return stops

  const nextStops = [...nonFoodStops]

  foodStops.forEach((foodStop, index) => {
    const mealWindow = mealWindows[Math.min(index, mealWindows.length - 1)]
    const targetIndex = findMealWindowInsertionIndex(
      nextStops,
      input,
      getMealInsertionTargetMinutes(mealWindow),
    )
    nextStops.splice(Math.min(targetIndex, nextStops.length), 0, foodStop)
  })

  const originalOrder = stops.map((stop) => stop.id).join('|')
  const nextOrder = nextStops.map((stop) => stop.id).join('|')
  if (originalOrder === nextOrder) return stops

  console.info('[food-stop-realigned]', {
    foodStops: foodStops.map((stop) => stop.name),
    fromOrder: stops.map((stop) => stop.id),
    toOrder: nextStops.map((stop) => stop.id),
    startTime: input.startTime,
    endTime: input.endTime,
  })

  return nextStops
}

function shouldMoveFoodStopsTowardMealWindow(input: GenerateTripPlansRequest['input']) {
  return getRequiredMealWindows(input).length > 0
}

function isShortVisitCandidate(candidate: VerifiedPlaceCandidate) {
  const text = `${candidate.name} ${candidate.address}`.toLocaleLowerCase('zh-TW')
  return /(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)
}

async function trimPlanToTimeWindow(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
): Promise<TripPlan> {
  const allowedMinutes = getAllowedTripMinutes(input)
  if (!allowedMinutes || plan.stops.length <= 2) return normalizePlanTotalTime(plan)

  let nextPlan = normalizePlanTotalTime(plan)

  while (nextPlan.stops.length > 2 && shouldTrimTailStop(nextPlan, input)) {
    const stops = nextPlan.stops.slice(0, -1)
    const { segments } = await repairTransportSegments(
      nextPlan.transportSegments ?? [],
      stops,
      nextPlan.transportMode,
    )
    const candidatePlan = normalizePlanTotalTime({
      ...nextPlan,
      stops,
      transportSegments: segments,
    })

    if (!isAboveMinimumCoverage(candidatePlan, input)) break
    nextPlan = candidatePlan
  }

  return nextPlan
}

function shouldTrimTailStop(plan: TripPlan, input: GenerateTripPlansRequest['input']) {
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  if (!scheduleCapacityMinutes) return false

  const actualMinutes = getPlanActualDuration(plan)
  const tailStop = plan.stops[plan.stops.length - 1]
  if (!tailStop) return false

  return actualMinutes > scheduleCapacityMinutes || isWeakTailStop(tailStop)
}

function isWeakTailStop(stop: Stop) {
  return stop.duration < getMinimumMeaningfulStopDuration(stop)
}

function isAboveMinimumCoverage(plan: TripPlan, input: GenerateTripPlansRequest['input']) {
  const minimumMinutes = getMinimumRequiredActualMinutes(input)
  if (!minimumMinutes) return true

  return getPlanActualDuration(plan) >= minimumMinutes
}

function applyCandidateToStop(stop: Stop, candidate: VerifiedPlaceCandidate): Stop {
  const nextType = getStopTypeForCandidate(stop, candidate)

  return {
    ...stop,
    type: nextType,
    duration: Math.max(stop.duration, getMinimumStopDuration({ ...stop, type: nextType })),
    name: candidate.name,
    address: candidate.address,
    placeId: candidate.placeId,
    googleMapsUrl: candidate.googleMapsUrl,
    lat: candidate.lat,
    lng: candidate.lng,
  }
}

function getStopTypeForCandidate(stop: Stop, candidate: VerifiedPlaceCandidate): Stop['type'] {
  const candidateType = inferStopTypeFromCandidate(candidate)

  if (candidateType === 'food' || stop.type === 'food') return candidateType
  return stop.type
}

function expandStopsForLongTrip(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  planId?: string,
) {
  const minimumMinutes = getMinimumRequiredActualMinutes(input)
  if (!minimumMinutes) return stops
  const expansionTargetMinutes = getCoverageRepairTargetMinutes(input)

  const expandedStops = [...stops]
  const allCandidatePool = mergeCandidatePools(
    candidates.otherCandidates,
    candidates.firstStopCandidates,
    candidates.allCandidates,
  )
  const baseCandidatePool = preferNonShortVisitCandidates(allCandidatePool)
  const mainActivityPool = baseCandidatePool.filter(
    (candidate) => inferStopTypeFromCandidate(candidate) !== 'food',
  )
  const candidatePool = mainActivityPool.length > 0 ? mainActivityPool : baseCandidatePool
  let supplementalSelectionIndex = 0

  while (
    expandedStops.length < getMinimumStopCountForLongTrip(input) ||
    getReasonablePlanDuration(expandedStops) + estimateTransportTotal(expandedStops) < expansionTargetMinutes
  ) {
    const rotationOffset = getPlanDiversityOffset(planId, supplementalSelectionIndex)
    const nextCandidate =
      selectSupplementalCandidate(candidatePool, usedPlaceIds, rotationOffset) ??
      selectSupplementalCandidate(allCandidatePool, usedPlaceIds, rotationOffset)
    if (!nextCandidate) break

    supplementalSelectionIndex += 1
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

  if (expandedStops.length !== stops.length) {
    console.info('[coverage-supplemental-stops-added]', {
      originalStopCount: stops.length,
      expandedStopCount: expandedStops.length,
      targetMinutes: expansionTargetMinutes,
      estimatedMinutes: getReasonablePlanDuration(expandedStops) + estimateTransportTotal(expandedStops),
      candidateCount: allCandidatePool.length,
    })
  }

  return expandedStops
}

function mergeCandidatePools(...pools: VerifiedPlaceCandidate[][]) {
  const seen = new Set<string>()
  const merged: VerifiedPlaceCandidate[] = []

  for (const pool of pools) {
    for (const candidate of pool) {
      if (!candidate.placeId || seen.has(candidate.placeId)) continue
      seen.add(candidate.placeId)
      merged.push(candidate)
    }
  }

  return merged
}

function selectSupplementalCandidate(
  candidatePool: VerifiedPlaceCandidate[],
  usedPlaceIds: Set<string>,
  rotationOffset = 0,
) {
  const unusedCandidates = candidatePool.filter((candidate) => !usedPlaceIds.has(candidate.placeId))
  const nonShortCandidates = unusedCandidates.filter((candidate) => !isShortVisitCandidate(candidate))
  const pool = nonShortCandidates.length > 0 ? nonShortCandidates : unusedCandidates

  return pickRotatedItem(pool, rotationOffset)
}

function buildSupplementalStopId(input: GenerateTripPlansRequest['input'], index: number) {
  const prefix = input.category && input.category !== 'other' ? input.category : 'main'
  return `supplemental-${prefix}-${index}`
}

function inferStopTypeFromCandidate(candidate: VerifiedPlaceCandidate): Stop['type'] {
  if (isFoodCandidate(candidate)) return 'food'

  return 'main_activity'
}

function isFoodCandidate(candidate: VerifiedPlaceCandidate) {
  const types = candidate.types ?? []
  const text = `${candidate.name} ${candidate.address}`.toLocaleLowerCase('zh-TW')

  return (
    candidate.role === 'food' ||
    Boolean(candidate.foodSubtype) ||
    types.some((type) =>
      ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food', 'bar'].includes(type),
    ) ||
    /(餐廳|餐酒館|咖啡|甜點|小吃|早午餐|bistro|restaurant|coffee|cafe|brunch|dessert|bar)/i.test(text)
  )
}

function stretchPlanDurationToCoverage(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  if (!scheduleCapacityMinutes || plan.stops.length === 0) return normalizePlanTotalTime(plan)

  const targetMinutes = getCoverageRepairTargetMinutes(input)
  const currentMinutes = getPlanActualDuration(plan)
  const extraMinutes = targetMinutes - currentMinutes

  if (extraMinutes <= 0) return normalizePlanTotalTime(plan)

  const durations = plan.stops.map((stop) =>
    clamp(stop.duration, getMinimumStopDuration(stop), getMaximumStopDuration(stop)),
  )
  let remainingExtra =
    targetMinutes -
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

function shrinkPlanDurationToScheduleCapacity(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  if (!scheduleCapacityMinutes) return normalizePlanTotalTime(plan)

  let currentMinutes = getPlanActualDuration(plan)
  let excessMinutes = currentMinutes - scheduleCapacityMinutes
  if (excessMinutes <= 0) return normalizePlanTotalTime(plan)

  const durations = plan.stops.map((stop) => Math.round(stop.duration))
  const minimumDurations = plan.stops.map(getMinimumStopDuration)

  while (excessMinutes > 0) {
    const shrinkCandidates = durations
      .map((duration, index) => ({
        index,
        room: duration - minimumDurations[index],
      }))
      .filter((candidate) => candidate.room > 0)
      .sort((left, right) => right.room - left.room)

    if (shrinkCandidates.length === 0) break

    for (const candidate of shrinkCandidates) {
      if (excessMinutes <= 0) break
      const reduceMinutes = Math.min(candidate.room, 15, excessMinutes)
      durations[candidate.index] -= reduceMinutes
      excessMinutes -= reduceMinutes
    }
  }

  const nextPlan = normalizePlanTotalTime({
    ...plan,
    stops: plan.stops.map((stop, index) => ({
      ...stop,
      duration: durations[index],
    })),
  })

  currentMinutes = getPlanActualDuration(nextPlan)
  if (currentMinutes > scheduleCapacityMinutes) {
    console.info('[plan-duration-shrink-incomplete]', {
      planId: plan.id,
      actualMinutes: currentMinutes,
      scheduleCapacityMinutes,
    })
  }

  return nextPlan
}

function getPlanQualityIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  placesIssues: PlacesValidationResult['issues'],
) {
  const issues = [
    ...placesIssues.map(formatPlacesValidationIssue),
    ...getPlanRhythmIssues(plan, input),
  ]
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)

  if (scheduleCapacityMinutes) {
    const actualMinutes = getPlanActualDuration(plan)
    const minimumMinutes = getMinimumRequiredActualMinutes(input) ?? 0

    if (actualMinutes < minimumMinutes) {
      issues.push(
        `行程時長不足（目前 ${actualMinutes} 分鐘，至少需要 ${minimumMinutes} 分鐘）`,
      )
    }

    if (actualMinutes > scheduleCapacityMinutes) {
      issues.push(`行程超出可安排時間（目前 ${actualMinutes} 分鐘，最多 ${scheduleCapacityMinutes} 分鐘）`)
    }
  }

  return Array.from(new Set(issues))
}

function getHardPlanQualityIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  placesIssues: PlacesValidationResult['issues'],
) {
  const issues = placesIssues.map(formatPlacesValidationIssue)
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  const mealCoverageIssues = getRequiredMealCoverageIssues(plan, input)

  plan.stops.forEach((stop) => {
    if (stop.duration < getMinimumMeaningfulStopDuration(stop)) {
      issues.push(`${stop.name} 停留時間過短（${stop.duration} 分鐘）`)
    }
  })

  if (scheduleCapacityMinutes) {
    const actualMinutes = getPlanActualDuration(plan)
    const minimumMinutes = getMinimumRequiredActualMinutes(input) ?? 0

    if (actualMinutes < minimumMinutes) {
      issues.push(
        `行程時長不足（目前 ${actualMinutes} 分鐘，至少需要 ${minimumMinutes} 分鐘）`,
      )
    }

    if (actualMinutes > scheduleCapacityMinutes) {
      issues.push(`行程超出可安排時間（目前 ${actualMinutes} 分鐘，最多 ${scheduleCapacityMinutes} 分鐘）`)
    }
  }

  return Array.from(new Set([...issues, ...mealCoverageIssues]))
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

async function getOpeningHoursTimelineInput(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
): Promise<GenerateTripPlansRequest['input']> {
  const originalStartMinutes = parseTimeToMinutes(input.startTime)
  let endMinutes = parseTimeToMinutes(input.endTime)

  if (originalStartMinutes === null || endMinutes === null) return input
  if (endMinutes <= originalStartMinutes) endMinutes += 24 * 60

  const searchStartMinutes = getOpeningHoursSearchStartMinutes(originalStartMinutes, endMinutes)
  const resolution = await resolveOpeningHoursTimelineStart(plan, input, {
    earliestStartMinutes: searchStartMinutes,
    startStepMinutes: TIMELINE_START_GRANULARITY_MINUTES,
  })

  if (resolution.startMinutes === null) {
    console.info('[opening-hours-timeline-not-found]', {
      planId: plan.id,
      originalStart: formatMinutesAsTime(originalStartMinutes),
      searchStart: formatMinutesAsTime(searchStartMinutes),
      end: formatMinutesAsTime(endMinutes),
      issues: resolution.issues.map(formatOpeningHoursValidationIssue),
    })

    if (searchStartMinutes === originalStartMinutes) return input

    return {
      ...input,
      startTime: formatMinutesAsTime(searchStartMinutes),
    }
  }

  const timelineStartMinutes = resolution.startMinutes
  if (timelineStartMinutes === originalStartMinutes) return input

  console.info('[opening-hours-timeline-selected]', {
    planId: plan.id,
    originalStart: formatMinutesAsTime(originalStartMinutes),
    timelineStart: formatMinutesAsTime(timelineStartMinutes),
    end: formatMinutesAsTime(endMinutes),
    granularityMinutes: TIMELINE_START_GRANULARITY_MINUTES,
  })

  return {
    ...input,
    startTime: formatMinutesAsTime(timelineStartMinutes),
  }
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
    unknown_opening_hours: 'Google 營業時間未知',
    outside_opening_hours: '預計抵達時間不在 Google 營業時間內',
    maps_uri_missing: 'Google Maps 官方連結缺失',
  }

  return labelMap[reason] ?? reason
}

function formatPlacesValidationIssue(issue: PlacesValidationResult['issues'][number]) {
  const timeText =
    issue.arrivalTime && issue.leaveTime
      ? `（安排 ${issue.arrivalTime}-${issue.leaveTime}）`
      : ''
  const windowsText = issue.openingWindows?.length
    ? `，營業窗：${issue.openingWindows.join('；')}`
    : ''
  const distanceText =
    typeof issue.distanceKm === 'number' ? `（距離 ${issue.distanceKm.toFixed(1)}km）` : ''

  return `${issue.stopName}: ${formatPlacesValidationReason(issue.reason)}${timeText}${distanceText}${windowsText}`
}

function formatOpeningHoursValidationIssue(issue: OpeningHoursValidationIssue) {
  const timeText =
    issue.arrivalTime && issue.leaveTime
      ? `（安排 ${issue.arrivalTime}-${issue.leaveTime}）`
      : ''
  const windowsText = issue.openingWindows?.length
    ? `，營業窗：${issue.openingWindows.join('；')}`
    : ''

  return `${issue.stopName}: ${formatPlacesValidationReason(issue.reason)}${timeText}${windowsText}`
}

function writeGenerateDebugLog(event: string, payload: unknown) {
  if (process.env.NODE_ENV === 'production') return

  try {
    appendFileSync(
      GENERATE_DEBUG_LOG_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        payload,
      })}\n`,
      'utf8',
    )
  } catch {
    // Debug logging must never affect trip generation.
  }
}

function logMissingPlanSummary(
  missingPlanIds: readonly string[],
  validationSummaries: Map<string, string[]>,
  finalPlans: TripPlan[],
  candidates: NearbyPlaceCandidates,
) {
  const missingPlanPayload = {
    missingPlanIds,
    shownPlanIds: finalPlans.map((plan) => plan.id),
    reasons: missingPlanIds.map((planId) => ({
      planId,
      label: getPlanLabel(planId),
      issues: validationSummaries.get(planId) ?? ['沒有取得可驗收補案'],
    })),
    candidatePool: {
      firstStop: candidates.firstStopCandidates.length,
      other: candidates.otherCandidates.length,
      all: candidates.allCandidates.length,
      food: candidates.allCandidates.filter((candidate) => candidate.role === 'food').length,
      mainActivity: candidates.allCandidates.filter((candidate) =>
        ['main_activity', 'open_space', 'shopping'].includes(candidate.role ?? ''),
      ).length,
    },
  }
  console.warn('[plan-refill-missing]', missingPlanPayload)
  writeGenerateDebugLog('plan-refill-missing', missingPlanPayload)
}

function buildNoAvailablePlansMessage(validationSummaries: Map<string, string[]>) {
  const reasons = formatValidationSummaryForLog(validationSummaries)
  if (reasons.length === 0) {
    return '這次沒有找到符合營業時間的可用方案，但後端沒有取得明確排除原因。請重新分析一次。'
  }

  return `這次 3 個方案都在最終驗證被排除：${reasons
    .slice(0, 3)
    .map((reason) => `${reason.label}：${reason.issues.join('、')}`)
    .join('；')}`
}

function formatValidationSummaryForLog(validationSummaries: Map<string, string[]>) {
  return PLAN_IDS.map((planId) => ({
    planId,
    label: getPlanLabel(planId),
    issues: validationSummaries.get(planId) ?? ['沒有留下排除原因'],
  }))
}

function logOpeningHoursIssues(planId: string, issues: OpeningHoursValidationIssue[]) {
  const openingHoursPayload = {
    planId,
    issues: issues.map((issue) => ({
      stop: issue.stopName,
      arrival: issue.arrivalTime,
      leave: issue.leaveTime,
      windows: issue.openingWindows,
    })),
  }
  console.warn(`[opening-hours] plan=${planId} excluded`, openingHoursPayload.issues)
  writeGenerateDebugLog('opening-hours-excluded', openingHoursPayload)
}

function logPlanQualitySummary(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  phase: string,
) {
  const allowedMinutes = getAllowedTripMinutes(input)
  const transportMinutes = (plan.transportSegments ?? []).reduce(
    (total, segment) => total + segment.duration,
    0,
  )
  const actualMinutes = getPlanActualDuration(plan)
  const issues = getPlanRhythmIssues(plan, input)

  console.info(
    `[plan-quality] phase=${phase} plan=${plan.id}`,
    {
      actualMinutes,
      allowedMinutes,
      stopCount: plan.stops.length,
      transportMinutes,
      transportRatio: actualMinutes > 0 ? Math.round((transportMinutes / actualMinutes) * 100) / 100 : 0,
      stops: plan.stops.map((stop) => ({
        name: stop.name,
        type: stop.type,
        duration: stop.duration,
        role: inferStopRhythmRole(stop),
      })),
      issues,
    },
  )
}

function logSoftPlanQualityIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  placesIssues: PlacesValidationResult['issues'],
  phase: string,
) {
  const allIssues = getPlanQualityIssues(plan, input, placesIssues)
  const blockingIssues = new Set(getHardPlanQualityIssues(plan, input, placesIssues))
  const softIssues = allIssues.filter((issue) => !blockingIssues.has(issue))

  if (softIssues.length === 0) return

  console.info('[plan-quality-soft]', {
    phase,
    planId: plan.id,
    issues: softIssues,
  })
}

function logPlanOverlapForDiagnostics(
  plan: TripPlan,
  existingPlans: TripPlan[],
  phase: string,
) {
  const overlappingPlanIds = existingPlans
    .filter((existingPlan) => arePlansOverlapping(plan, existingPlan))
    .map((existingPlan) => existingPlan.id)

  if (overlappingPlanIds.length === 0) return

  console.info('[plan-duplicate-diagnostic]', {
    phase,
    planId: plan.id,
    overlappingPlanIds,
  })
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

function extractFinishReasonFromSseEvent(rawEvent: string) {
  const lines = rawEvent.split('\n')

  for (const line of lines) {
    if (!line.startsWith('data:')) continue

    const payload = line.slice(5).trimStart()
    if (!payload || payload === '[DONE]') continue

    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          finish_reason?: string | null
        }>
      }
      const finishReason = parsed.choices?.[0]?.finish_reason
      if (finishReason) return finishReason
    } catch {
      // Ignore unparseable SSE frames.
    }
  }

  return null
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

function createUserScopedSupabaseClient(accessToken: string): PointsSupabaseClient {
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
  }) as unknown as PointsSupabaseClient
}

async function getAvailablePoints(
  supabase: PointsSupabaseClient,
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

      req.setTimeout(SUPABASE_FETCH_TIMEOUT_MS, () => {
        req.destroy(new Error('Supabase request timed out'))
      })
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
