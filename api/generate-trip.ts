/// <reference types="node" />
import { recordAiDurations, traceDurationPlan, traceDurationStops, recordCoverageShadow } from './_lib/trip-coverage-v2.js'

import https from 'node:https'
import { requireAuthenticatedUser, handleApiOptions } from './_lib/authenticated-user.js'
import { claimGeneration, createGenerationStore, generationInput, isGenerationId, readGeneration } from './_lib/trip-generations.js'
import { appendFileSync } from 'node:fs'
import { buildTripPrompt, buildRetryTripSkeletonPrompt, parseTripPlanSkeletonResponse } from '../src/services/ai/tripPlanPrompt.js'
import { getTripPlanStyleLabel, normalizeTripPlanIdentity, normalizeTripPlanIdentities } from '../src/services/ai/tripPlanIdentity.js'
import { getMealSuitabilityRank, MEAL_SUITABILITY_PROMPT_RULE } from '../src/services/ai/mealSuitability.js'
import { compareOriginalActivities, getActivityPurpose } from './_lib/trip-activity-purpose.js'
import { finalizePlanText, rememberPlanTextTransition } from './_lib/trip-plan-text-consistency.js'
import { buildIntentCandidateGrounding } from './_lib/trip-intent-candidate-grounding.js'
import { assessVisitRequirements, filterDemandCandidates, getForbiddenVisitIssues,
  getVisitRequirementWarnings, getVisitRequirementContentText, preservesCoreVisitRequirements,
  isForbiddenStop, visitRequirementEvidence } from './_lib/trip-demand-compliance.js'
import { withAcceptanceEvidence, evidenceAiFetch, observeEvidenceCall, recordAiModelText,
  recordRawAiPlan, recordAiUsage, recordAiStreamUsage, bindEvidencePlan, recordEvidenceDecision,
  recordEvidencePoints, recordEvidenceProfile, recordEvidencePlanDecision, bindLocalEvidencePlan,
  recordEvidenceDelivery, carryEvidencePlan } from './_lib/trip-acceptance-evidence.js'
import { recordCapacityDurationLoss, proposeStopDurationRedistribution,
  getDurationRedistributionIssues, type CapacityDurationLoss } from './_lib/trip-stop-duration-quality.js'
import { compareFoodPurposes, getFoodPurposeHint, hasFoodPurposeConflict, recordFoodReplacement,
  type FoodPurposeProvenance } from './_lib/trip-food-purpose.js'
import { tripPlanSkeletonResponseSchema } from '../src/services/ai/tripPlanResponseSchema.js'
import type {
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  Persona,
} from '../src/services/ai/types.js'
import { createClient } from '@supabase/supabase-js'
import {
  FIRST_STOP_MAX_DISTANCE_KM,
  hasConfirmedCulturalPrimaryPurpose,
  calculateDistance,
  validateStopsWithPlaces,
  validatePlanOpeningHours,
  resolveOpeningHoursTimelineStart,
  isCandidateOpenForVisit,
  getNearbyPlaceCandidates,
  resolveLocation,
  formatNearbyRecommendations,
  getPromptCandidateSelection,
  type OpeningHoursValidationIssue,
  type PlacesValidationResult,
  type NearbyPlaceCandidates,
  type VerifiedPlaceCandidate,
} from './_lib/google-places.js'
import {
  createTripCandidateDebugSession,
  writeTripCandidateDebugReport,
  type TripCandidateDebugSession,
} from './_lib/trip-candidate-debug.js'
import { loadServerPreferenceProfile } from './_lib/server-personalization-profile.js'
import type { DiagnosticStageContext } from './_lib/trip-quality-diagnostics.js'
import { repairTransportSegments } from './_lib/google-routes.js'
import { chooseSupplementalInsertion, createSupplementRouteContext, createRepairRouteResolver,
  resolveMealComparisonRoutes, SUPPLEMENT_SIMILAR_SCORE_TOLERANCE,
  hasReusableStaticRouteTimings,
  type SupplementRouteContext } from './_lib/trip-supplement-quality.js'
import {
  PLAN_IDS,
  TIMELINE_START_GRANULARITY_MINUTES,
  POST_TIMING_ALIGNMENT_MAX_PASSES,
  MINIMUM_MEAL_DURATION_MINUTES,
  clamp,
  formatMinutesAsTime,
  getAllowedTripMinutes,
  getCoverageBasisMinutes,
  getMealInsertionTargetMinutes,
  getMinimumRequiredActualMinutes,
  getOpeningHoursSearchStartMinutes,
  getRequiredMealWindows,
  getScheduleCapacityMinutes,
  isStopAlignedWithMealWindow,
  parseTimeToMinutes,
  type PlanId,
  type RequiredMealWindow,
} from './_lib/trip-planning-rules.js'
import {
  estimateTransportTotal,
  getDefaultStopDuration,
  getMaximumStopDuration,
  getMinimumStopDuration,
  getPlanActualDuration,
  getReasonableStopDuration,
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
  pickRotatedItem,
} from './_lib/trip-repair-strategy.js'
import type { Stop, TripInput, TripPlan } from '../src/types/trip.js'

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
  on?: (event: string, listener: () => void) => void
  writableEnded?: boolean
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
        order: (column: string, options: { ascending: boolean }) => {
          limit: (count: number) => Promise<{
            data: Record<string, unknown>[] | null
            error: { message: string } | null
          }>
        }
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
// Product rule: this is a dawn tail tolerance, not a general coverage backfill.
// It only applies to cross-day trips ending from 05:30 through 07:00, and only
// after final repair still fails because a tail stop violates opening-hours or
// the closing buffer. Opening-hours validation and the closing buffer must stay
// intact; daytime trips and ordinary coverage shortfalls should not use this.
// Early-morning departures such as 03:00 -> noon still use the separate
// early-morning active window. If they need better gaps later, design a
// structured waiting_for_opening_hours block instead of expanding this rule.
const DAWN_CROSS_DAY_END_START_MINUTES = 5 * 60 + 30
const DAWN_CROSS_DAY_END_END_MINUTES = 7 * 60
const DAWN_TAIL_COVERAGE_SHORTFALL_ALLOWANCE_MINUTES = 60
const DAWN_TAIL_NEAR_END_MINUTES = 90

type DeliveryPlanIssueOptions = {
  coverageShortfallAllowanceMinutes?: number
  candidates?: NearbyPlaceCandidates
  skipMealCoverage?: boolean
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return withAcceptanceEvidence(req.body, res, sink => generateTrip(req, sink))
}

async function generateTrip(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (handleApiOptions(req.method, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const auth = await observeEvidenceCall('supabase', () => requireAuthenticatedUser(req.headers?.authorization, res))
  if (!auth) return
  const body = parseRequestBody(req.body)
  const input = generationInput(body?.input)
  if (!body || !input || !isGenerationId(body.generationId)) {
    res.status(400).json({ error: '行程偏好資料不完整，請回到表單重新送出。' })
    return
  }

  const generationId = body.generationId
  if (getAllowedTripMinutes(input) === 0) {
    res.status(400).json({ error: '開始時間與結束時間不可相同。' })
    return
  }

  let store: ReturnType<typeof createGenerationStore>
  let attemptToken: string
  try {
    store = createGenerationStore()
    const claim = await claimGeneration(store, auth.userId, generationId, input)
    if (claim.outcome === 'completed') { res.status(200).json(claim.response); return }
    if (claim.outcome === 'missing') { res.status(404).json({ error: '找不到這筆生成。' }); return }
    if (claim.outcome === 'input_mismatch') { res.status(409).json({ error: '生成編號與原始輸入不符，請開始新一次生成。' }); return }
    if (claim.outcome === 'running') {
      res.setHeader('Retry-After', '3')
      res.status(202).json({ generationId: generationId, status: 'running', leaseExpiresAt: claim.leaseExpiresAt })
      return
    }
    if (claim.outcome !== 'claimed' || !isGenerationId(claim.attemptToken)) throw new Error('Invalid claim')
    attemptToken = claim.attemptToken
  } catch {
    res.status(503).json({ error: '付款狀態暫時無法確認，請稍後查詢原生成編號。' })
    return
  }

  const controller = new AbortController()
  if (req.signal?.aborted) controller.abort()
  const abort = () => controller.abort()
  req.signal?.addEventListener('abort', abort, { once: true })
  res.on?.('close', () => { if (!res.writableEnded) controller.abort() })
  let commitStarted = false
  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) { res.status(500).json({ error: '行程生成服務設定不完整。' }); return }
    const supabase = createUserScopedSupabaseClient(auth.accessToken)
    const balance = await getAvailablePoints(supabase)
    if (balance < ANALYSIS_COST) {
      res.status(402).json({ error: `點數不足。每次分析需要 ${ANALYSIS_COST} 點，目前剩餘 ${balance} 點。` })
      return
    }
    controller.signal.throwIfAborted()
    await runTripGeneration({ ...req, signal: controller.signal }, res, { input }, supabase, auth.userId, apiKey, async response => {
      // Serialize the final Validation/Repair/text version before starting the transaction.
      const snapshot = JSON.parse(JSON.stringify(response)) as GenerateTripPlansResponse
      controller.signal.throwIfAborted()
      commitStarted = true
      recordEvidencePoints('attempted', ANALYSIS_COST)
      try {
        const { data, error } = await store.rpc('complete_paid_trip_generation', {
          p_user_id: auth.userId, p_generation_id: generationId, p_attempt_token: attemptToken, p_response: snapshot,
        })
        if (error || !data) throw new Error('Commit unconfirmed')
        recordEvidencePoints('rpc_confirmed', ANALYSIS_COST)
        return data as GenerateTripPlansResponse
      } catch {
        // A timeout may have happened AFTER commit. Never mark failed or change the ID.
        const saved = await readGeneration(store, auth.userId, generationId)
        if (saved?.status === 'completed' && saved.response) return saved.response
        recordEvidencePoints('rpc_failed', ANALYSIS_COST)
        throw new Error('付款與保存尚未確認，請使用原生成編號恢復；不會交付未付款行程。')
      }
    })
  } catch {
    if (!controller.signal.aborted) res.status(503).json({ error: '生成服務暫時無法使用，請使用原生成編號重試。' })
  } finally {
    req.signal?.removeEventListener('abort', abort)
    if (!commitStarted) {
      // Fenced failure cannot clear a newer worker or a completed payment.
      try { await store.rpc('fail_trip_generation', { p_user_id: auth.userId, p_generation_id: generationId, p_attempt_token: attemptToken }) } catch { /* Lease permits recovery after a database outage. */ }
    }
  }
}

