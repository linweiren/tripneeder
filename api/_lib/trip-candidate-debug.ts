/// <reference types="node" />

import { appendFileSync } from 'node:fs'
import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import type {
  CandidateDebugPlace,
  CandidateSearchDebugSink,
  CandidateSearchQueryPlanDebug,
  NearbyPlaceCandidates,
  PlacesValidationResult,
  PromptCandidateSelection,
} from './google-places.js'

export const TRIP_CANDIDATE_DEBUG_ENV = 'TRIP_CANDIDATE_DEBUG'
export const TRIP_CANDIDATE_DEBUG_LOG_PATH = '.tripneeder-candidate-debug.log'

const PLAN_MODES = ['safe', 'balanced', 'explore'] as const
const DEBUG_BUCKETS = [
  'attraction',
  'food',
  'cafe',
  'shopping',
  'indoor',
  'outdoor',
  'local_lifestyle',
  'night',
  'unknown',
] as const

type DebugBucket = (typeof DEBUG_BUCKETS)[number]
type DebugEnvironment = Record<string, string | undefined>

type QueryResult = {
  phase: 'initial' | 'gap'
  query: string
  rawPlaceCount: number
}

type ValidationRecord = {
  phase: string
  planId: string
  selectedStops: DebugStop[]
  remainingStops: DebugStop[]
  excludedStops: Array<{
    stopId: string
    name: string
    reason: string
  }>
}

type RepairRecord = {
  phase: string
  planId: string
  beforeStops: DebugStop[]
  afterStops: DebugStop[]
  removedStops: DebugStop[]
  issues: string[]
  accepted: boolean
}

type DebugStop = {
  name: string
  placeId: string | null
  type: Stop['type']
}

export class TripCandidateDebugSession implements CandidateSearchDebugSink {
  private readonly createdAt = new Date().toISOString()
  private readonly input: TripInput
  private readonly queryPlans: CandidateSearchQueryPlanDebug[] = []
  private readonly queryResults: QueryResult[] = []
  private candidatePool: {
    rawCandidateCount: number
    usableCandidateCount: number
    candidates: CandidateDebugPlace[]
  } = { rawCandidateCount: 0, usableCandidateCount: 0, candidates: [] }
  private candidateSets: NearbyPlaceCandidates = {
    firstStopCandidates: [],
    otherCandidates: [],
    allCandidates: [],
  }
  private aiInput: PromptCandidateSelection | null = null
  private aiOutputs: Array<{ phase: string; plans: ReturnType<typeof summarizePlans> }> = []
  private readonly validations: ValidationRecord[] = []
  private readonly repairs: RepairRecord[] = []

  constructor(input: TripInput) {
    this.input = input
  }

  recordQueryPlan(plan: CandidateSearchQueryPlanDebug) {
    this.queryPlans.push({ ...plan, queries: [...plan.queries] })
  }

  recordQueryResult(result: QueryResult) {
    this.queryResults.push({ ...result })
  }

  recordCandidatePool(snapshot: {
    rawCandidateCount: number
    usableCandidateCount: number
    candidates: CandidateDebugPlace[]
  }) {
    this.candidatePool = {
      ...snapshot,
      candidates: snapshot.candidates.map((candidate) => ({
        ...candidate,
        types: [...candidate.types],
        availabilitySlots: [...candidate.availabilitySlots],
      })),
    }
  }

  recordCandidateSets(candidates: NearbyPlaceCandidates) {
    this.candidateSets = {
      firstStopCandidates: [...candidates.firstStopCandidates],
      otherCandidates: [...candidates.otherCandidates],
      allCandidates: [...candidates.allCandidates],
    }
  }

  recordAiInput(selection: PromptCandidateSelection) {
    this.aiInput = {
      nearStops: [...selection.nearStops],
      foodStops: [...selection.foodStops],
      mainStops: [...selection.mainStops],
      fallbackStops: [...selection.fallbackStops],
      promptCandidates: [...selection.promptCandidates],
    }
  }

  recordAiOutput(plans: TripPlan[], phase: string) {
    this.aiOutputs.push({ phase, plans: summarizePlans(plans) })
  }

  recordValidation(
    plan: TripPlan,
    validation: PlacesValidationResult,
    phase: string,
  ) {
    this.validations.push({
      phase,
      planId: plan.id,
      selectedStops: summarizeStops(plan.stops),
      remainingStops: summarizeStops(validation.validatedPlan.stops),
      excludedStops: validation.issues.map((issue) => ({
        stopId: issue.stopId,
        name: issue.stopName,
        reason: issue.reason,
      })),
    })
  }