async function runTripGeneration(req: VercelRequest, res: VercelResponse, request: GenerateTripPlansRequest,
  supabase: PointsSupabaseClient, userId: string, apiKey: string,
  complete: (response: GenerateTripPlansResponse) => Promise<GenerateTripPlansResponse>) {
  // 若缺乏座標但有地名（手動輸入起點），先進行解析以補齊座標，否則搜尋會缺乏地理偏好
  let locationWarning = ''
  if (
    (!request.input.location.lat || !request.input.location.lng) &&
    request.input.location.name
  ) {
    console.debug('[trip-location-source]', {
      at: new Date().toISOString(),
      source: 'geocoding',
      label: request.input.location.name,
    })
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
  const preferenceProfile = await loadServerPreferenceProfile(supabase, userId)
  recordEvidenceProfile(persona.stamina, preferenceProfile.sampleCount, (preferenceProfile.foodSubtypeScores.cafe ?? 0) > 0)

  // 9D-7: 智慧前置搜尋 (Search-Inject)
  if (!request.input.location.lat || !request.input.location.lng) {
    console.debug('[trip-location-source]', {
      at: new Date().toISOString(),
      source: 'fallback blocked',
      label: request.input.location.name,
    })
    res.status(422).json({ error: '無法解析起點位置，請改用更完整的台灣地址或地標。' })
    return
  }

  console.debug('[trip-generate-start-location]', {
    at: new Date().toISOString(),
    lat: request.input.location.lat,
    lng: request.input.location.lng,
    label: request.input.location.name,
  })

  const candidateDebugSession = createTripCandidateDebugSession(request.input)
  const nearbyPlaceCandidates = await getNearbyPlaceCandidates({
    ...request,
    persona,
  }, candidateDebugSession ?? undefined, { preferenceProfile })
  candidateDebugSession?.recordCandidateSets(nearbyPlaceCandidates)
  candidateDebugSession?.recordAiInput(getPromptCandidateSelection(nearbyPlaceCandidates))
  const nearbyPlaces = [formatNearbyRecommendations(nearbyPlaceCandidates),
    buildIntentCandidateGrounding(request.input, nearbyPlaceCandidates)].filter(Boolean).join('\n\n')
  if (nearbyPlaceCandidates.allCandidates.length === 0) {
    const message = '目前這個時間窗附近沒有可驗證且營業時間已知的候選地點，系統不會用 AI 自創地點硬湊方案。請調整開始時間或拉長行程後再試。'
    writeGenerateDebugLog('candidate-pool-empty-aborted', {
      startTime: request.input.startTime,
      endTime: request.input.endTime,
      location: request.input.location,
    })
    writeTripCandidateDebugReport(
      candidateDebugSession,
      [],
      new Map(),
      'candidate_pool_empty',
      { log: (label, report) => console.info(label, report) },
    )
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
    writeTripCandidateDebugReport(
      candidateDebugSession,
      [],
      new Map(),
      'first_stop_candidate_pool_empty',
      { log: (label, report) => console.info(label, report) },
    )
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
    req.signal?.throwIfAborted()
    res.write(`${JSON.stringify(event)}\n`)
    recordEvidenceDelivery(event)
  }

  try {
    const openAiResponse = await evidenceAiFetch('initial', PLAN_IDS, 'https://api.openai.com/v1/chat/completions', {
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
      writeTripCandidateDebugReport(
        candidateDebugSession,
        [],
        new Map(),
        'openai_request_failed',
        { log: (label, report) => console.info(label, report) },
      )
      writeEvent({ event: 'error', message })
      res.end()
      return
    }

    const extractor = new PlanExtractor()
    const streamedPlanTypes = new Set<string>()
    let fullText = ''
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
        recordAiStreamUsage(openAiResponse, rawEvent)
        const delta = extractDeltaFromSseEvent(rawEvent)
        const finishReason = extractFinishReasonFromSseEvent(rawEvent)
        if (finishReason) streamFinishReasons.push(finishReason)
        if (!delta) continue

        fullText += delta
        const plans = extractor.push(delta)

        for (const rawPlan of plans) {
          recordRawAiPlan(openAiResponse, rawPlan)
          const plan = normalizeTripPlanIdentity(rawPlan)
          if (!plan || streamedPlanTypes.has(plan.type)) continue
          bindEvidencePlan(openAiResponse, plan)
          streamedPlanTypes.add(plan.type)
          const bias = request.input.location.lat && request.input.location.lng
            ? { lat: request.input.location.lat, lng: request.input.location.lng }
            : undefined

          const groundedPlan = applyCandidateGroundingToPlan(
            plan as TripPlan,
            nearbyPlaceCandidates,
          )
          candidateDebugSession?.recordPlanTransition(plan as TripPlan, groundedPlan, 'stream:grounding')
          const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
          candidateDebugSession?.recordValidation(groundedPlan, validation, 'stream')
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
          if (!getForbiddenVisitIssues(validatedPlan, request.input, nearbyPlaceCandidates).length) {
            writeEvent({ event: 'progress', style: validatedPlan.type, stage: 'validating' })
          }
        }
      }
    }

    if (sseBuffer.trim()) {
      recordAiStreamUsage(openAiResponse, sseBuffer)
      const delta = extractDeltaFromSseEvent(sseBuffer)
      const finishReason = extractFinishReasonFromSseEvent(sseBuffer)
      if (finishReason) streamFinishReasons.push(finishReason)
      if (delta) {
        fullText += delta
        const plans = extractor.push(delta)

        for (const rawPlan of plans) {
          recordRawAiPlan(openAiResponse, rawPlan)
          const plan = normalizeTripPlanIdentity(rawPlan)
          if (!plan || streamedPlanTypes.has(plan.type)) continue
          bindEvidencePlan(openAiResponse, plan)
          streamedPlanTypes.add(plan.type)
          const bias = request.input.location.lat && request.input.location.lng
            ? { lat: request.input.location.lat, lng: request.input.location.lng }
            : undefined

          const groundedPlan = applyCandidateGroundingToPlan(
            plan as TripPlan,
            nearbyPlaceCandidates,
          )
          candidateDebugSession?.recordPlanTransition(plan as TripPlan, groundedPlan, 'stream-tail:grounding')
          const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
          candidateDebugSession?.recordValidation(groundedPlan, validation, 'stream-tail')
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
          if (!getForbiddenVisitIssues(validatedPlan, request.input, nearbyPlaceCandidates).length) {
            writeEvent({ event: 'progress', style: validatedPlan.type, stage: 'validating' })
          }
        }
      }
    }

    let finalResponse: GenerateTripPlansResponse
    let initialDiagnosticPhase = 'initial-ai-output'
    try {
      try {
        recordAiModelText(openAiResponse, fullText)
        finalResponse = parseTripPlanSkeletonResponse(fullText)
        finalResponse.plans.forEach(plan => bindEvidencePlan(openAiResponse, plan))
      } catch {
        if (validatedPlans.length > 0) {
          initialDiagnosticPhase = 'initial-stream-validation-fallback'
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
          initialDiagnosticPhase = 'initial-json-repair-ai-output'
        }
      }

      if (!finalResponse || !Array.isArray(finalResponse.plans)) {
        finalResponse = { plans: validatedPlans || [], warnings: [] }
      }
      candidateDebugSession?.recordAiOutput(finalResponse.plans, initialDiagnosticPhase)

      for (const plan of finalResponse.plans) {
        const bias = request.input.location.lat && request.input.location.lng
          ? { lat: request.input.location.lat, lng: request.input.location.lng }
          : undefined
        const groundedPlan = applyCandidateGroundingToPlan(
          plan as TripPlan,
          nearbyPlaceCandidates,
        )
        candidateDebugSession?.recordPlanTransition(plan as TripPlan, groundedPlan, 'final-parse:grounding')
        const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
        candidateDebugSession?.recordValidation(groundedPlan, validation, 'final-parse')
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
          const retryResponse = await evidenceAiFetch('retry', invalidPlanIds, 'https://api.openai.com/v1/chat/completions', {
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
                  schema: buildTripPlanRefillResponseSchema(invalidPlanIds.length),
                },
              },
            }),
          })

          if (retryResponse.ok) {
            const retryData = (await retryResponse.json()) as {
              choices: Array<{ message: { content: string } }>
            }
            recordAiUsage(retryResponse, retryData)
            recordAiModelText(retryResponse, retryData.choices?.[0]?.message?.content)
            const retryText = retryData.choices[0].message.content
            const retryParsed = parseTripPlanSkeletonResponse(retryText)
            retryParsed.plans.forEach(plan => bindEvidencePlan(retryResponse, plan))
            candidateDebugSession?.recordAiOutput(retryParsed.plans, 'retry-ai-output')

            for (const plan of retryParsed.plans) {
              if (invalidPlanIds.includes(plan.id)) {
                const bias = request.input.location.lat && request.input.location.lng
                  ? { lat: request.input.location.lat, lng: request.input.location.lng }
                  : undefined
                const groundedPlan = applyCandidateGroundingToPlan(
                  plan as TripPlan,
                  nearbyPlaceCandidates,
                )
                candidateDebugSession?.recordPlanTransition(plan as TripPlan, groundedPlan, 'retry:grounding')
                const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
                candidateDebugSession?.recordValidation(groundedPlan, validation, 'retry')
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
      finalResponse.plans = normalizeTripPlanIdentities(finalResponse.plans)

      const finalRepairResults: Array<{
        sourcePlan: TripPlan
        plan: TripPlan | null
        routesFailed: boolean
        issues: string[]
      }> = []
      const crossPlanUsedPlaceIds = new Set<string>()
      const sortedFinalPlans = (finalResponse.plans || []).sort(comparePlansByDisplayPriority)
      for (const plan of sortedFinalPlans) {
        const result = await repairAndValidatePlanForDelivery(
          plan,
          request.input,
          nearbyPlaceCandidates,
          new Set(),
          'final-repair',
          crossPlanUsedPlaceIds,
          candidateDebugSession ?? undefined,
          persona.stamina,
        )

        finalRepairResults.push({
          sourcePlan: plan,
          ...result,
        })
        recordEvidencePlanDecision(plan, result.plan ? 'delivery_accepted_provisional' : 'delivery_rejected', result.issues)
        if (result.plan) {
          getPlanPlaceIds(result.plan).forEach((placeId) => crossPlanUsedPlaceIds.add(placeId))
        }
      }

      const openingHoursSafePlans: TripPlan[] = []
      for (const repairResult of finalRepairResults) {
        candidateDebugSession?.recordRepair(
          repairResult.sourcePlan,
          repairResult.plan,
          repairResult.issues,
          'final-repair',
        )
        if (repairResult.routesFailed) routesApiFailed = true
        if (!repairResult.plan) {
          validationSummaries.set(repairResult.sourcePlan.id, repairResult.issues)
          continue
        }
        logPlanOverlapForDiagnostics(repairResult.plan, openingHoursSafePlans, 'final-repair')
        openingHoursSafePlans.push(repairResult.plan)
      }
      finalResponse.plans = openingHoursSafePlans

      if (PLAN_IDS.some(planId => !finalResponse.plans.some(plan => plan.id === planId && plan.type === planId))) {
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
              candidateDebugSession?.recordAiOutput(retryPlans, 'refill-ai-output')
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
                carryEvidencePlan(plan, normalizedRetryPlan)

                const bias = request.input.location.lat && request.input.location.lng
                  ? { lat: request.input.location.lat, lng: request.input.location.lng }
                  : undefined
                const groundedPlan = applyCandidateGroundingToPlan(
                  normalizedRetryPlan,
                  nearbyPlaceCandidates,
                )
                candidateDebugSession?.recordPlanTransition(normalizedRetryPlan, groundedPlan, 'refill:grounding')
                const validation = await validateStopsWithPlanningTimeline(groundedPlan, bias, request.input)
                candidateDebugSession?.recordValidation(groundedPlan, validation, 'refill')
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
                  new Set(finalResponse.plans.flatMap(getPlanPlaceIds)),
                  candidateDebugSession ?? undefined,
                  persona.stamina,
                )
                candidateDebugSession?.recordRepair(
                  validatedPlan,
                  repairResult.plan,
                  repairResult.issues,
                  'refill-final-repair',
                )
                recordEvidencePlanDecision(validatedPlan, repairResult.plan ? 'delivery_accepted_provisional' : 'delivery_rejected', repairResult.issues)
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
            bindLocalEvidencePlan(localPlan)
            const repairResult = await repairAndValidatePlanForDelivery(
              localPlan,
              request.input,
              nearbyPlaceCandidates,
              new Set(),
              'local-refill-final-repair',
              new Set(finalResponse.plans.flatMap(getPlanPlaceIds)),
              candidateDebugSession ?? undefined,
              persona.stamina,
            )
            candidateDebugSession?.recordRepair(
              localPlan,
              repairResult.plan,
              repairResult.issues,
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

      finalResponse.plans = normalizeTripPlanIdentities(finalResponse.plans)

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
      const responseWarnings = finalResponse.warnings
      const demandWarningGroups = new Map<string, string[]>()
      finalResponse.plans = finalResponse.plans.map(plan => {
        const demandWarnings = getVisitRequirementWarnings(plan, request.input, nearbyPlaceCandidates)
        for (const warning of demandWarnings) {
          const styles = demandWarningGroups.get(warning) ?? []
          styles.push(getTripPlanStyleLabel(plan.type) ?? plan.type)
          demandWarningGroups.set(warning, styles)
        }
        return withVisitRequirementText(plan, demandWarnings, request.input, nearbyPlaceCandidates)
      })
      for (const [warning, styles] of demandWarningGroups) {
        const scope = styles.length === finalResponse.plans.length && styles.length > 1 ? '所有方案' : styles.join('、')
        const message = `${scope}：${warning}`
        if (!responseWarnings.includes(message)) responseWarnings.push(message)
      }
      if (!placesValidationPerformed) {
        finalResponse.warnings.push('Google Places 驗證未啟用，部分地點資訊可能不夠準確。')
      }
      if (routesApiFailed) {
        finalResponse.warnings.push('Google Routes API 未啟用或無法呼叫，請在 Google Cloud 啟用 Routes API；交通時間與距離已暫用系統估算值。')
        finalResponse.warnings.push('Google Routes API 未啟用，交通時間與距離為系統估算值。')
      }
      if (finalResponse.plans.length < PLAN_IDS.length) {
        finalResponse.warnings.push(
          `目前僅 ${finalResponse.plans.length} 個風格方案通過驗收；未能提供的風格：${unresolvedPlanIds.map(getTripPlanStyleLabel).join('、')}。`,
        )
      }

      writeTripCandidateDebugReport(
        candidateDebugSession,
        finalResponse.plans,
        validationSummaries,
        'completed',
        { log: (label, report) => console.info(label, report) },
      )
      validationSummaries.clear()

    } catch (error) {
      writeTripCandidateDebugReport(
        candidateDebugSession,
        validatedPlans,
        validationSummaries,
        'generation_failed',
        { log: (label, report) => console.info(label, report) },
      )
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

    finalResponse.plans = finalResponse.plans.map(plan => finalizePlanText(rememberPlanTextTransition(
      validatedPlans.find(previous => previous.id === plan.id) ?? plan, plan)))
    const savedResponse = await complete(finalResponse)
    // Preserve observation provenance across the persisted JSON snapshot boundary.
    for (const plan of savedResponse.plans) {
      const previous = finalResponse.plans.find(p => p.id === plan.id)
      if (previous) carryEvidencePlan(previous, plan)
    }
    finalResponse = savedResponse
    writeGenerateDebugLog('generate-trip-done', {
      planIds: finalResponse.plans.map((plan) => plan.id),
      planCount: finalResponse.plans.length,
      warnings: finalResponse.warnings ?? [],
    })
    for (const plan of finalResponse.plans) writeEvent({ event: 'plan', plan })
    writeEvent({ event: 'done', response: finalResponse })
    res.end()
  } catch (error) {
    writeTripCandidateDebugReport(
      candidateDebugSession,
      [],
      new Map(),
      'generation_failed',
      { log: (label, report) => console.info(label, report) },
    )
    writeEvent({
      event: 'error',
      message:
        error instanceof Error ? error.message : 'AI 分析失敗，請稍後再試。',
    })
    res.end()
  }
}

// Keep the AI skeleton outside response/schema fields and scoped to plan object lifetime.
const originalActivitySkeletons = new WeakMap<TripPlan, Stop[]>()
const foodPurposeProvenance = new WeakMap<TripPlan, FoodPurposeProvenance>()
const lastCoverageAttempt = new WeakMap<SupplementRouteContext, TripPlan>()
const durationRepairEvidence = new WeakMap<TripPlan, {
  losses: Map<string, CapacityDurationLoss>; routeContext: SupplementRouteContext
}>()
function carryOriginalActivities(source: TripPlan, target: TripPlan) {
  const originals = originalActivitySkeletons.get(source)
  if (originals) originalActivitySkeletons.set(target, originals)
  const foodTrace = foodPurposeProvenance.get(source)
  if (foodTrace) foodPurposeProvenance.set(target, foodTrace)
  const durationEvidence = durationRepairEvidence.get(source)
  if (durationEvidence) durationRepairEvidence.set(target, durationEvidence)
  return rememberPlanTextTransition(source, target)
}

// Neither provisional nor final text may claim an unconfirmed visit was achieved.
export function withVisitRequirementText(plan: TripPlan, warnings: string[], input?: TripInput,
  candidates?: NearbyPlaceCandidates) {
  const content = input ? getVisitRequirementContentText(plan, input, candidates) : ''
  let summary = input ? plan.summary.replace(/(?:^| )(?:已確認文化內容|文化內容說明)：[\s\S]*$/, '') : plan.summary
  // A previously emitted machine warning may survive a later successful repair.
  // Reassess it from this final plan instead of appending a contradictory success.
  if (input && !warnings.length && /^(?:未安排可確認符合「|已安排文化場館；目前僅有場館用途資料)/.test(summary)) {
    summary = '依下方地點與順序展開行程。'
  }
  if (!warnings.length && !content && summary === plan.summary) return plan
  return carryOriginalActivities(plan, { ...plan,
    ...(warnings.length ? { title: getTripPlanStyleLabel(plan.type) ?? plan.title,
      subtitle: '已依可用地點調整活動安排' } : {}),
    summary: [warnings.length ? warnings.join(' ') : summary, content].filter(Boolean).join(' '),
  })
}

export function getOriginalActivityImpact(source: TripPlan, finalStops: Stop[]) {
  return compareOriginalActivities(originalActivitySkeletons.get(source) ?? source.stops, finalStops)
}

export function getFoodPurposeImpact(source: TripPlan, finalStops: Stop[]) {
  const trace = foodPurposeProvenance.get(source)
  const baseline = trace?.baseline ?? source.stops
  const impact = compareFoodPurposes(baseline, finalStops)
  const changes = impact.changes.map(change => ({ ...change,
    reason: trace?.replacements.findLast(event => event.stopId === change.stopId &&
      event.toPlaceId === change.toPlaceId)?.reason ?? 'unknown' }))
  const raw = originalActivitySkeletons.get(source) ?? source.stops
  return { ...impact, changes, groundingCorrections: baseline.filter(stop => stop.type === 'food' &&
    raw.some(original => original.id === stop.id && original.placeId !== stop.placeId)).length,
    necessarySafetyReplacements: changes.filter(change => change.reason === 'safety').length,
    optionalFoodReplacements: changes.filter(change => change.reason === 'optional_diversity').length }
}

function logOriginalActivityImpact(source: TripPlan, final: TripPlan, phase: string) {
  const payload = { planId: source.id, phase, ...getOriginalActivityImpact(source, final.stops) }
  console.info('[original-activity-impact]', payload)
  writeGenerateDebugLog('original-activity-impact', payload)
  const foodPayload = { planId: source.id, phase, ...getFoodPurposeImpact(source, final.stops) }
  console.info('[food-purpose-impact]', foodPayload)
  writeGenerateDebugLog('food-purpose-impact', foodPayload)
  carryOriginalActivities(source, final)
}

function normalizePlanTotalTime(plan: TripPlan): TripPlan {
  return carryOriginalActivities(plan, {
    ...plan,
    totalTime: getPlanActualDuration(plan),
  })
}

function upsertValidatedPlan(plans: TripPlan[], nextPlan: TripPlan) {
  const existingIndex = plans.findIndex((plan) => plan.id === nextPlan.id)

  if (existingIndex >= 0) {
    plans[existingIndex] = rememberPlanTextTransition(plans[existingIndex], nextPlan)
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
  recordEvidenceDecision(planId, 'validation_rejected', issues)
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
  recordEvidenceDecision(planId, 'validation_accepted_provisional')
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
  return retryPlans.filter(plan => plan.id === missingPlanId && plan.type === missingPlanId)
}

function normalizeRefillPlanForMissingId(plan: TripPlan, missingPlanId: PlanId): TripPlan {
  const shouldReplaceTitle = hasPlanNumberTitle(plan.title)

  return {
    ...plan,
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
- Follow only the style tasks requested in this prompt; do not produce extra styles. Keep different plans meaningfully different. Avoid reusing the same placeId across different plans when there are viable alternatives, but reuse is allowed if the candidate pool is too constrained.
- ${MEAL_SUITABILITY_PROMPT_RULE}
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
  const retryResponse = await evidenceAiFetch('refill', planIds, 'https://api.openai.com/v1/chat/completions', {
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
  recordAiUsage(retryResponse, retryData)
  recordAiModelText(retryResponse, retryData.choices?.[0]?.message?.content)
  const parsedPlans = parseTripPlanSkeletonResponse(retryData.choices[0].message.content).plans
  parsedPlans.forEach(plan => bindEvidencePlan(retryResponse, plan))
  return parsedPlans
    .filter(plan => planIds.includes(plan.type))
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
  const response = await evidenceAiFetch('initial_json_repair', PLAN_IDS, 'https://api.openai.com/v1/chat/completions', {
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
  recordAiUsage(response, data)
  recordAiModelText(response, data.choices?.[0]?.message?.content)
  const choice = data.choices[0]
  if (choice?.finish_reason) {
    console.info('[trip-json-fallback-finish]', {
      phase,
      finishReason: choice.finish_reason,
    })
  }

  const parsed = parseTripPlanSkeletonResponse(choice.message.content)
  parsed.plans.forEach(plan => bindEvidencePlan(response, plan))
  return parsed
}

export function applyCandidateGroundingToPlan(
  plan: TripPlan,
  candidates: NearbyPlaceCandidates,
): TripPlan {
  recordAiDurations(plan)
  const grounded = {
    ...plan,
    stops: (plan.stops ?? []).map((stop, index) =>
      groundStopWithCandidate(stop, index, candidates),
    ),
    rainBackup: (plan.rainBackup ?? []).map((stop, index) =>
      groundStopWithCandidate(stop, index, candidates),
    ),
  }
  originalActivitySkeletons.set(grounded, originalActivitySkeletons.get(plan) ??
    plan.stops.map(stop => ({ ...stop, googleTypes: stop.googleTypes?.slice() })))
  foodPurposeProvenance.set(grounded, foodPurposeProvenance.get(plan) ?? {
    baseline: grounded.stops.map(stop => ({ ...stop, googleTypes: stop.googleTypes?.slice() })), replacements: [],
  })
  traceDurationPlan(plan, grounded, 'grounding')
  return rememberPlanTextTransition(plan, grounded)
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
  carryOriginalActivities(plan, placeResolution.validatedPlan)
  if (!placeResolution.validationPerformed || placeResolution.invalidCount > 0) {
    return placeResolution
  }

  const timelineInput = await getOpeningHoursTimelineInput(placeResolution.validatedPlan, input)
  const validation = await validateStopsWithPlaces(placeResolution.validatedPlan, bias, timelineInput)
  carryOriginalActivities(plan, validation.validatedPlan)

  return {
    ...validation,
    validatedPlan: annotatePlanScheduleStart(validation.validatedPlan, timelineInput.startTime),
  }
}

export async function repairPlanForDelivery(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string> = new Set(),
  options: { allowCoverageRepair?: boolean; crossPlanUsedPlaceIds?: Set<string>;
    routeContext?: SupplementRouteContext; skipActivitySupplement?: boolean;
    debugSession?: TripCandidateDebugSession; debugPhase?: string } = {},
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  // Filter at every entry, including recursive alternatives and fallbacks. An optional
  // diversity fallback can relax its own exclusions, never the user's prohibition.
  const sourceCandidates = candidates
  candidates = filterDemandCandidates(candidates, input)
  const debug = options.debugSession
  const attemptId = debug?.beginRepairAttempt(plan, options.debugPhase ?? 'repair')
  const diagnosticContext = debug ? { session: debug, stage: { attemptId } } : undefined
  const allowCoverageRepair = options.allowCoverageRepair ?? true
  const crossPlanUsedPlaceIds = options.crossPlanUsedPlaceIds ?? new Set<string>()
  const routeContext = options.routeContext ?? createSupplementRouteContext()
  routeContext.remedy.events.push({ kind: 'repair', outcome: 'attempt_started',
    details: `${options.debugPhase ?? 'repair'}:coverage=${allowCoverageRepair};skipSupplement=${Boolean(options.skipActivitySupplement)}` })
  const capacityLosses = new Map(durationRepairEvidence.get(plan)?.losses)
  const shrinkToCapacity = (value: TripPlan) => {
    const shrunk = shrinkPlanDurationToScheduleCapacity(value, input)
    recordCapacityDurationLoss(value, shrunk, capacityLosses)
    return shrunk
  }
  const resolveRoutes = createRepairRouteResolver(routeContext)
  // Capture verified place evidence before optional replacements, independently of the raw AI IDs.
  let foodTrace = foodPurposeProvenance.get(plan)
  if (!foodTrace) {
    foodTrace = { baseline: plan.stops.map((stop, index) => {
      const grounded = groundStopWithCandidate(stop, index, candidates)
      return { ...grounded, googleTypes: grounded.googleTypes?.slice() }
    }),
      replacements: [] }
    foodPurposeProvenance.set(plan, foodTrace)
  }
  const usedPlaceIds = new Set<string>()
  const foodTimelineInput = { ...input, scheduleStartTime: plan.scheduleStartTime }
  const requiredFoodMeals = getRequiredMealWindows(foodTimelineInput)
  const repairedStops = plan.stops.map((stop, index) => {
    const arrival = getEstimatedArrivalMinutesForStop(plan.stops, index,
      stop.type === 'food' ? foodTimelineInput : input, plan.transportSegments)
    const replacementHint = isForbiddenStop(stop, input, sourceCandidates) ? { ...stop,
      // A formerly verified, now forbidden venue must not take the missing-pool
      // preservation path in ensureStopHasVerifiedPlace.
      googleMapsUrl: undefined,
      type: stop.type === 'food' && !candidates.allCandidates.some(isFoodCandidate) ? 'main_activity' as const : stop.type,
    } : stop
    return ensureStopHasVerifiedPlace(
      replacementHint,
      index,
      candidates,
      usedPlaceIds,
      avoidedPlaceIds,
      crossPlanUsedPlaceIds,
      arrival,
      foodTrace,
      stop.type === 'food' && requiredFoodMeals.some(window =>
        isStopAlignedWithMealWindow(arrival, stop.duration, window)),
      input,
    )
  })
  traceDurationStops(plan.stops, repairedStops, 'replacement')
  const scheduleAlignedStops = allowCoverageRepair
    ? alignStopsWithCandidateAvailability(
        repairedStops,
        input,
        candidates,
        avoidedPlaceIds,
        crossPlanUsedPlaceIds,
        plan.transportSegments,
        foodTrace,
      )
    : repairedStops
  traceDurationStops(repairedStops, scheduleAlignedStops, 'opening_alignment')
  // Candidate replacement invalidates the old route. Resolve it before judging coverage.
  const initialRouteRepair = await resolveRoutes(
    plan.transportSegments, scheduleAlignedStops, plan.transportMode,
  )
  const routedPlan = normalizePlanTotalTime({
    ...plan, stops: scheduleAlignedStops, transportSegments: initialRouteRepair.segments,
  })
  debug?.recordPlanTransition(plan, routedPlan, 'repair:verified-replacements-and-routes', { attemptId })
  const capacity = getScheduleCapacityMinutes(input)
  const startedWithOverflow = Boolean(capacity && getPlanActualDuration(routedPlan) > capacity)
  const initialCapacityRepair = allowCoverageRepair
    ? await trimPlanToTimeWindow(shrinkToCapacity(routedPlan), input, resolveRoutes, diagnosticContext)
    : { plan: routedPlan, routesFailed: false }
  const canAddStops = allowCoverageRepair && !startedWithOverflow && !initialRouteRepair.routesFailed &&
    initialCapacityRepair.plan.stops.length === scheduleAlignedStops.length
  usedPlaceIds.clear()
  initialCapacityRepair.plan.stops.forEach((stop) => {
    if (stop.placeId) usedPlaceIds.add(stop.placeId)
  })
  // Resolve required meals and their real routes before offering spare capacity to ordinary additions.
  const mealRepair = allowCoverageRepair && !initialRouteRepair.routesFailed
    ? await repairRequiredMeals(initialCapacityRepair.plan, input, candidates, routeContext,
        canAddStops, crossPlanUsedPlaceIds)
    : { plan: initialCapacityRepair.plan, routesFailed: false }
  const mealStops = mealRepair.plan.stops
  const mealRoutes = { segments: mealRepair.plan.transportSegments, routesFailed: mealRepair.routesFailed }
  // Keep coverage/capacity based on the original request, but carry the resolved meal timeline.
  input = Object.assign({}, input, { scheduleStartTime: mealRepair.plan.scheduleStartTime })
  const mealCapacityRepair = allowCoverageRepair
    ? await trimPlanToTimeWindow(shrinkToCapacity(normalizePlanTotalTime({
        ...mealRepair.plan, stops: mealStops, transportSegments: mealRoutes.segments,
      })), input, resolveRoutes, diagnosticContext)
    : initialCapacityRepair
  debug?.recordPlanTransition(routedPlan, mealCapacityRepair.plan, 'repair:capacity-and-required-meals', { attemptId,
    reason: 'existing_capacity_meal_and_availability_repairs_substep_unknown' })
  const preExpansionPlan = canAddStops && !mealRoutes.routesFailed
    ? extendExistingActivitiesToMinimum(mealCapacityRepair.plan, input, candidates)
    : mealCapacityRepair.plan
  debug?.recordPlanTransition(mealCapacityRepair.plan, preExpansionPlan, 'repair:coverage-existing-activities', {
    attemptId, reason: 'minimum_required_actual_minutes',
  })
  usedPlaceIds.clear()
  preExpansionPlan.stops.forEach(stop => { if (stop.placeId) usedPlaceIds.add(stop.placeId) })
  const expansionResult = canAddStops && !mealRoutes.routesFailed && !options.skipActivitySupplement
    ? await expandStopsForLongTrip(
        preExpansionPlan.stops,
        input,
        candidates,
        usedPlaceIds,
        plan.id,
        crossPlanUsedPlaceIds,
        preExpansionPlan.transportSegments,
        plan.transportMode,
        routeContext,
      )
    : {
        stops: preExpansionPlan.stops,
        segments: preExpansionPlan.transportSegments,
        routesFailed: false,
      }
  traceDurationStops(preExpansionPlan.stops, expansionResult.stops, 'replacement')
  const expandedStops = expansionResult.stops
  const deliveryStops = expandedStops
  const temporallyAlignedStops = allowCoverageRepair
    ? realignFoodStopsForMealWindows(
        deliveryStops, input,
        haveStopOrderChanged(expandedStops, deliveryStops) ? undefined : expansionResult.segments,
      )
    : deliveryStops
  traceDurationStops(expandedStops, temporallyAlignedStops, 'meal_alignment')
  const { segments: repairedSegments, routesFailed } = haveStopRouteEndpointsChanged(
    expandedStops, temporallyAlignedStops,
  )
    ? await resolveRoutes(
        expansionResult.segments, temporallyAlignedStops, plan.transportMode,
      )
    : expansionResult
  const repairedRainBackup = (plan.rainBackup ?? []).map((stop, index) =>
    ensureStopHasVerifiedPlace(stop, index, candidates, usedPlaceIds),
  )
  const { segments: repairedRainSegments } = await resolveRoutes(
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
  const coverageRepairedPlan = allowCoverageRepair && !isAboveMinimumCoverage(routeRepairedPlan, input)
    ? stretchPlanDurationToCoverage(routeRepairedPlan, input)
    : normalizePlanTotalTime(routeRepairedPlan)
  debug?.recordPlanTransition(preExpansionPlan, routeRepairedPlan, 'repair:expansion-and-meal-alignment', { attemptId })
  debug?.recordPlanTransition(routeRepairedPlan, coverageRepairedPlan, 'repair:coverage-target', {
    attemptId, reason: 'coverage_repair_target_minutes',
  })
  const capacityRepairedPlan = allowCoverageRepair
    ? shrinkToCapacity(coverageRepairedPlan)
    : coverageRepairedPlan
  const trimResult = allowCoverageRepair
    ? await trimPlanToTimeWindow(capacityRepairedPlan, input, resolveRoutes, diagnosticContext)
    : { plan: coverageRepairedPlan, routesFailed: false }
  const trimmedPlan = trimResult.plan
  const postCoverageMealAlignment = allowCoverageRepair
    ? await realignPlanMealsAfterTiming(trimmedPlan, input, resolveRoutes)
    : { plan: trimmedPlan, routesFailed: false }
  const postTimingAlignment = allowCoverageRepair
    ? await realignPlanCandidatesAfterTiming(
        postCoverageMealAlignment.plan,
        input,
        candidates,
        avoidedPlaceIds,
        crossPlanUsedPlaceIds,
        resolveRoutes,
        foodTrace,
      )
    : { plan: postCoverageMealAlignment.plan, routesFailed: false }
  const finalMealAlignment = allowCoverageRepair
    ? await realignPlanMealsAfterTiming(postTimingAlignment.plan, input, resolveRoutes)
    : { plan: postTimingAlignment.plan, routesFailed: false }
  const finalTimingAlignment = allowCoverageRepair
    ? await realignPlanCandidatesAfterTiming(
        finalMealAlignment.plan,
        input,
        candidates,
        avoidedPlaceIds,
        crossPlanUsedPlaceIds,
        resolveRoutes,
        foodTrace,
      )
    : { plan: finalMealAlignment.plan, routesFailed: false }
  // No additions or reordering may run after this capacity pass.
  const finalCapacityRepair = allowCoverageRepair
    ? await trimPlanToTimeWindow(
        shrinkToCapacity(finalTimingAlignment.plan), input, resolveRoutes, diagnosticContext,
      )
    : { plan: finalTimingAlignment.plan, routesFailed: false }
  // Timing/capacity changes can invalidate a previously satisfied meal. Reorder only;
  // no late refill or deletion loop. An unresolved meal is rejected by the final gate.
  const finalMealRepair = allowCoverageRepair && !initialRouteRepair.routesFailed && !mealRoutes.routesFailed
    ? await repairRequiredMeals(finalCapacityRepair.plan, input, candidates, routeContext, false,
        crossPlanUsedPlaceIds)
    : { plan: finalCapacityRepair.plan, routesFailed: false }
  traceDurationPlan(finalCapacityRepair.plan, finalMealRepair.plan, 'meal_alignment')
  const finalPlan = normalizePlanTotalTime(finalMealRepair.plan)
  rememberPlanTextTransition(plan, finalPlan, repairedStops, scheduleAlignedStops,
    routedPlan, initialCapacityRepair.plan, mealRepair.plan, mealCapacityRepair.plan, preExpansionPlan,
    expandedStops, routeRepairedPlan, coverageRepairedPlan, trimmedPlan, postCoverageMealAlignment.plan,
    postTimingAlignment.plan, finalMealAlignment.plan, finalTimingAlignment.plan, finalCapacityRepair.plan)
  debug?.recordPlanTransition(coverageRepairedPlan, finalPlan, 'repair:final-capacity-meal-and-availability', { attemptId })
  const originalStayLoss = getOriginalStayLoss(initialCapacityRepair.plan.stops, finalPlan.stops)
  const addedActivities = expansionResult.stops.filter(stop =>
    !preExpansionPlan.stops.some(original => original.id === stop.id))
  // A local choice is provisional until the entire repair completes. One bounded alternative
  // retains required meals and every safety repair, but omits discretionary activity additions.
  if (allowCoverageRepair && !options.skipActivitySupplement && addedActivities.length && originalStayLoss > 0) {
    const alternative = await repairPlanForDelivery(plan, input, candidates, avoidedPlaceIds, {
      ...options, routeContext, skipActivitySupplement: true,
    })
    const alternativeLoss = getOriginalStayLoss(initialCapacityRepair.plan.stops, alternative.plan.stops)
    if (!alternative.routesFailed && alternativeLoss < originalStayLoss &&
      getMissingMealWindows(alternative.plan.stops, input, getRequiredMealWindows(input),
        alternative.plan.transportSegments).length === 0 &&
      (await getDeliveryPlanIssues(alternative.plan, input, 'supplement-final-alternative', { candidates })).length === 0) {
      routeContext.remedy.events.push({ kind: 'supplement', outcome: 'activity_loss_rejected', details: 'selected_whole_repair_alternative' })
      console.info('[supplement-final-alternative]', { planId: plan.id, originalStayLoss,
        alternativeLoss, routeCalls: routeContext.totalCalls, cacheHits: routeContext.cacheHits })
      debug?.recordPlanTransition(finalPlan, alternative.plan, 'fallback:supplement-alternative-selected', { attemptId,
        disposition: 'selected', reason: 'preserve_original_activity_stays' })
      return alternative
    }
  }

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
      originalStayLoss,
      comparisonRouteCalls: routeContext.calls,
      repairRouteCalls: routeContext.totalCalls,
      routeCacheHits: routeContext.cacheHits,
    }
    console.info('[coverage-repair-result]', coveragePayload)
    writeGenerateDebugLog('coverage-repair-result', coveragePayload)
  }

  const deliveredPlan = carryOriginalActivities(plan, {
    ...finalPlan, totalTime: getPlanActualDuration(finalPlan),
  })
  durationRepairEvidence.set(deliveredPlan, { losses: capacityLosses, routeContext })
  lastCoverageAttempt.set(routeContext, deliveredPlan)
  return {
    plan: deliveredPlan,
    routesFailed:
      routesFailed ||
      initialRouteRepair.routesFailed ||
      expansionResult.routesFailed ||
      initialCapacityRepair.routesFailed ||
      mealRoutes.routesFailed ||
      mealCapacityRepair.routesFailed ||
      trimResult.routesFailed ||
      finalCapacityRepair.routesFailed ||
      finalMealRepair.routesFailed ||
      postCoverageMealAlignment.routesFailed ||
      postTimingAlignment.routesFailed ||
      finalMealAlignment.routesFailed ||
      finalTimingAlignment.routesFailed,
  }
}

export async function realignPlanMealsAfterTiming(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  resolveRoutes: typeof repairTransportSegments = repairTransportSegments,
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  const alignedStops = realignFoodStopsForMealWindows(plan.stops, input, plan.transportSegments)
  if (!haveStopOrderChanged(plan.stops, alignedStops)) {
    return { plan, routesFailed: false }
  }

  const { segments, routesFailed } = await resolveRoutes(
    plan.transportSegments ?? [],
    alignedStops,
    plan.transportMode,
  )
  const alignedPlan = shrinkPlanDurationToScheduleCapacity(
    normalizePlanTotalTime({ ...plan, stops: alignedStops, transportSegments: segments }), input,
  )

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
  crossPlanUsedPlaceIds: Set<string>,
  resolveRoutes: typeof repairTransportSegments = repairTransportSegments,
  foodTrace?: FoodPurposeProvenance,
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
      crossPlanUsedPlaceIds,
      nextPlan.transportSegments,
      foodTrace,
    )

    if (!haveStopsChangedForTimingAlignment(nextPlan.stops, alignedStops)) break

    let alignedSegments = nextPlan.transportSegments ?? []
    if (
      haveStopRouteEndpointsChanged(nextPlan.stops, alignedStops) ||
      alignedSegments.length !== Math.max(alignedStops.length - 1, 0)
    ) {
      const routeRepair = await resolveRoutes(
        nextPlan.transportSegments ?? [],
        alignedStops,
        nextPlan.transportMode,
      )
      alignedSegments = routeRepair.segments
      routesFailed = routesFailed || routeRepair.routesFailed
    }

    const previousPlan = nextPlan
    nextPlan = shrinkPlanDurationToScheduleCapacity(
      normalizePlanTotalTime({
        ...nextPlan,
        stops: alignedStops,
        transportSegments: alignedSegments,
      }),
      input,
    )
    rememberPlanTextTransition(previousPlan, nextPlan, alignedStops)
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

export async function repairAndValidatePlanForDelivery(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
  phase: string,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  debugSession?: TripCandidateDebugSession,
  demandStamina?: string,
): Promise<{ plan: TripPlan | null; routesFailed: boolean; issues: string[] }> {
  const routeContext = createSupplementRouteContext()
  // The existing safety/diversity pipeline chooses its result first. Nothing below
  // re-enters repair or fallback, so there is at most one allocation comparison.
  const result = await repairAndValidatePlanForDeliveryCore(plan, input, candidates, avoidedPlaceIds,
    phase, crossPlanUsedPlaceIds, debugSession, routeContext)
  const observedRemedy = (selected: TripPlan) => {
    const own = durationRepairEvidence.get(selected)?.routeContext.remedy
    return !own || own === routeContext.remedy ? routeContext.remedy : {
      events: [...routeContext.remedy.events, ...own.events],
      supplementPasses: [...routeContext.remedy.supplementPasses, ...own.supplementPasses],
      budgetExhausted: routeContext.remedy.budgetExhausted || own.budgetExhausted,
      technicalFailure: routeContext.remedy.technicalFailure || own.technicalFailure,
    }
  }
  if (!result.plan || result.routesFailed) {
    const assessed = result.plan ?? lastCoverageAttempt.get(routeContext) ?? plan
    recordCoverageShadow(assessed, input, candidates, observedRemedy(assessed), result)
    debugSession?.recordCoverageV2?.(assessed)
    return result
  }
  const finish = async (value: typeof result) => {
    const selected = value.plan ? await repairPlanVisitRequirements(value.plan, input, candidates,
      durationRepairEvidence.get(value.plan)?.routeContext ?? routeContext, debugSession, demandStamina) : null
    if (selected) {
      recordCoverageShadow(selected, input, candidates, observedRemedy(selected), value)
      debugSession?.recordCoverageV2?.(selected)
    }
    return { ...value, plan: selected }
  }
  const evidence = durationRepairEvidence.get(result.plan)
  if (!evidence?.losses.size) return finish(result)
  const comparison = proposeStopDurationRedistribution(result.plan, input, candidates, evidence.losses)
  if (!comparison) return finish(result)
  const issues = await hasReusableStaticRouteTimings(evidence.routeContext, result.plan)
    ? getDurationRedistributionIssues(result.plan, comparison.plan, input, candidates)
    : ['route_timing_not_reusable_without_new_queries']
  if (getFirstStopDistanceIssue(comparison.plan, input, candidates)) issues.push('first_stop_distance')
  if (issues.length) {
    debugSession?.recordPlanTransition(result.plan, comparison.plan, 'duration-redistribution:rejected', {
      disposition: 'rejected', reason: issues.join(','),
    })
    return finish(result)
  }
  traceDurationPlan(result.plan, comparison.plan, 'redistribution')
  debugSession?.recordPlanTransition(result.plan, comparison.plan, 'duration-redistribution:accepted', {
    disposition: 'selected', reason: 'restore_capacity_compressed_explicit_theme_activity;excess_activity_support_unknown',
  })
  return finish({ ...result, plan: carryOriginalActivities(result.plan, comparison.plan) })
}

// At most three candidates and two existing positions per missing theme. All new
// edges share the repair's comparison budget/memo; no recursive repair or AI retry.
async function repairPlanVisitRequirements(plan: TripPlan, input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates, context: SupplementRouteContext,
  debug?: TripCandidateDebugSession, stamina?: string): Promise<TripPlan> {
  candidates = filterDemandCandidates(candidates, input)
  let selected = plan
  for (const requirement of assessVisitRequirements(plan, input, candidates)) {
    const before = assessVisitRequirements(selected, input, candidates)
    if (before.find(item => item.label === requirement.label)?.status === 'satisfied') continue
    const used = new Set(selected.stops.map(stop => stop.placeId))
    const available = candidates.allCandidates.filter(candidate => !used.has(candidate.placeId) &&
      candidate.openingHours?.isKnown && !candidate.openingHours.isNeverOpen)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.placeId.localeCompare(b.placeId))
    const primary = available.filter(candidate => visitRequirementEvidence(requirement, candidate) === 'satisfied')
    const alternatives = before.find(item => item.label === requirement.label)?.status === 'alternative' ? []
      : available.filter(candidate => visitRequirementEvidence(requirement, candidate) === 'alternative')
    // Primary visits get the bounded opportunity first; related visits use remaining slots.
    const shortlist = [...primary.slice(0, 2), ...alternatives.slice(0, 1), ...primary.slice(2, 3)].slice(0, 3)
    context.remedy.events.push({ kind: 'demand', outcome: 'gap_observed', demandGap: requirement.label,
      details: `eligible=${primary.length + alternatives.length};shortlist=${shortlist.length}` })
    if (primary.length + alternatives.length > shortlist.length) context.remedy.events.push({
      kind: 'demand', outcome: 'candidates_unprocessed', demandGap: requirement.label })
    const demandEvent = (outcome: string, placeId?: string, position?: number, routeComparisonCompleted = false) =>
      context.remedy.events.push({ kind: 'demand', outcome, placeId, position, routeComparisonCompleted, demandGap: requirement.label })
    const roundStart = context.calls
    const arrivals = selected.stops.map((_stop, index) => getEstimatedArrivalMinutesForStop(
      selected.stops, index, { ...input, scheduleStartTime: selected.scheduleStartTime }, selected.transportSegments))
    const meals = getRequiredMealWindows({ ...input, scheduleStartTime: selected.scheduleStartTime })
    const positions = selected.stops.map((_stop, index) => index).filter(index =>
      !(selected.stops[index].type === 'food' && meals.some(window =>
        isStopAlignedWithMealWindow(arrivals[index], selected.stops[index].duration, window))))
      .sort((a, b) => Number(a === 0) - Number(b === 0) || b - a).slice(0, 2)
    let accepted = false
    for (const candidate of shortlist) {
      for (const index of positions) {
        const stops = selected.stops.map(stop => ({ ...stop }))
        const original = stops[index]
        const replacement = applyCandidateToStop({ ...original, description: '' }, candidate)
        replacement.duration = clamp(original.duration, getMinimumStopDuration(replacement), getMaximumStopDuration(replacement))
        stops[index] = replacement
        const trial = { ...selected, stops }
        if (getFirstStopDistanceIssue(trial, input, candidates)) { demandEvent('first_stop_distance_rejected', candidate.placeId, index); continue }
        const after = assessVisitRequirements(trial, input, candidates)
        if (before.some(item => item.label !== requirement.label &&
          (item.status === 'satisfied' && after.find(next => next.label === item.label)?.status !== 'satisfied' ||
            item.status === 'alternative' && !['satisfied', 'alternative'].includes(after.find(next => next.label === item.label)?.status ?? '')))) { demandEvent('core_activity_loss_rejected', candidate.placeId, index); continue }
        const routing = await resolveMealComparisonRoutes(context, stops, selected.transportMode, roundStart)
        if (!routing || routing.routesFailed) { demandEvent(!routing ? 'comparison_budget_exhausted' : 'route_failure', candidate.placeId, index); continue }
        demandEvent('route_comparison_completed', candidate.placeId, index, true)
        trial.transportSegments = routing.segments
        trial.totalTime = getPlanActualDuration(trial)
        const travel = (value: TripPlan) => value.transportSegments.reduce((sum, leg) => sum + leg.duration, 0)
        if ((stamina === '弱' || input.tags.some(tag => ['not_too_tired', 'short_distance'].includes(tag))) &&
          travel(trial) > travel(selected)) { demandEvent('travel_rejected', candidate.placeId, index, true); continue }
        if (getPlanRhythmIssues(trial, input).some(issue => !getPlanRhythmIssues(selected, input).includes(issue))) { demandEvent('activity_rhythm_rejected', candidate.placeId, index, true); continue }
        const trialArrivals = stops.map((_stop, i) => getEstimatedArrivalMinutesForStop(stops, i,
          { ...input, scheduleStartTime: selected.scheduleStartTime }, routing.segments))
        const start = parseTimeToMinutes(input.startTime), rawEnd = parseTimeToMinutes(input.endTime)
        if (start === null || rawEnd === null) continue
        const end = rawEnd < start ? rawEnd + 1440 : rawEnd
        if (trialArrivals[0] < start || trialArrivals.at(-1)! + stops.at(-1)!.duration > end ||
          !stops.every((stop, i) => {
            const known = candidates.allCandidates.find(place => place.placeId === stop.placeId)
            return known && isCandidateOpenForVisit(known, trialArrivals[i], stop.duration)
          })) { demandEvent('opening_or_capacity_rejected', candidate.placeId, index, true); continue }
        if ((await getDeliveryPlanIssues(trial, input, 'visit-requirement-comparison', { candidates })).length) { demandEvent('delivery_conditions_rejected', candidate.placeId, index, true); continue }
        debug?.recordPlanTransition(selected, trial, 'visit-requirement:selected', {
          disposition: 'selected', reason: `${requirement.theme}:${visitRequirementEvidence(requirement, candidate)}`,
        })
        demandEvent('selected', candidate.placeId, index, true)
        traceDurationPlan(selected, trial, 'replacement')
        selected = carryOriginalActivities(selected, trial)
        accepted = true
        break
      }
      if (accepted) break
    }
  }
  return selected
}

async function repairAndValidatePlanForDeliveryCore(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
  phase: string,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  debugSession?: TripCandidateDebugSession,
  routeContext: SupplementRouteContext = createSupplementRouteContext(),
): Promise<{ plan: TripPlan | null; routesFailed: boolean; issues: string[] }> {
  let firstAttempt = await repairPlanForDelivery(plan, input, candidates, avoidedPlaceIds, {
    allowCoverageRepair: false,
    crossPlanUsedPlaceIds,
    routeContext,
    debugSession, debugPhase: `${phase}:first-attempt`,
  })
  let firstIssues = await getDeliveryPlanIssues(firstAttempt.plan, input, phase, { candidates })
  // One bounded comparison of whole repair results. Optional variety must not buy
  // legality by shrinking/removing useful original activities after real routing.
  let diversityFallbackTried = false
  const restoreOptionalLoss = async (current: typeof firstAttempt, issues: string[]) => {
    if (diversityFallbackTried || crossPlanUsedPlaceIds.size === 0) return null
    const impact = compareOriginalActivities(plan.stops, current.plan.stops)
    const foodImpact = getFoodPurposeImpact(plan, current.plan.stops)
    const requirements = assessVisitRequirements(plan, input, candidates)
    // Distinct venues are not interchangeable merely because their coarse purpose
    // matches. Only protect a verified, feasible original that fulfills an explicit
    // visit requirement; unknown venue evidence does not acquire a preference here.
    const optionalChanges = plan.stops.filter((stop, index) => {
      const replacement = current.plan.stops.find(final => final.id === stop.id)
      const candidate = findMatchingCandidateForStop(stop, index, candidates)
      return stop.placeId && crossPlanUsedPlaceIds.has(stop.placeId) && replacement &&
        replacement.placeId !== stop.placeId && candidate?.placeId === stop.placeId &&
        !avoidedPlaceIds.has(stop.placeId) && !isForbiddenStop(stop, input, candidates) &&
        isCandidateAllowedForStopIndex(candidate, index) && isCandidateOpenForVisit(candidate,
          getEstimatedArrivalMinutesForStop(plan.stops, index,
            { ...input, startTime: plan.scheduleStartTime ?? input.startTime }, plan.transportSegments),
          stop.duration)
    })
    const fulfilledActivities = optionalChanges.filter(stop => {
      const candidate = candidates.allCandidates.find(candidate => candidate.placeId === stop.placeId)
      return stop.type === 'main_activity' && candidate && requirements.some(requirement =>
        visitRequirementEvidence(requirement, candidate) === 'satisfied')
    })
    // Only comparable optional food changes need a trusted route comparison. A clearly
    // better final candidate score can still justify extra travel; never re-add its boost.
    const comparableFoodChange = foodImpact.changes.some(change => {
      if (change.reason !== 'optional_diversity') return false
      const from = candidates.allCandidates.find(candidate => candidate.placeId === change.fromPlaceId)
      const to = candidates.allCandidates.find(candidate => candidate.placeId === change.toPlaceId)
      return from && to && Math.abs((from.score ?? 0) - (to.score ?? 0)) <= SOFT_DIVERSITY_SCORE_TOLERANCE
    })
    if (issues.length === 0 && impact.retainedStayLoss === 0 && impact.removedStops === 0 &&
      impact.purposeChanges === 0 && foodImpact.foodPurposeChanges === 0 && !comparableFoodChange &&
      fulfilledActivities.length === 0) return null
    if (optionalChanges.length === 0) return null
    const currentRequirements = assessVisitRequirements(current.plan, input, candidates)
    // A lawful replacement already completing every explicit visit request needs
    // no route comparison when only the protected identities changed and no known
    // purpose/stay was lost. This confirms demand gain, not venue equivalence.
    if (issues.length === 0 && !current.routesFailed && fulfilledActivities.length > 0 &&
      requirements.some(item => item.fulfillment !== 'satisfied') &&
      currentRequirements.every(item => item.fulfillment === 'satisfied') &&
      impact.identityChanges === fulfilledActivities.length && impact.retainedStayLoss === 0 &&
      impact.removedStops === 0 && impact.purposeChanges === 0 && foodImpact.foodPurposeChanges === 0 &&
      fulfilledActivities.every(original =>
        (current.plan.stops.find(stop => stop.id === original.id)?.duration ?? 0) >= original.duration)) {
      debugSession?.recordPlanTransition(plan, current.plan, 'fallback:activity-diversity-retained', {
        disposition: 'selected',
        reason: 'confirmed_visit_requirement_gain_with_preserved_purpose_and_stay;comparison_not_needed',
      })
      return null
    }
    diversityFallbackTried = true
    const fallback = await repairPlanForDelivery(plan, input, candidates, avoidedPlaceIds, {
      allowCoverageRepair: true, routeContext, crossPlanUsedPlaceIds: new Set(),
      debugSession, debugPhase: `${phase}:diversity-fallback-attempt`,
    })
    if (fallback.routesFailed || (await getDeliveryPlanIssues(fallback.plan, input,
      `${phase}-activity-diversity-fallback`, { candidates })).length > 0) return null
    const alternative = compareOriginalActivities(plan.stops, fallback.plan.stops)
    const alternativeFood = getFoodPurposeImpact(plan, fallback.plan.stops)
    const travel = (value: TripPlan) => value.transportSegments.reduce((sum, leg) => sum + leg.duration, 0)
    const fallbackRequirements = assessVisitRequirements(fallback.plan, input, candidates)
    const preservesRequirements = (before: typeof currentRequirements, after: typeof currentRequirements) =>
      before.every((item, index) => item.fulfillment === 'satisfied' ? after[index].fulfillment === 'satisfied'
        : item.fulfillment !== 'alternative' || after[index].fulfillment !== 'not_confirmed')
    const fallbackPreservesDemand = preservesRequirements(currentRequirements, fallbackRequirements)
    // Identity value remains unknown. Routes may justify the change only while
    // preserving confirmed demands, coarse purposes and the protected visit's stay.
    const currentImprovesTravel = preservesRequirements(fallbackRequirements, currentRequirements) &&
      travel(current.plan) < travel(fallback.plan) && impact.retainedStayLoss <= alternative.retainedStayLoss &&
      impact.removedStops <= alternative.removedStops && impact.purposeLostMinutes <= alternative.purposeLostMinutes &&
      foodImpact.foodPurposeChanges <= alternativeFood.foodPurposeChanges && fulfilledActivities.every(original =>
        (current.plan.stops.find(stop => stop.id === original.id)?.duration ?? 0) >=
        (fallback.plan.stops.find(stop => stop.id === original.id)?.duration ?? original.duration))
    if (issues.length === 0 && fulfilledActivities.length &&
      (!fallbackPreservesDemand || currentImprovesTravel)) {
      debugSession?.recordPlanTransition(fallback.plan, current.plan, 'fallback:activity-diversity-retained', {
        disposition: 'selected', reason: currentImprovesTravel ? 'verified_travel_improvement_with_preserved_demand_purpose_and_stay'
          : 'preserve_confirmed_visit_requirement_improvement',
      })
      return null
    }
    const restoresFulfilledActivity = fallbackPreservesDemand && fulfilledActivities.some(original =>
      fallback.plan.stops.some(stop => stop.id === original.id && stop.placeId === original.placeId)) &&
      alternative.retainedStayLoss <= impact.retainedStayLoss && alternative.removedStops <= impact.removedStops &&
      alternative.purposeLostMinutes <= impact.purposeLostMinutes &&
      alternativeFood.foodPurposeChanges <= foodImpact.foodPurposeChanges
    if (issues.length === 0 && !(alternative.retainedStayLoss <= impact.retainedStayLoss &&
      alternative.removedStops <= impact.removedStops && alternative.purposeLostMinutes <= impact.purposeLostMinutes &&
      alternativeFood.foodPurposeChanges <= foodImpact.foodPurposeChanges &&
      travel(fallback.plan) <= travel(current.plan) &&
      (alternative.retainedStayLoss < impact.retainedStayLoss || alternative.removedStops < impact.removedStops ||
        alternative.purposeLostMinutes < impact.purposeLostMinutes ||
        alternativeFood.foodPurposeChanges < foodImpact.foodPurposeChanges ||
        (comparableFoodChange && travel(fallback.plan) < travel(current.plan)))) && !restoresFulfilledActivity) return null
    console.info('[activity-diversity-fallback]', { planId: plan.id, before: impact, after: alternative,
      routeCalls: routeContext.totalCalls, cacheHits: routeContext.cacheHits })
    debugSession?.recordPlanTransition(current.plan, fallback.plan, 'fallback:activity-diversity-selected', {
      disposition: 'selected', reason: restoresFulfilledActivity
        ? 'activity_equivalence_unknown;retain_feasible_fulfilled_original_without_confirmed_gain'
        : 'existing_optional_diversity_comparison',
    })
    return fallback
  }
  const preferredFirst = await restoreOptionalLoss(firstAttempt, firstIssues)
  if (preferredFirst) { firstAttempt = preferredFirst; firstIssues = [] }

  if (firstIssues.length === 0) {
    logOriginalActivityImpact(plan, firstAttempt.plan, phase)
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

  let coverageAttempt = await repairPlanForDelivery(firstAttempt.plan, input, candidates, avoidedPlaceIds, {
    allowCoverageRepair: true,
    crossPlanUsedPlaceIds,
    routeContext,
    debugSession, debugPhase: `${phase}:coverage-attempt`,
  })
  let coverageIssues = await getDeliveryPlanIssues(
    coverageAttempt.plan,
    input,
    `${phase}-coverage-repair`,
    { candidates },
  )
  const preferredCoverage = await restoreOptionalLoss(coverageAttempt, coverageIssues)
  if (preferredCoverage) { coverageAttempt = preferredCoverage; coverageIssues = [] }

  if (coverageIssues.length === 0) {
    logOriginalActivityImpact(plan, coverageAttempt.plan, `${phase}-coverage-repair`)
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

  const dawnTailAttempt = await trimDawnTailAfterOpeningHoursFailure(
    coverageAttempt.plan,
    input,
    `${phase}-dawn-tail-trim`,
    candidates,
  )

  if (dawnTailAttempt.plan) {
    logOriginalActivityImpact(plan, dawnTailAttempt.plan, `${phase}-dawn-tail-trim`)
    console.info('[plan-repair-dawn-tail-trim-applied]', {
      phase,
      planId: plan.id,
      originalIssues: firstIssues,
      coverageIssues,
      trimmedStopCount: coverageAttempt.plan.stops.length - dawnTailAttempt.plan.stops.length,
      actualMinutes: getPlanActualDuration(dawnTailAttempt.plan),
      minimumMinutes: getDawnTailMinimumRequiredActualMinutes(input),
    })
    writeGenerateDebugLog('plan-repair-dawn-tail-trim-applied', {
      phase,
      planId: plan.id,
      originalIssues: firstIssues,
      coverageIssues,
      trimmedStopCount: coverageAttempt.plan.stops.length - dawnTailAttempt.plan.stops.length,
      actualMinutes: getPlanActualDuration(dawnTailAttempt.plan),
      minimumMinutes: getDawnTailMinimumRequiredActualMinutes(input),
    })

    return {
      plan: await annotatePlanWithScheduleStart(dawnTailAttempt.plan, input),
      routesFailed: firstAttempt.routesFailed || coverageAttempt.routesFailed || dawnTailAttempt.routesFailed,
      issues: [],
    }
  }

  if (avoidedPlaceIds.size === 0) {
    const coverageFailedPayload = {
      phase,
      planId: plan.id,
      originalIssues: firstIssues,
      coverageIssues,
      dawnTailIssues: dawnTailAttempt.issues,
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
    crossPlanUsedPlaceIds,
    debugSession, debugPhase: `${phase}:fallback-attempt`,
  })
  const fallbackIssues = await getDeliveryPlanIssues(fallbackAttempt.plan, input, `${phase}-fallback`, {
    candidates,
  })
  if (fallbackIssues.length === 0) logOriginalActivityImpact(plan, fallbackAttempt.plan, `${phase}-fallback`)
  lastCoverageAttempt.set(routeContext, fallbackAttempt.plan)

  return {
    plan:
      fallbackIssues.length === 0
        ? await annotatePlanWithScheduleStart(fallbackAttempt.plan, input)
        : null,
    routesFailed: firstAttempt.routesFailed || coverageAttempt.routesFailed || fallbackAttempt.routesFailed,
    issues: fallbackIssues.length === 0 ? [] : fallbackIssues,
  }
}

async function trimDawnTailAfterOpeningHoursFailure(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  phase: string,
  candidates?: NearbyPlaceCandidates,
): Promise<{ plan: TripPlan | null; routesFailed: boolean; issues: string[] }> {
  // Keep this narrow: when a dawn tail stop cannot pass availability checks, we
  // may end about 60-90 minutes early rather than reject an otherwise usable
  // overnight plan. This is not a fallback for closed daytime stops.
  if (!shouldAllowDawnTailShortfall(input)) {
    return { plan: null, routesFailed: false, issues: [] }
  }

  let nextPlan = normalizePlanTotalTime(plan)
  let lastIssues = await getDeliveryPlanIssues(nextPlan, input, phase, {
    coverageShortfallAllowanceMinutes: DAWN_TAIL_COVERAGE_SHORTFALL_ALLOWANCE_MINUTES,
    candidates,
  })

  if (lastIssues.length === 0) {
    return { plan: nextPlan, routesFailed: false, issues: [] }
  }

  let routesFailed = false
  let trimmedStopCount = 0

  while (nextPlan.stops.length > 2 && isTailStopNearDawnTripEnd(nextPlan, input)) {
    const stops = nextPlan.stops.slice(0, -1)
    const routeRepair = await repairTransportSegments(
      nextPlan.transportSegments ?? [],
      stops,
      nextPlan.transportMode,
    )
    routesFailed = routesFailed || routeRepair.routesFailed

    const candidatePlan = normalizePlanTotalTime({
      ...nextPlan,
      stops,
      transportSegments: routeRepair.segments,
    })

    if (!isAboveDawnTailMinimumCoverage(candidatePlan, input)) {
      break
    }

    trimmedStopCount += 1
    nextPlan = candidatePlan
    lastIssues = await getDeliveryPlanIssues(
      nextPlan,
      input,
      `${phase}-${trimmedStopCount}`,
      {
        coverageShortfallAllowanceMinutes: DAWN_TAIL_COVERAGE_SHORTFALL_ALLOWANCE_MINUTES,
        candidates,
      },
    )

    if (lastIssues.length === 0) {
      return { plan: nextPlan, routesFailed, issues: [] }
    }
  }

  return { plan: null, routesFailed, issues: lastIssues }
}

export async function getDeliveryPlanIssues(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  phase: string,
  options: DeliveryPlanIssueOptions = {},
) {
  logPlanQualitySummary(plan, input, phase)

  const firstStopDistanceIssue = getFirstStopDistanceIssue(plan, input, options.candidates)
  const placesIssues = firstStopDistanceIssue ? [firstStopDistanceIssue] : []
  const hardIssues = getHardPlanQualityIssues(plan, input, placesIssues, { ...options, skipMealCoverage: true })
  hardIssues.push(...getForbiddenVisitIssues(plan, input, options.candidates))
  if (hardIssues.length > 0) {
    return hardIssues
  }

  const timelineInput = await getOpeningHoursTimelineInput(plan, input)
  const openingHoursIssues = await validatePlanOpeningHours(plan, timelineInput)
  const mealIssues = getRequiredMealCoverageIssues(
    { ...plan, scheduleStartTime: timelineInput.startTime }, input,
  )
  if (openingHoursIssues.length > 0) {
    logOpeningHoursIssues(plan.id, openingHoursIssues)
    return [...openingHoursIssues.map(formatOpeningHoursValidationIssue), ...mealIssues]
  }

  return mealIssues
}

export function getFirstStopDistanceIssue(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  candidates?: NearbyPlaceCandidates,
): PlacesValidationResult['issues'][number] | null {
  const firstStop = plan.stops[0]
  if (!firstStop) return null

  const distanceKm = getFirstStopDistanceKm(firstStop, input, candidates)
  if (distanceKm === null || distanceKm <= FIRST_STOP_MAX_DISTANCE_KM) return null

  return {
    stopId: firstStop.id,
    stopName: firstStop.name,
    reason: 'first_stop_too_far',
    distanceKm,
  }
}

function getFirstStopDistanceKm(
  stop: Stop,
  input: GenerateTripPlansRequest['input'],
  candidates?: NearbyPlaceCandidates,
) {
  const candidateDistance = getCandidateDistanceKmForStop(stop, candidates)
  if (candidateDistance !== null) return candidateDistance

  if (
    typeof input.location.lat !== 'number' ||
    typeof input.location.lng !== 'number' ||
    typeof stop.lat !== 'number' ||
    typeof stop.lng !== 'number'
  ) {
    return null
  }

  return calculateDistance(input.location.lat, input.location.lng, stop.lat, stop.lng)
}

function getCandidateDistanceKmForStop(stop: Stop, candidates?: NearbyPlaceCandidates) {
  if (!candidates || !stop.placeId) return null

  const matchedCandidate = mergeCandidatePools(
    candidates.allCandidates,
    candidates.otherCandidates,
    candidates.firstStopCandidates,
  ).find((candidate) => candidate.placeId === stop.placeId)

  return typeof matchedCandidate?.distanceKm === 'number' ? matchedCandidate.distanceKm : null
}

async function annotatePlanWithScheduleStart(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const timelineInput = await getOpeningHoursTimelineInput(plan, input)
  return annotatePlanScheduleStart(plan, timelineInput.startTime)
}

function annotatePlanScheduleStart(plan: TripPlan, scheduleStartTime: string) {
  return carryOriginalActivities(plan, {
    ...plan,
    scheduleStartTime,
  })
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
    (getRequiredMealWindows(input).length > 0 ||
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
    googleTypes: candidate.types,
    candidateRole: candidate.role,
    foodSubtype: candidate.foodSubtype,
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

const SOFT_DIVERSITY_SCORE_TOLERANCE = 6
const SOFT_DIVERSITY_DISTANCE_TOLERANCE_KM = 1.2

export function pickSoftDiverseCandidate(
  candidatePool: VerifiedPlaceCandidate[],
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  options: { preferredIndex?: number; scoreTolerance?: number; distanceToleranceKm?: number } = {},
) {
  const eligibleCandidates = candidatePool.filter(isSoftDiversityEligibleCandidate)
  const topCandidate = pickRotatedItem(eligibleCandidates, options.preferredIndex ?? 0)
  if (!topCandidate) return null
  if (!crossPlanUsedPlaceIds.has(topCandidate.placeId)) return topCandidate

  const scoreTolerance = options.scoreTolerance ?? SOFT_DIVERSITY_SCORE_TOLERANCE
  const distanceToleranceKm =
    options.distanceToleranceKm ?? SOFT_DIVERSITY_DISTANCE_TOLERANCE_KM
  const alternative = eligibleCandidates.find(
    (candidate) =>
      candidate.placeId !== topCandidate.placeId &&
      !crossPlanUsedPlaceIds.has(candidate.placeId) &&
      isCandidateCloseEnoughForSoftDiversity(
        candidate,
        topCandidate,
        scoreTolerance,
        distanceToleranceKm,
      ),
  )

  return alternative ?? topCandidate
}

function isSoftDiversityEligibleCandidate(candidate: VerifiedPlaceCandidate) {
  return Boolean(candidate.placeId && candidate.openingHours?.isKnown && !candidate.openingHours.isNeverOpen)
}

function filterCandidatePoolForStopIndex(pool: VerifiedPlaceCandidate[], index: number) {
  return index === 0 ? pool.filter(isFirstStopCandidateWithinDistance) : pool
}

function isCandidateAllowedForStopIndex(candidate: VerifiedPlaceCandidate, index: number) {
  return index !== 0 || isFirstStopCandidateWithinDistance(candidate)
}

function isFirstStopCandidateWithinDistance(candidate: VerifiedPlaceCandidate) {
  return (
    typeof candidate.distanceKm === 'number' &&
    candidate.distanceKm <= FIRST_STOP_MAX_DISTANCE_KM
  )
}

function isCandidateCloseEnoughForSoftDiversity(
  candidate: VerifiedPlaceCandidate,
  topCandidate: VerifiedPlaceCandidate,
  scoreTolerance: number,
  distanceToleranceKm: number,
) {
  const candidateScore = candidate.score ?? 0
  const topScore = topCandidate.score ?? 0
  if (candidateScore < topScore - scoreTolerance) return false

  if (
    typeof candidate.distanceKm === 'number' &&
    typeof topCandidate.distanceKm === 'number' &&
    candidate.distanceKm > topCandidate.distanceKm + distanceToleranceKm
  ) {
    return false
  }

  return true
}

function candidateActivityPurpose(candidate: VerifiedPlaceCandidate) {
  return getActivityPurpose({ id: candidate.placeId, ...candidate,
    type: inferStopTypeFromCandidate(candidate), description: '', duration: 0,
    googleTypes: candidate.types, candidateRole: candidate.role })
}

// Mandatory replacement still has a cross-purpose fallback. Purpose wins only among
// candidates comparable by the existing score/distance tolerances, never as a hard gate.
function pickPurposeAwareReplacement(stop: Stop, pool: VerifiedPlaceCandidate[], crossPlanUsed: Set<string>) {
  const ranked = pool.filter(isSoftDiversityEligibleCandidate)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const best = ranked[0]
  if (!best) return null
  const purpose = getActivityPurpose(stop)
  const comparable = ranked.filter(candidate => candidateActivityPurpose(candidate) === purpose &&
    isCandidateCloseEnoughForSoftDiversity(candidate, best,
      SOFT_DIVERSITY_SCORE_TOLERANCE, SOFT_DIVERSITY_DISTANCE_TOLERANCE_KM))
  return pickSoftDiverseCandidate(comparable.length ? comparable : ranked, crossPlanUsed)
}

function ensureStopHasVerifiedPlace(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  avoidedPlaceIds: Set<string> = new Set(),
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  arrivalMinutes?: number,
  foodTrace?: FoodPurposeProvenance,
  servesRequiredMeal = false,
  input?: TripInput,
) {
  const existingCandidate = findMatchingCandidateForStop(stop, index, candidates)
  const originalWasUsed = Boolean(stop.placeId && usedPlaceIds.has(stop.placeId))
  if (
    stop.placeId &&
    stop.address &&
    stop.googleMapsUrl &&
    !existingCandidate &&
    !usedPlaceIds.has(stop.placeId) &&
    !avoidedPlaceIds.has(stop.placeId)
  ) {
    usedPlaceIds.add(stop.placeId)
    return stop
  }

  const candidate = pickCandidateForStop(
    stop,
    index,
    candidates,
    usedPlaceIds,
    avoidedPlaceIds,
    crossPlanUsedPlaceIds,
    existingCandidate,
    arrivalMinutes,
    servesRequiredMeal,
    input,
  )
  if (!candidate) return stop

  usedPlaceIds.add(candidate.placeId)
  const nextStop = applyCandidateToStop(stop, candidate)
  const reason = existingCandidate && existingCandidate.placeId !== stop.placeId ? 'grounding'
    : existingCandidate && isCandidateAllowedForStopIndex(existingCandidate, index) &&
      !originalWasUsed && !avoidedPlaceIds.has(stop.placeId ?? '') &&
      (arrivalMinutes === undefined || isCandidateOpenForVisit(existingCandidate, arrivalMinutes, stop.duration))
      ? 'optional_diversity' : 'safety'
  recordFoodReplacement(foodTrace, stop, nextStop, reason)
  return nextStop
}

export function pickCandidateForStop(
  stop: Stop,
  index: number,
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  avoidedPlaceIds: Set<string> = new Set(),
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  knownExistingCandidate?: VerifiedPlaceCandidate | null,
  arrivalMinutes?: number,
  servesRequiredMeal = false,
  input?: TripInput,
) {
  const existingCandidate = knownExistingCandidate ?? findMatchingCandidateForStop(stop, index, candidates)

  if (
    existingCandidate &&
    isCandidateAllowedForStopIndex(existingCandidate, index) &&
    isSoftDiversityEligibleCandidate(existingCandidate) &&
    !usedPlaceIds.has(existingCandidate.placeId) &&
    !avoidedPlaceIds.has(existingCandidate.placeId)
  ) {
    // Optional cross-plan variety cannot turn a legal activity into a meal. Keep the
    // original as anchor; only a comparable, same-purpose alternative can displace it.
    const purpose = candidateActivityPurpose(existingCandidate)
    const alternatives = filterCandidatePoolForStopIndex(candidates.allCandidates, index).filter(candidate =>
      candidate.placeId !== existingCandidate.placeId && !usedPlaceIds.has(candidate.placeId) &&
      !avoidedPlaceIds.has(candidate.placeId) && candidateActivityPurpose(candidate) === purpose &&
      (!input || arrivalMinutes === undefined || !isCandidateOpenForVisit(existingCandidate, arrivalMinutes, stop.duration) ||
        preservesCoreVisitRequirements(stop, candidate, input, candidates)) &&
      (arrivalMinutes === undefined || isCandidateOpenForVisit(candidate, arrivalMinutes,
        applyCandidateToStop(stop, candidate).duration)))
    // Local optional preference only. Safety replacement below keeps its full fallback pool.
    if (stop.type === 'food' && (arrivalMinutes === undefined ||
      isCandidateOpenForVisit(existingCandidate, arrivalMinutes, stop.duration))) {
      const original = applyCandidateToStop(stop, existingCandidate)
      const originalHint = getFoodPurposeHint(original)
      const asFood = (candidate: VerifiedPlaceCandidate) => applyCandidateToStop({ ...stop, description: '' }, candidate)
      const closest = alternatives.filter(candidate => originalHint !== 'uncertain' &&
        getFoodPurposeHint(asFood(candidate)) === originalHint)
      const closeChoice = pickSoftDiverseCandidate([existingCandidate, ...closest], crossPlanUsedPlaceIds)
      if (closeChoice && closeChoice.placeId !== existingCandidate.placeId) return closeChoice
      // Unknown/mixed evidence remains available, rather than becoming a hard food category.
      const remaining = servesRequiredMeal && originalHint === 'uncertain'
        ? [...alternatives].sort((a, b) => getMealSuitabilityRank(b) - getMealSuitabilityRank(a)) : alternatives
      const choice = pickSoftDiverseCandidate([existingCandidate, ...remaining], crossPlanUsedPlaceIds)
      return choice && hasFoodPurposeConflict(original, asFood(choice)) ? existingCandidate : choice
    }
    return pickSoftDiverseCandidate([existingCandidate, ...alternatives], crossPlanUsedPlaceIds)
  }

  const pool =
    stop.type === 'food'
      ? getCandidatePoolByStopType(stop, candidates)
      : index === 0
      ? candidates.firstStopCandidates.length > 0
        ? preferNonShortVisitCandidates(candidates.firstStopCandidates)
        : candidates.allCandidates
      : getCandidatePoolByStopType(stop, candidates)

  const scopedPool = filterCandidatePoolForStopIndex(pool, index)
  const primaryPool = filterCandidatePoolForStopIndex(
    existingCandidate ? mergeCandidatePools([existingCandidate], scopedPool) : scopedPool,
    index,
  )
  const primaryCandidate = pickPurposeAwareReplacement(stop,
    primaryPool.filter(
      (candidate) => !usedPlaceIds.has(candidate.placeId) && !avoidedPlaceIds.has(candidate.placeId),
    ),
    crossPlanUsedPlaceIds,
  )
  if (primaryCandidate || stop.type === 'food') {
    return (
      primaryCandidate ??
      pickPurposeAwareReplacement(stop,
        scopedPool.filter((candidate) => !usedPlaceIds.has(candidate.placeId)),
        crossPlanUsedPlaceIds,
      )
    )
  }

  return (
    primaryCandidate ??
    pickPurposeAwareReplacement(stop,
      filterCandidatePoolForStopIndex(candidates.allCandidates, index).filter(
        (candidate) =>
          !usedPlaceIds.has(candidate.placeId) && !avoidedPlaceIds.has(candidate.placeId),
      ),
      crossPlanUsedPlaceIds,
    ) ??
    pickPurposeAwareReplacement(stop,
      scopedPool.filter((candidate) => !usedPlaceIds.has(candidate.placeId)),
      crossPlanUsedPlaceIds,
    ) ??
    pickPurposeAwareReplacement(stop, scopedPool, crossPlanUsedPlaceIds)
  )
}

function alignStopsWithCandidateAvailability(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  avoidedPlaceIds: Set<string>,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  transportSegments?: TripPlan['transportSegments'],
  foodTrace?: FoodPurposeProvenance,
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
      isCandidateAllowedForStopIndex(existingCandidate, index) &&
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
      crossPlanUsedPlaceIds,
      requiredSlot,
      estimatedArrivalMinutes,
    )

    if (!replacementCandidate) {
      if (stop.placeId) usedPlaceIds.add(stop.placeId)
      return stop
    }

    usedPlaceIds.add(replacementCandidate.placeId)
    const replacementStop = applyCandidateToStop(stop, replacementCandidate)
    recordFoodReplacement(foodTrace, stop, replacementStop, 'safety')

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
  crossPlanUsedPlaceIds: Set<string>,
  requiredSlot: string,
  estimatedArrivalMinutes: number,
) {
  const rawBasePool =
    stop.type === 'food'
      ? getCandidatePoolByStopType(stop, candidates)
      : index === 0 && candidates.firstStopCandidates.length > 0
      ? preferNonShortVisitCandidates(candidates.firstStopCandidates)
      : getCandidatePoolByStopType(stop, candidates)
  const basePool = filterCandidatePoolForStopIndex(rawBasePool, index)
  const rawFallbackPool =
    stop.type === 'food'
      ? rawBasePool
      : index === 0 && candidates.firstStopCandidates.length > 0
      ? candidates.firstStopCandidates
      : candidates.allCandidates
  const fallbackPool = filterCandidatePoolForStopIndex(rawFallbackPool, index)
  const pools = basePool === fallbackPool ? [basePool] : [basePool, fallbackPool]

  for (const pool of pools) {
    const candidate = pickPurposeAwareReplacement(stop,
      pool.filter(
        (item) =>
          !usedPlaceIds.has(item.placeId) &&
          !avoidedPlaceIds.has(item.placeId) &&
          isCandidateAvailableForSchedule(
            item,
            requiredSlot,
            estimatedArrivalMinutes,
            applyCandidateToStop(stop, item).duration,
          ),
      ),
      crossPlanUsedPlaceIds,
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
    if (placeIdMatch) {
      const name = normalizeStopSearchText(stop.name)
      const exactNames = pool.filter(candidate => normalizeStopSearchText(candidate.name) === name)
      // Correct a conflict only with unique, already verified local evidence. Aliases,
      // ambiguous names and unsupported names continue to use the supplied ID.
      if (name && normalizeStopSearchText(placeIdMatch.name) !== name && exactNames.length === 1) {
        writeGenerateDebugLog('candidate-identity-conflict', { stopId: stop.id,
          suppliedPlaceId: stop.placeId, resolvedPlaceId: exactNames[0].placeId,
          suppliedName: stop.name, idName: placeIdMatch.name, reason: 'unique_verified_name' })
        return exactNames[0]
      }
      return placeIdMatch
    }
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

function mealPositionOrders(stops: Stop[], food: Stop, input: GenerateTripPlansRequest['input'],
  window: RequiredMealWindow) {
  const remaining = stops.filter(stop => stop.id !== food.id)
  return Array.from({ length: remaining.length + 1 }, (_, index) => {
    const order = [...remaining]
    order.splice(index, 0, food)
    const arrival = getEstimatedArrivalMinutesForStop(order, index, input)
    return { order, distance: Math.abs(arrival - getMealInsertionTargetMinutes(window)),
      aligned: isStopAlignedWithMealWindow(arrival, food.duration, window) }
  }).sort((a, b) => Number(b.aligned) - Number(a.aligned) || a.distance - b.distance)
    .filter(position => position.order[0].id !== food.id || position.aligned)
}

// Only bounded extensions within existing reasonable activity ranges. Never invent a wait stop.
function extendActivityBeforeMeal(plan: TripPlan, input: GenerateTripPlansRequest['input'],
  window: RequiredMealWindow) {
  for (let index = 1; index < plan.stops.length; index++) {
    if (plan.stops[index].type !== 'food') continue
    const arrival = getEstimatedArrivalMinutesForStop(plan.stops, index, input, plan.transportSegments)
    if (arrival >= window.start) continue
    let gap = window.start - arrival
    const stops = plan.stops.map(stop => ({ ...stop }))
    for (let before = index - 1; before >= 0 && gap > 0; before--) {
      if (stops[before].type === 'food') continue
      const extra = Math.min(gap, Math.max(0, getMaximumStopDuration(stops[before]) - stops[before].duration))
      stops[before].duration += extra
      gap -= extra
    }
    if (gap === 0) return traceDurationPlan(plan, { ...plan, stops }, 'meal_alignment')
  }
  return plan
}

async function repairRequiredMeals(plan: TripPlan, input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates, context: SupplementRouteContext, allowAdd: boolean,
  crossPlanUsed: Set<string>) {
  const timeline = await getOpeningHoursTimelineInput(plan, input)
  const mealInput = { ...input, scheduleStartTime: timeline.startTime }
  let next = { ...plan, scheduleStartTime: timeline.startTime }
  const windows = getRequiredMealWindows(mealInput)
  const repairStart = context.calls
  const known = new Map(mergeCandidatePools(candidates.allCandidates, candidates.otherCandidates,
    candidates.firstStopCandidates).map(candidate => [candidate.placeId, candidate]))
  let routesFailed = false
  for (const window of windows) {
    const roundStart = context.calls
    const missing = getMissingMealWindows(next.stops, mealInput, windows, next.transportSegments)
    if (!missing.includes(window)) continue
    context.remedy.events.push({ kind: 'meal', outcome: 'gap_observed', demandGap: window.id })
    const covered = windows.filter(meal => !missing.includes(meal))
    type MealChoice = { plan: TripPlan; loss: number; travel: number; suitability: number;
      candidate?: VerifiedPlaceCandidate }
    let choices: MealChoice[] = []
    let failedComparison = false
    const consider = async (stops: Stop[], candidate?: VerifiedPlaceCandidate) => {
      let routeComparisonCompleted = false
      const event = (outcome: string, details?: string) => context.remedy.events.push({ kind: 'meal', outcome,
        placeId: candidate?.placeId, demandGap: window.id, routeComparisonCompleted, details })
      event('considered')
      const sameOrder = !haveStopRouteEndpointsChanged(next.stops, stops)
      const routing = sameOrder ? { segments: next.transportSegments, routesFailed: false }
        : await resolveMealComparisonRoutes(context, stops, next.transportMode, roundStart)
      if (!routing) { event('comparison_budget_exhausted'); return } // No estimated comparison.
      if (routing.routesFailed) { failedComparison = true; event('route_failure'); return }
      routeComparisonCompleted = !sameOrder
      event(sameOrder ? 'existing_route_reused' : 'route_comparison_completed')
      let trial = normalizePlanTotalTime({ ...next, stops, transportSegments: routing.segments })
      if (candidate) {
        const capacity = getScheduleCapacityMinutes(input)
        const spare = capacity === null ? getDefaultStopDuration('food')
          : capacity - getPlanActualDuration(trial) + stops.find(stop => stop.placeId === candidate.placeId)!.duration
        trial = { ...trial, stops: trial.stops.map(stop => stop.placeId === candidate.placeId
          ? { ...stop, duration: Math.max(MINIMUM_MEAL_DURATION_MINUTES,
              Math.min(getDefaultStopDuration('food'), spare)) } : stop) }
      }
      trial = shrinkPlanDurationToScheduleCapacity(trial, input)
      trial = extendActivityBeforeMeal(trial, mealInput, window)
      // A 60-minute default must not hide a legal minimum-length meal. Reuse the
      // same real route; reduce only the newcomer when its own closing buffer requires it.
      if (candidate) {
        const index = trial.stops.findIndex(stop => stop.placeId === candidate.placeId)
        const arrival = getEstimatedArrivalMinutesForStop(trial.stops, index, mealInput, trial.transportSegments)
        if (!isCandidateOpenForVisit(candidate, arrival, trial.stops[index].duration)) {
          trial = { ...trial, stops: trial.stops.map((stop, i) => i === index
            ? { ...stop, duration: MINIMUM_MEAL_DURATION_MINUTES } : stop) }
        }
      }
      const capacity = getScheduleCapacityMinutes(input)
      if ((capacity && getPlanActualDuration(trial) > capacity) ||
        getFirstStopDistanceIssue(trial, input, candidates)) { event('capacity_or_first_distance_rejected'); return }
      const trialMissing = getMissingMealWindows(trial.stops, mealInput, windows, trial.transportSegments)
      if (trialMissing.includes(window) || covered.some(meal => trialMissing.includes(meal))) { event('meal_rejected'); return }
      if (!trial.stops.every((stop, index) => {
        const verified = known.get(stop.placeId ?? '')
        return verified && isCandidateOpenForVisit(verified,
          getEstimatedArrivalMinutesForStop(trial.stops, index, mealInput, trial.transportSegments), stop.duration)
      })) { event('opening_rejected'); return }
      const suitability = Math.max(...trial.stops.map((stop, index) =>
        stop.type === 'food' && isStopAlignedWithMealWindow(
          getEstimatedArrivalMinutesForStop(trial.stops, index, mealInput, trial.transportSegments),
          stop.duration, window) ? getMealSuitabilityRank(known.get(stop.placeId ?? '') ?? stop) : -1))
      event('feasible', `originalStayLoss=${getOriginalStayLoss(next.stops, trial.stops)}`)
      choices.push({ plan: trial, loss: getOriginalStayLoss(next.stops, trial.stops), suitability,
        travel: trial.transportSegments.reduce((sum, segment) => sum + segment.duration, 0), candidate })
    }
    // Prefer existing food, including a two-stop plan or a single non-food activity.
    await consider(extendActivityBeforeMeal(next, mealInput, window).stops)
    const existingFoods = next.stops.filter(stop => stop.type === 'food')
    // One start cannot serve two disjoint meal windows. Do not reroute the sole food
    // already serving another required meal just to discover that it loses that meal.
    for (const food of existingFoods.length > covered.length ? existingFoods : []) {
      const positions = mealPositionOrders(next.stops, food, mealInput, window)
        .filter(position => haveStopOrderChanged(next.stops, position.order) &&
          !getFirstStopDistanceIssue({ ...next, stops: position.order }, input, candidates)).slice(0, 2)
      await Promise.all(positions.map(position => consider(position.order)))
      if (choices.some(choice => choice.loss === 0)) break
    }
    if (choices.length === 0 && allowAdd) {
      const used = new Set(next.stops.map(stop => stop.placeId).filter((id): id is string => Boolean(id)))
      for (let candidateIndex = 0; candidateIndex < 3; candidateIndex++) {
        const candidate = selectMealCandidate(candidates, used, window, next.id, crossPlanUsed)
        if (!candidate) break
        used.add(candidate.placeId)
        const food = applyCandidateToStop({ id: buildSupplementalStopId(input, next.stops.length + 1),
          name: candidate.name, type: 'food', description: '', address: candidate.address,
          duration: getDefaultStopDuration('food') }, candidate)
        const positions = mealPositionOrders(next.stops, food, mealInput, window)
          .filter(position => !getFirstStopDistanceIssue({ ...next, stops: position.order }, input, candidates))
          .slice(0, 2)
        await Promise.all(positions.map(position => consider(position.order, candidate)))
      }
    }
    const bestScore = Math.max(...choices.map(choice => choice.candidate?.score ?? 0))
    choices = choices.filter(choice => (choice.candidate?.score ?? 0) >= bestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE)
    // Evidence is a soft tie-break inside the existing score band. It never buys
    // extra original loss or travel solely on the strength of a Places type hint.
    choices.sort((a, b) => a.loss - b.loss || a.travel - b.travel || b.suitability - a.suitability ||
      Number(crossPlanUsed.has(a.candidate?.placeId ?? '')) - Number(crossPlanUsed.has(b.candidate?.placeId ?? '')) ||
      (b.candidate?.score ?? 0) - (a.candidate?.score ?? 0))
    if (choices[0]) context.remedy.events.push({ kind: 'meal', outcome: 'selected', placeId: choices[0].candidate?.placeId,
      demandGap: window.id, details: `originalStayLoss=${choices[0].loss}` })
    if (choices[0]) next = rememberPlanTextTransition(next, traceDurationPlan(next,
      { ...choices[0].plan, scheduleStartTime: timeline.startTime }, 'meal_alignment'))
    else routesFailed ||= failedComparison
  }
  console.info('[meal-consistency-repair]', { planId: plan.id,
    comparisonRouteCalls: context.calls - repairStart, repairRouteCalls: context.totalCalls,
    missingMeals: getMissingMealWindows(next.stops, mealInput, windows, next.transportSegments).map(window => window.id),
    originalStayLoss: getOriginalStayLoss(plan.stops, next.stops) })
  return { plan: next, routesFailed }
}

export function ensureMealStopForTrip(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  planId?: string,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  transportSegments?: TripPlan['transportSegments'],
) {
  const alignedStops = realignFoodStopsForMealWindows(stops, input, transportSegments)
  const nextStops = [...alignedStops]
  const alignedSegments = haveStopOrderChanged(stops, alignedStops) ? undefined : transportSegments
  const mealWindows = getRequiredMealWindows(input)
  if (mealWindows.length === 0) return nextStops

  const missingMealWindows = getMissingMealWindows(nextStops, input, mealWindows, alignedSegments)
  if (missingMealWindows.length === 0) return nextStops

  for (const mealWindow of missingMealWindows) {
    const insertionIndex = findMealWindowInsertionIndex(
      nextStops.filter((stop) => stop.type !== 'food'),
      input,
      getMealInsertionTargetMinutes(mealWindow),
    )
    const actualInsertionIndex = getActualInsertionIndexForNonFoodPosition(nextStops, insertionIndex)
    const foodCandidate = selectMealCandidate(
      candidates,
      usedPlaceIds,
      mealWindow,
      planId,
      crossPlanUsedPlaceIds,
      actualInsertionIndex === 0,
    )
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
  transportSegments?: TripPlan['transportSegments'],
) {
  return mealWindows.filter(
    (mealWindow) =>
      !stops.some((stop, index) => {
        if (stop.type !== 'food') return false

        return isStopAlignedWithMealWindow(
          getEstimatedArrivalMinutesForStop(stops, index, input, transportSegments),
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
  _planId?: string,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  requireFirstStopDistance = false,
) {
  const foodCandidates = mergeCandidatePools(
    candidates.otherCandidates,
    candidates.allCandidates,
    candidates.firstStopCandidates,
  )
    .filter(
      (candidate) =>
        isFoodCandidate(candidate) &&
        !usedPlaceIds.has(candidate.placeId) &&
        (!requireFirstStopDistance || isFirstStopCandidateWithinDistance(candidate)),
    )

  const mealWindowCandidates = foodCandidates.filter((candidate) =>
    isCandidateOpenDuringMealWindow(candidate, mealWindow),
  )
  // No route can rescue a candidate that cannot fit even the existing 45-minute
  // minimum anywhere in this meal window. This is the same final hours rule.
  const pool = mealWindowCandidates
  const bestScore = Math.max(...pool.map(candidate => candidate.score ?? 0))

  const rankedCandidates = pool
    .sort((left, right) => {
      const leftSlotScore = getMealCandidateSlotScore(left, mealWindow)
      const rightSlotScore = getMealCandidateSlotScore(right, mealWindow)
      if (leftSlotScore !== rightSlotScore) return rightSlotScore - leftSlotScore
      const leftComparable = (left.score ?? 0) >= bestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE
      const rightComparable = (right.score ?? 0) >= bestScore - SUPPLEMENT_SIMILAR_SCORE_TOLERANCE
      if (leftComparable !== rightComparable) return Number(rightComparable) - Number(leftComparable)
      if (leftComparable) {
        const suitability = getMealSuitabilityRank(right) - getMealSuitabilityRank(left)
        if (suitability) return suitability
      }
      return (right.score ?? 0) - (left.score ?? 0)
    })

  return pickSoftDiverseCandidate(
    rankedCandidates.slice(0, Math.min(3, rankedCandidates.length)),
    crossPlanUsedPlaceIds,
  )
}

function getMealCandidateSlotScore(
  candidate: VerifiedPlaceCandidate,
  mealWindow: RequiredMealWindow,
) {
  const slots = candidate.availabilitySlots ?? []
  // The caller already checked the exact minimum-length meal window once.
  let score = 8
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
  const durationMinutes = MINIMUM_MEAL_DURATION_MINUTES
  const earliestStart = mealWindow.start
  const latestStart = mealWindow.end - 1
  if (!candidate.openingHours?.isKnown || candidate.openingHours.isNeverOpen) return false

  for (
    let arrivalMinutes = earliestStart;
    arrivalMinutes <= latestStart;
    arrivalMinutes++
  ) {
    if (
      !isStopAlignedWithMealWindow(arrivalMinutes, durationMinutes, mealWindow)
    ) {
      continue
    }

    if (isCandidateOpenForVisit(candidate, arrivalMinutes, durationMinutes)) return true
  }

  return false
}

export function realignFoodStopsForMealWindows(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  transportSegments?: TripPlan['transportSegments'],
) {
  if (stops.length < 2 || input.tags.includes('no_full_meals')) return stops
  if (!shouldMoveFoodStopsTowardMealWindow(input)) return stops
  const mealWindows = getRequiredMealWindows(input)
  if (mealWindows.length === 0) return stops
  // Preserve an already useful order, using actual route timings when available.
  if (getMissingMealWindows(stops, input, mealWindows, transportSegments).length === 0) return stops

  const foodStops = stops.filter((stop) => stop.type === 'food')
  if (foodStops.length === 0) return stops

  let nextStops = stops
  let missing = getMissingMealWindows(stops, input, mealWindows, transportSegments)
  for (const mealWindow of mealWindows) {
    if (!missing.includes(mealWindow)) continue
    for (const foodStop of foodStops) {
      const proposal = mealPositionOrders(nextStops, foodStop, input, mealWindow).find(position => {
        // Keep food ordering stable; actual route/first-stop legality is checked by the caller.
        if (position.order.filter(stop => stop.type === 'food').some((stop, i) => stop.id !== foodStops[i].id)) return false
        if (stops[0].type !== 'food' && position.order[0].id !== stops[0].id) return false
        const trialMissing = getMissingMealWindows(position.order, input, mealWindows)
        return !trialMissing.includes(mealWindow) &&
          mealWindows.filter(window => !missing.includes(window)).every(window => !trialMissing.includes(window))
      })
      if (proposal) {
        nextStops = proposal.order
        missing = getMissingMealWindows(nextStops, input, mealWindows)
        break
      }
    }
  }

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

export async function trimPlanToTimeWindow(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
  resolveRoutes: typeof repairTransportSegments = repairTransportSegments,
  diagnostics?: { session: TripCandidateDebugSession; stage: DiagnosticStageContext },
): Promise<{ plan: TripPlan; routesFailed: boolean }> {
  const allowedMinutes = getAllowedTripMinutes(input)
  if (!allowedMinutes || plan.stops.length <= 2) {
    return { plan: normalizePlanTotalTime(plan), routesFailed: false }
  }

  let nextPlan = normalizePlanTotalTime(plan)
  let routesFailed = false

  while (nextPlan.stops.length > 2 && shouldTrimTailStop(nextPlan, input)) {
    let acceptedPlan: TripPlan | null = null
    const beforeMinutes = getPlanActualDuration(nextPlan)
    // Keep the first stop; try non-food stops from the tail before redundant food.
    const removalIndexes = nextPlan.stops.map((_stop, index) => index).slice(1).reverse()
      .sort((left, right) => Number(nextPlan.stops[left].type === 'food') -
        Number(nextPlan.stops[right].type === 'food'))
    for (const removalIndex of removalIndexes) {
      const stops = nextPlan.stops.filter((_stop, index) => index !== removalIndex)
      const mealWindows = getRequiredMealWindows(input)
      // Preserve every required meal, including single-window trips.
      if (stops.filter((stop) => stop.type === 'food').length < mealWindows.length) continue
      const routeRepair = await resolveRoutes(
        nextPlan.transportSegments ?? [], stops, nextPlan.transportMode,
      )
      routesFailed = routesFailed || routeRepair.routesFailed
      if (routeRepair.routesFailed) continue
      let candidatePlan = normalizePlanTotalTime({
        ...nextPlan, stops, transportSegments: routeRepair.segments,
      })
      if (getPlanActualDuration(candidatePlan) >= beforeMinutes) continue
      const mealAlignment = await realignPlanMealsAfterTiming(candidatePlan, input, resolveRoutes)
      routesFailed = routesFailed || mealAlignment.routesFailed
      if (mealAlignment.routesFailed) continue
      candidatePlan = mealAlignment.plan
      // Recover coverage through existing stays, never by adding back a deleted stop.
      const coverageCandidate = isAboveMinimumCoverage(candidatePlan, input)
        ? candidatePlan : stretchPlanDurationToCoverage(candidatePlan, input)
      diagnostics?.session.recordPlanTransition(candidatePlan, coverageCandidate, 'repair:capacity-trim-coverage-trial', {
        ...diagnostics.stage, disposition: 'provisional', reason: 'coverage_recovery_after_capacity_removal',
      })
      candidatePlan = shrinkPlanDurationToScheduleCapacity(
        coverageCandidate, input,
      )
      if (!isAboveMinimumCoverage(candidatePlan, input)) continue
      if (getMissingMealWindows(candidatePlan.stops, input, mealWindows, candidatePlan.transportSegments).length > 0) continue
      if (getFirstStopDistanceIssue(candidatePlan, input)) continue
      if ((await getDeliveryPlanIssues(candidatePlan, input, 'capacity-trim')).length > 0) continue
      acceptedPlan = candidatePlan
      break
    }
    if (!acceptedPlan) break
    nextPlan = acceptedPlan
  }

  return { plan: nextPlan, routesFailed }
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

function isAboveDawnTailMinimumCoverage(
  plan: TripPlan,
  input: GenerateTripPlansRequest['input'],
) {
  const minimumMinutes = getDawnTailMinimumRequiredActualMinutes(input)
  if (!minimumMinutes) return true

  return getPlanActualDuration(plan) >= minimumMinutes
}

export function getDawnTailMinimumRequiredActualMinutes(input: GenerateTripPlansRequest['input']) {
  const minimumMinutes = getMinimumRequiredActualMinutes(input)
  if (!minimumMinutes) return null

  return Math.max(0, minimumMinutes - DAWN_TAIL_COVERAGE_SHORTFALL_ALLOWANCE_MINUTES)
}

export function shouldAllowDawnTailShortfall(input: GenerateTripPlansRequest['input']) {
  const window = getNormalizedTripWindowMinutes(input)
  if (!window) return false

  return (
    window.rawEnd < window.start &&
    window.rawEnd >= DAWN_CROSS_DAY_END_START_MINUTES &&
    window.rawEnd <= DAWN_CROSS_DAY_END_END_MINUTES
  )
}

export function isTailStopNearDawnTripEnd(plan: TripPlan, input: GenerateTripPlansRequest['input']) {
  const window = getNormalizedTripWindowMinutes(input)
  if (!window || !shouldAllowDawnTailShortfall(input)) return false

  const tailIndex = plan.stops.length - 1
  const tailStop = plan.stops[tailIndex]
  if (!tailStop) return false

  const arrivalMinutes = getEstimatedArrivalMinutesForStop(
    plan.stops,
    tailIndex,
    input,
    plan.transportSegments,
  )
  const leaveMinutes = arrivalMinutes + Math.max(0, Number(tailStop.duration) || 0)

  return leaveMinutes >= window.end - DAWN_TAIL_NEAR_END_MINUTES
}

function getNormalizedTripWindowMinutes(input: GenerateTripPlansRequest['input']) {
  const start = parseTimeToMinutes(input.startTime)
  const rawEnd = parseTimeToMinutes(input.endTime)

  if (start === null || rawEnd === null || rawEnd === start) return null

  return {
    start,
    rawEnd,
    end: rawEnd < start ? rawEnd + 24 * 60 : rawEnd,
  }
}

function applyCandidateToStop(stop: Stop, candidate: VerifiedPlaceCandidate): Stop {
  const nextType = getStopTypeForCandidate(stop, candidate)
  const nextStop = {
    ...stop,
    type: nextType,
    duration: Math.max(stop.duration, getMinimumStopDuration({ ...stop, type: nextType })),
    name: candidate.name,
    address: candidate.address,
    placeId: candidate.placeId,
    googleMapsUrl: candidate.googleMapsUrl,
    lat: candidate.lat,
    lng: candidate.lng,
    googleTypes: candidate.types,
    candidateRole: candidate.role,
    foodSubtype: candidate.foodSubtype,
  }
  const changedIdentity = Boolean(stop.placeId && stop.placeId !== candidate.placeId)
  const changedPurpose = stop.type !== nextType || (changedIdentity &&
    (getActivityPurpose(stop) !== getActivityPurpose(nextStop) || hasFoodPurposeConflict(stop, nextStop)))
  // A different purpose starts with the existing reasonable/default duration. Later
  // coverage/capacity repair remains free to stretch/shrink it within existing rules.
  if (changedPurpose) {
    const reasonable = getReasonableStopDuration(nextStop)
    nextStop.duration = stop.type === 'food' && nextType === 'food'
      ? Math.min(reasonable, nextStop.duration) : reasonable
  }
  else if (changedIdentity) nextStop.duration = clamp(nextStop.duration,
    getMinimumStopDuration(nextStop), getMaximumStopDuration(nextStop))
  // A food description belongs to its place; details can describe the final identity.
  if ((changedIdentity || changedPurpose) && (stop.type === 'food' || nextType === 'food')) nextStop.description = ''
  return nextStop
}

function getStopTypeForCandidate(stop: Stop, candidate: VerifiedPlaceCandidate): Stop['type'] {
  const candidateType = inferStopTypeFromCandidate(candidate)

  if (candidateType === 'food' || stop.type === 'food') return candidateType
  return stop.type
}

export async function expandStopsForLongTrip(
  stops: Stop[],
  input: GenerateTripPlansRequest['input'],
  candidates: NearbyPlaceCandidates,
  usedPlaceIds: Set<string>,
  planId?: string,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
  transportSegments?: TripPlan['transportSegments'],
  transportMode: TripPlan['transportMode'] = input.transportMode ?? 'scooter',
  routeContext: SupplementRouteContext = createSupplementRouteContext(),
) {
  const minimumMinutes = getMinimumRequiredActualMinutes(input)
  const unchanged = { stops, segments: transportSegments ?? [], routesFailed: false }
  if (!minimumMinutes) { routeContext.remedy.events.push({ kind: 'supplement', outcome: 'unknown_coverage_window' }); return unchanged }
  // Coverage is a minimum, not a reason to replace useful stays with more travel.
  const expansionTargetMinutes = minimumMinutes
  // A missing, estimated, or stale route cannot establish spare capacity.
  if (!transportSegments || !hasCurrentRouteTimings(stops, transportSegments)) { routeContext.remedy.events.push({ kind: 'supplement', outcome: 'route_timings_unverified' }); return unchanged }
  const capacity = getScheduleCapacityMinutes(input) ?? 0
  const expandedStops = [...stops]
  let currentSegments = transportSegments
  let routesFailed = false
  const actualMinutes = () => stopsDuration(expandedStops) +
    currentSegments.reduce((total, segment) => total + segment.duration, 0)

  const allCandidatePool = mergeCandidatePools(
    candidates.otherCandidates,
    candidates.firstStopCandidates,
    candidates.allCandidates,
  )
  routeContext.remedy.events.push({ kind: 'supplement', outcome: 'existing_pool_observed',
    details: `candidateCount=${allCandidatePool.length};source=existing_nearby_candidates` })
  const baseCandidatePool = preferNonShortVisitCandidates(allCandidatePool)
  const mainActivityPool = baseCandidatePool.filter(
    (candidate) => inferStopTypeFromCandidate(candidate) !== 'food',
  )
  const candidatePool = mainActivityPool.length > 0 ? mainActivityPool : baseCandidatePool
  let supplementalSelectionIndex = 0

  while (
    supplementalSelectionIndex < allCandidatePool.length &&
    actualMinutes() < capacity && actualMinutes() < expansionTargetMinutes
  ) {
    const options = {
      stops: expandedStops, segments: currentSegments, input, capacity,
      allCandidates: allCandidatePool, used: usedPlaceIds, crossPlanUsed: crossPlanUsedPlaceIds,
      mode: transportMode, context: routeContext,
      makeStop: (candidate: VerifiedPlaceCandidate) => applyCandidateToStop({
        id: buildSupplementalStopId(input, expandedStops.length + 1), name: candidate.name,
        type: inferStopTypeFromCandidate(candidate), description: '', address: candidate.address,
        duration: getDefaultStopDuration(inferStopTypeFromCandidate(candidate)),
      }, candidate),
    }
    let comparison = await chooseSupplementalInsertion({ ...options, pool: candidatePool })
    // Share the same round and plan budgets on the broad-pool fallback.
    if (!comparison.choice && comparison.calls === 0 && candidatePool !== allCandidatePool) {
      comparison = await chooseSupplementalInsertion({ ...options, pool: allCandidatePool })
    }
    if (!comparison.choice) {
      routesFailed = comparison.routesFailed
      break
    }
    const choice = comparison.choice
    usedPlaceIds.add(choice.candidate.placeId)
    expandedStops.splice(0, expandedStops.length, ...choice.stops)
    currentSegments = choice.segments
    supplementalSelectionIndex++
    console.info('[supplement-quality-choice]', { planId, placeId: choice.candidate.placeId,
      score: choice.candidate.score, insertionIndex: choice.index, deltaTravel: choice.deltaTravel,
      activityMinutes: choice.activityMinutes, insertionStayLoss: getOriginalStayLoss(stops, choice.stops), routeCalls: comparison.calls,
      planRouteCalls: routeContext.calls })
  }

  if (expandedStops.length !== stops.length) {
    console.info('[coverage-supplemental-stops-added]', {
      originalStopCount: stops.length,
      expandedStopCount: expandedStops.length,
      targetMinutes: expansionTargetMinutes,
      actualMinutes: actualMinutes(),
      candidateCount: allCandidatePool.length,
      routeCalls: routeContext.calls,
    })
  }

  return { stops: expandedStops, segments: currentSegments, routesFailed }
}

function stopsDuration(stops: Stop[]) {
  return stops.reduce((total, stop) => total + stop.duration, 0)
}

function hasCurrentRouteTimings(stops: Stop[], segments?: TripPlan['transportSegments']) {
  return Boolean(segments && segments.length === Math.max(0, stops.length - 1) &&
    segments.every((segment, index) => segment.fromStopId === stops[index].id &&
      segment.toStopId === stops[index + 1].id && Number.isFinite(segment.duration) &&
      segment.duration > 0 && !segment.label?.includes('(估算)')))
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

export function selectSupplementalCandidate(
  candidatePool: VerifiedPlaceCandidate[],
  usedPlaceIds: Set<string>,
  estimatedArrivalMinutes: number,
  _rotationOffset = 0,
  crossPlanUsedPlaceIds: Set<string> = new Set(),
) {
  const unusedCandidates = candidatePool.filter((candidate) => {
    if (usedPlaceIds.has(candidate.placeId)) return false

    return isCandidateOpenForVisit(
      candidate,
      estimatedArrivalMinutes,
      getDefaultStopDuration(inferStopTypeFromCandidate(candidate)),
    )
  })
  const nonShortCandidates = unusedCandidates.filter((candidate) => !isShortVisitCandidate(candidate))
  const pool = (nonShortCandidates.length > 0 ? nonShortCandidates : unusedCandidates)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  return pickSoftDiverseCandidate(pool, crossPlanUsedPlaceIds)
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
  // Use the same verified venue evidence as Candidate classification. Ancillary
  // dining metadata remains available, but does not turn a cultural visit into
  // food or make it a required-meal candidate. Ambiguous/default roles fall through.
  if (hasConfirmedCulturalPrimaryPurpose(candidate)) return false
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

function getOriginalStayLoss(originals: Stop[], finalStops: Stop[]) {
  return originals.reduce((loss, original) => loss + Math.max(0, original.duration -
    (finalStops.find(stop => stop.id === original.id && stop.placeId === original.placeId)?.duration ?? 0)), 0)
}

function extendExistingActivitiesToMinimum(
  plan: TripPlan, input: GenerateTripPlansRequest['input'], candidates: NearbyPlaceCandidates,
) {
  const minimum = getMinimumRequiredActualMinutes(input)
  let remaining = (minimum ?? 0) - getPlanActualDuration(plan)
  if (remaining <= 0 || !hasCurrentRouteTimings(plan.stops, plan.transportSegments)) return plan
  const known = new Map(mergeCandidatePools(candidates.allCandidates, candidates.firstStopCandidates,
    candidates.otherCandidates).map(candidate => [candidate.placeId, candidate]))
  const coveredMeals = getRequiredMealWindows(input).filter(window => !getMissingMealWindows(
    plan.stops, input, [window], plan.transportSegments).length)
  let stops = plan.stops.map(stop => ({ ...stop }))
  const order = stops.map((stop, index) => ({ index, weight: getStopStretchWeight(stop) }))
    .filter(({ index, weight }) => weight > 0 && (stops[index].type !== 'food' ||
      coveredMeals.some(window => isStopAlignedWithMealWindow(
        getEstimatedArrivalMinutesForStop(stops, index, input, plan.transportSegments), stops[index].duration, window))))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  // Existing duration bounds and weights define reasonable room. Check the full downstream
  // timeline for each increment; no waiting time or new scoring weight is introduced.
  while (remaining > 0) {
    let progress = false
    for (const { index, weight } of order) {
      const room = getMaximumStopDuration(stops[index]) - stops[index].duration
      let increment = Math.min(room, Math.max(5, weight * 5), remaining)
      while (increment > 0) {
        const trial = stops.map((stop, i) => i === index ? { ...stop, duration: stop.duration + increment } : stop)
        const open = trial.every((stop, i) => {
          const candidate = known.get(stop.placeId ?? '')
          return candidate && isCandidateOpenForVisit(candidate,
            getEstimatedArrivalMinutesForStop(trial, i, input, plan.transportSegments), stop.duration)
        })
        if (open && !getMissingMealWindows(trial, input, coveredMeals, plan.transportSegments).length) {
          stops = trial
          remaining -= increment
          progress = true
          break
        }
        increment--
      }
      if (remaining <= 0) break
    }
    if (!progress) break
  }
  // Partial stretching must not consume capacity needed by a genuinely necessary new activity.
  if (remaining > 0) return plan
  console.info('[coverage-existing-activities-extended]', { planId: plan.id,
    addedMinutes: stopsDuration(stops) - stopsDuration(plan.stops), minimumMinutes: minimum })
  return normalizePlanTotalTime(traceDurationPlan(plan, { ...plan, stops }, 'coverage_existing'))
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
  const boundedPlan = { ...plan, stops: plan.stops.map((stop, index) => ({ ...stop, duration: durations[index] })) }
  traceDurationPlan(plan, boundedPlan, 'duration_bounds')
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

  return normalizePlanTotalTime(traceDurationPlan(boundedPlan, {
    ...plan,
    stops: plan.stops.map((stop, index) => ({
      ...stop,
      duration: durations[index],
    })),
  }, 'coverage_target'))
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

  const nextPlan = normalizePlanTotalTime(traceDurationPlan(plan, {
    ...plan,
    stops: plan.stops.map((stop, index) => ({
      ...stop,
      duration: durations[index],
    })),
  }, 'capacity'))

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
  options: DeliveryPlanIssueOptions = {},
) {
  const issues = placesIssues.map(formatPlacesValidationIssue)
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  const mealCoverageIssues = options.skipMealCoverage ? [] : getRequiredMealCoverageIssues(plan, input)

  plan.stops.forEach((stop) => {
    if (stop.duration < getMinimumMeaningfulStopDuration(stop)) {
      issues.push(`${stop.name} 停留時間過短（${stop.duration} 分鐘）`)
    }
  })

  if (scheduleCapacityMinutes) {
    const actualMinutes = getPlanActualDuration(plan)
    const minimumMinutes = Math.max(
      0,
      (getMinimumRequiredActualMinutes(input) ?? 0) -
        (options.coverageShortfallAllowanceMinutes ?? 0),
    )

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
  if (endMinutes === originalStartMinutes) return input
  if (endMinutes < originalStartMinutes) endMinutes += 24 * 60

  const selectedStart = parseTimeToMinutes(plan.scheduleStartTime)
  const normalizedSelectedStart = selectedStart === null ? originalStartMinutes
    : selectedStart < originalStartMinutes ? selectedStart + 24 * 60 : selectedStart
  const searchStartMinutes = Math.max(normalizedSelectedStart,
    getOpeningHoursSearchStartMinutes(originalStartMinutes, endMinutes))
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

    return observeEvidenceCall('supabase', () => new Promise<Response>((resolve, reject) => {
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
    }))
  }
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