  recordRepair(
    sourcePlan: TripPlan,
    repairedPlan: TripPlan | null,
    issues: string[],
    phase: string,
  ) {
    const afterStops = summarizeStops(repairedPlan?.stops ?? [])
    const afterKeys = new Set(afterStops.map(getDebugStopKey))
    const beforeStops = summarizeStops(sourcePlan.stops)

    this.repairs.push({
      phase,
      planId: sourcePlan.id,
      beforeStops,
      afterStops,
      removedStops: beforeStops.filter((stop) => !afterKeys.has(getDebugStopKey(stop))),
      issues: [...issues],
      accepted: Boolean(repairedPlan),
    })
  }

  buildReport(
    finalPlans: TripPlan[],
    validationSummaries: Map<string, string[]> = new Map(),
    outcome = 'completed',
  ) {
    const promptEntries = this.aiInput?.promptCandidates ?? []
    const uniquePromptCandidates = uniqueByPlace(promptEntries)
    const promptPlaceIds = new Set(uniquePromptCandidates.map((candidate) => candidate.placeId))
    const usableCandidates = this.candidatePool.candidates.filter((candidate) => !candidate.excluded)
    const finalPlanSummary = summarizePlans(finalPlans)

    return {
      version: 1,
      createdAt: this.createdAt,
      outcome,
      input: {
        location: { ...this.input.location },
        startTime: this.input.startTime,
        endTime: this.input.endTime,
        modes: [...PLAN_MODES],
      },
      queryLayer: {
        batches: this.queryPlans.map((plan) => ({
          ...plan,
          results: plan.queries.map((query) => ({
            query,
            rawPlaceCount:
              this.queryResults.find(
                (result) => result.phase === plan.phase && result.query === query,
              )?.rawPlaceCount ?? 0,
          })),
        })),
        rawPlacesReturnedAcrossQueries: this.queryResults.reduce(
          (total, result) => total + result.rawPlaceCount,
          0,
        ),
        finalUniqueRawCandidateCount: this.candidatePool.rawCandidateCount,
      },
      candidatePool: {
        rawCandidateCount: this.candidatePool.rawCandidateCount,
        usableCandidateCount: this.candidatePool.usableCandidateCount,
        firstStopCandidateCount: this.candidateSets.firstStopCandidates.length,
        otherCandidateCount: this.candidateSets.otherCandidates.length,
        firstStopRejectionBreakdown: countFirstStopRejectionReasons(
          this.candidatePool.candidates,
        ),
        buckets: countCandidateBuckets(usableCandidates),
        bucketCounting: 'multi_label',
        candidates: this.candidatePool.candidates.map((candidate) => ({
          ...candidate,
          buckets: getCandidateBuckets(candidate),
          sentToAi: Boolean(candidate.placeId && promptPlaceIds.has(candidate.placeId)),
        })),
      },
      aiInput: {
        promptEntryCount: promptEntries.length,
        uniqueCandidateCount: uniquePromptCandidates.length,
        candidateNames: uniquePromptCandidates.map((candidate) => candidate.name),
        candidateFields: [
          'name',
          'address',
          'placeId',
          'distance',
          'rating',
          'role',
          'foodSubtype',
          'score',
          'hours',
          'bestSlots',
        ],
        plans: Object.fromEntries(
          PLAN_MODES.map((mode) => [
            mode,
            uniquePromptCandidates.map((candidate) => ({
              name: candidate.name,
              placeId: candidate.placeId,
            })),
          ]),
        ),
        sameCandidatePoolForAllPlans: true,
      },
      aiOutput: this.aiOutputs,
      resultLayer: {
        validations: this.validations,
        repairs: this.repairs,
        rejectedPlans: [...validationSummaries].map(([planId, issues]) => ({
          planId,
          issues: [...issues],
        })),
        finalDeliveryPlans: finalPlanSummary,
      },
      diversity: analyzeDiversity(finalPlans, this.candidatePool.candidates, this.candidateSets),
    }
  }
}

export function isTripCandidateDebugEnabled(env: DebugEnvironment = process.env) {
  return env.NODE_ENV !== 'production' && env[TRIP_CANDIDATE_DEBUG_ENV] === 'true'
}

export function createTripCandidateDebugSession(
  input: TripInput,
  env: DebugEnvironment = process.env,
) {
  return isTripCandidateDebugEnabled(env) ? new TripCandidateDebugSession(input) : null
}

export function writeTripCandidateDebugReport(
  session: TripCandidateDebugSession | null,
  finalPlans: TripPlan[],
  validationSummaries: Map<string, string[]> = new Map(),
  outcome = 'completed',
  options: {
    env?: DebugEnvironment
    append?: typeof appendFileSync
    log?: (label: string, report: unknown) => void
    path?: string
  } = {},
) {
  const env = options.env ?? process.env
  if (!session || !isTripCandidateDebugEnabled(env)) return null

  const report = session.buildReport(finalPlans, validationSummaries, outcome)
  try {
    options.log?.('[trip-candidate-debug-report]', report)
    ;(options.append ?? appendFileSync)(
      options.path ?? TRIP_CANDIDATE_DEBUG_LOG_PATH,
      `${JSON.stringify({ event: 'trip-candidate-debug-report', report })}\n`,
      'utf8',
    )
  } catch {
    // Debug reporting is observational and must never affect trip generation.
  }

  return report
}

function summarizePlans(plans: TripPlan[]) {
  return plans.map((plan) => ({
    planId: plan.id,
    type: plan.type,
    stops: summarizeStops(plan.stops),
  }))
}

function summarizeStops(stops: Stop[]): DebugStop[] {
  return stops.map((stop) => ({
    name: stop.name,
    placeId: stop.placeId ?? null,
    type: stop.type,
  }))
}

function getDebugStopKey(stop: Pick<DebugStop, 'name' | 'placeId'>) {
  return stop.placeId || normalizeName(stop.name)
}

function uniqueByPlace<T extends { placeId: string; name: string }>(items: T[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.placeId || normalizeName(item.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function countCandidateBuckets(candidates: CandidateDebugPlace[]) {
  const counts = Object.fromEntries(DEBUG_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    DebugBucket,
    number
  >

  candidates.forEach((candidate) => {
    getCandidateBuckets(candidate).forEach((bucket) => {
      counts[bucket] += 1
    })
  })

  return counts
}

function countFirstStopRejectionReasons(candidates: CandidateDebugPlace[]) {
  const counts: Record<string, number> = {
    distance_over_2km: 0,
    unknown_opening_hours: 0,
    no_opening_overlap: 0,
    closing_buffer: 0,
    minimum_visit_duration: 0,
  }

  candidates.forEach((candidate) => {
    if (!candidate.firstStopRejectionReason) return

    counts[candidate.firstStopRejectionReason] =
      (counts[candidate.firstStopRejectionReason] ?? 0) + 1
  })

  return counts
}

function getCandidateBuckets(candidate: CandidateDebugPlace): DebugBucket[] {
  const types = new Set(candidate.types)
  const text = candidate.name.toLocaleLowerCase('zh-TW')
  const buckets = new Set<DebugBucket>()

  if (
    ['main_activity', 'open_space'].includes(candidate.role ?? '') ||
    hasAnyType(types, ['tourist_attraction', 'museum', 'art_gallery', 'amusement_park', 'zoo'])
  ) buckets.add('attraction')
  if (candidate.role === 'food') buckets.add('food')
  if (types.has('cafe') || /(咖啡|coffee|cafe|珈琲)/i.test(text)) buckets.add('cafe')
  if (candidate.role === 'shopping' || hasAnyType(types, ['shopping_mall', 'department_store'])) {
    buckets.add('shopping')
  }
  if (
    hasAnyType(types, [
      'museum',
      'art_gallery',
      'shopping_mall',
      'department_store',
      'book_store',
      'movie_theater',
      'aquarium',
      'cafe',
      'restaurant',
    ])
  ) buckets.add('indoor')
  if (
    candidate.role === 'open_space' ||
    hasAnyType(types, ['park', 'natural_feature', 'hiking_area', 'beach', 'marina', 'zoo'])
  ) buckets.add('outdoor')
  if (
    hasAnyType(types, ['market', 'book_store', 'community_center', 'cultural_center']) ||
    /(老街|市場|市集|文創|眷村|文化|生活)/.test(text)
  ) buckets.add('local_lifestyle')
  if (
    hasAnyType(types, ['night_club', 'bar']) ||
    candidate.availabilitySlots.includes('late') ||
    /(夜市|夜景|深夜|酒吧)/.test(text)
  ) buckets.add('night')
  if (buckets.size === 0) buckets.add('unknown')

  return [...buckets]
}

function hasAnyType(types: Set<string>, expected: string[]) {
  return expected.some((type) => types.has(type))
}

function analyzeDiversity(
  plans: TripPlan[],
  candidates: CandidateDebugPlace[],
  candidateSets: NearbyPlaceCandidates,
) {
  const locationPlans = new Map<string, { name: string; placeId: string | null; planIds: Set<string> }>()
  const pairwiseOverlap: Array<{
    plans: [string, string]
    sharedCount: number
    overlapRatio: number
    sharedLocations: string[]
  }> = []

  plans.forEach((plan) => {
    const seenInPlan = new Set<string>()
    plan.stops.forEach((stop) => {
      const key = stop.placeId || normalizeName(stop.name)
      if (!key || seenInPlan.has(key)) return
      seenInPlan.add(key)
      const location = locationPlans.get(key) ?? {
        name: stop.name,
        placeId: stop.placeId ?? null,
        planIds: new Set<string>(),
      }
      location.planIds.add(plan.id)
      locationPlans.set(key, location)
    })
  })

  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex]
      const right = plans[rightIndex]
      const leftLocations = getPlanLocationMap(left)
      const rightLocations = getPlanLocationMap(right)
      const sharedKeys = [...leftLocations.keys()].filter((key) => rightLocations.has(key))
      pairwiseOverlap.push({
        plans: [left.id, right.id],
        sharedCount: sharedKeys.length,
        overlapRatio: roundRatio(
          sharedKeys.length / Math.max(1, Math.min(leftLocations.size, rightLocations.size)),
        ),
        sharedLocations: sharedKeys.map((key) => leftLocations.get(key) ?? key),
      })
    }
  }

  const repeatedLocations = [...locationPlans.values()]
    .filter((location) => location.planIds.size >= 2)
    .map((location) => {
      const candidate = candidates.find(
        (item) =>
          (location.placeId && item.placeId === location.placeId) ||
          normalizeName(item.name) === normalizeName(location.name),
      )
      const possibleReasons = ['all_plans_share_the_same_ai_candidate_pool']
      if (candidate?.score !== null && candidate?.score !== undefined) {
        possibleReasons.push('candidate_is_ranked_by_score_before_ai_and_repair_fallbacks')
      }
      if (
        candidateSets.firstStopCandidates.some(
          (item) => item.placeId === location.placeId || item.name === location.name,
        )
      ) {
        possibleReasons.push('candidate_is_eligible_for_the_strict_first_stop_window')
      }

      return {
        name: location.name,
        placeId: location.placeId,
        planIds: [...location.planIds],
        possibleReasons,
      }
    })
  const totalSelections = [...locationPlans.values()].reduce(
    (total, location) => total + location.planIds.size,
    0,
  )
  const repeatedSelections = repeatedLocations.reduce(
    (total, location) => total + location.planIds.length - 1,
    0,
  )

  return {
    withinPlans: plans.map((plan) => analyzePlanTypeConcentration(plan, candidates)),
    pairwiseOverlap,
    crossPlanRepeatedSelectionRatio: roundRatio(repeatedSelections / Math.max(1, totalSelections)),
    samePlaceAppearsInTwoOrMorePlans: repeatedLocations.length > 0,
    repeatedLocations,
    existingControls: {
      aiPromptSoftDiversity: true,
      localCoverageSupplementRotationByPlan: true,
      crossPlanScorePenalty: false,
      crossPlanHardDeduplication: false,
      finalOverlapDiagnosticOnly: true,
    },
  }
}

function analyzePlanTypeConcentration(plan: TripPlan, candidates: CandidateDebugPlace[]) {
  const counts: Record<string, number> = {}

  plan.stops.forEach((stop) => {
    const candidate = candidates.find(
      (item) =>
        (stop.placeId && item.placeId === stop.placeId) ||
        normalizeName(item.name) === normalizeName(stop.name),
    )
    const primaryBucket = candidate ? getCandidateBuckets(candidate)[0] : stop.type
    counts[primaryBucket] = (counts[primaryBucket] ?? 0) + 1
  })

  const overrepresentedTypes = Object.entries(counts)
    .filter(([, count]) => count >= 3 && count / Math.max(1, plan.stops.length) >= 0.6)
    .map(([type, count]) => ({ type, count }))

  return {
    planId: plan.id,
    typeCounts: counts,
    hasTooManyOfOneType: overrepresentedTypes.length > 0,
    overrepresentedTypes,
  }
}

function getPlanLocationMap(plan: TripPlan) {
  return new Map(
    plan.stops.map((stop) => [stop.placeId || normalizeName(stop.name), stop.name]),
  )
}

function normalizeName(value: string) {
  return value.toLocaleLowerCase('zh-TW').replace(/\s+/g, '').trim()
}

function roundRatio(value: number) {
  return Math.round(value * 1000) / 1000
}
