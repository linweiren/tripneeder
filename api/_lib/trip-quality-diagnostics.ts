import type { TripInput, TripPlan } from '../../src/types/trip.js'
import { getEvidencePlanVersion } from './trip-acceptance-evidence.js'
import { getMealSuitability } from '../../src/services/ai/mealSuitability.js'
import { getFoodPurposeHint } from './trip-food-purpose.js'
import { resolveCandidateRankingContext } from './candidate-ranking-context.js'
import { hasConfirmedCulturalPrimaryPurpose, isCandidateOpenForVisit } from './google-places.js'
import type { NearbyPlaceCandidates, PromptCandidateSelection, VerifiedPlaceCandidate } from './google-places.js'
import { getDefaultStopDuration, getMaximumStopDuration, getMinimumStopDuration } from './trip-plan-metrics.js'
import { getRequiredMealWindows, isStopAlignedWithMealWindow, parseTimeToMinutes,
  MINIMUM_MEAL_DURATION_MINUTES, type RequiredMealWindow } from './trip-planning-rules.js'
import { getRequiredMealCoverageIssues } from './trip-quality-rules.js'
import { getEstimatedPlanArrivalMinutes } from './trip-timeline.js'

type Theme = ReturnType<typeof resolveCandidateRankingContext>['themes'][number]
type EvidenceStatus = 'confirmed' | 'not_matched' | 'insufficient_evidence' | 'unknown'
type Evidence = { status: EvidenceStatus; basis: string }
type Venue = { name: string; types?: string[]; foodSubtype?: string; role?: string }
type MealHint = ReturnType<typeof getMealSuitability>
type MealDiagnosticStop = { id: string; placeId: string | null; name: string; type: string;
  duration: number; arrivalMinutes: number; candidateRole: string | null; foodSubtype: string | null;
  meal: { classificationHint: MealHint; foodPurposeHint: string } }
type MealWindowDiagnostic = ReturnType<typeof describeMealWindows>[number]

function mealEvidenceCategory(hints: MealHint[]) {
  if (hints.includes('meal_likely')) return 'higher_meal_hint_unverified' as const
  if (hints.length && hints.every(hint => hint === 'refreshment_likely')) return 'refreshment_hint_only' as const
  return 'insufficient_evidence' as const
}

// No route resolution, speculative repair, or menu inference. Same-slot hours are
// a partial check only, even when every counted visit passes the existing buffer.
function describeMealWindows(windows: RequiredMealWindow[], stops: MealDiagnosticStop[],
  candidates: VerifiedPlaceCandidate[], poolObserved: boolean) {
  return windows.map(window => {
    const countedStops = stops.filter(stop => stop.type === 'food' &&
      isStopAlignedWithMealWindow(stop.arrivalMinutes, stop.duration, window)).map(stop => ({
      stopId: stop.id, placeId: stop.placeId, name: stop.name, arrivalMinutes: stop.arrivalMinutes,
      duration: stop.duration, candidateRole: stop.candidateRole, foodSubtype: stop.foodSubtype,
      mealSuitability: stop.meal.classificationHint, foodPurposeHint: stop.meal.foodPurposeHint,
      evidenceCategory: mealEvidenceCategory([stop.meal.classificationHint]), menuServiceEvidence: 'unknown',
    }))
    const evidenceCategory = mealEvidenceCategory(countedStops.map(stop => stop.mealSuitability))
    const higherHintCandidates = evidenceCategory === 'higher_meal_hint_unverified' ? [] : candidates
      .filter(candidate => !stops.some(stop => stop.placeId === candidate.placeId))
      .map(candidate => ({ placeId: candidate.placeId, name: candidate.name, candidateRole: candidate.role ?? null,
        foodSubtype: candidate.foodSubtype ?? null, mealSuitability: getMealSuitability(candidate),
        googleTypes: [...(candidate.types ?? [])], score: candidate.score ?? null,
        openingHoursKnown: candidate.openingHours?.isKnown ?? false, menuServiceEvidence: 'unknown',
        sameSlotOpeningChecks: countedStops.map(stop => ({ replacesStopId: stop.stopId,
          arrivalMinutes: stop.arrivalMinutes, duration: stop.duration,
          status: !candidate.openingHours?.isKnown ? 'unknown'
            : isCandidateOpenForVisit(candidate, stop.arrivalMinutes, stop.duration) ? 'fits' : 'does_not_fit' })),
        fullReplacementFeasibility: 'unknown',
        feasibilityBasis: 'no_replacement_routes_or_complete_timeline_comparison_observed',
      }))
    return { windowKey: `${window.id}:${window.start}`, id: window.id,
      startMinutes: window.start, endMinutesExclusive: window.end,
      requirementReason: 'existing_effective_window_can_fit_minimum_meal',
      minimumDurationMinutes: MINIMUM_MEAL_DURATION_MINUTES,
      numericalLegality: countedStops.length ? 'satisfied' as const : 'not_satisfied' as const,
      numericalRuleBasis: 'food_start_in_window_and_minimum_duration_not_full_delivery_validation',
      countedStops, evidenceCategory, menuServiceEvidence: 'unknown',
      candidateComparison: { poolObserved, scope: 'unused_classified_food_with_meal_likely_hint',
        higherHintCandidateCount: poolObserved ? higherHintCandidates.length : null,
        sameSlotOpeningCompatibleCount: poolObserved && countedStops.length ? higherHintCandidates.filter(candidate =>
          candidate.sameSlotOpeningChecks.some(check => check.status === 'fits')).length : null,
        fullReplacementFeasibility: 'unknown', higherHintCandidates },
    }
  })
}

function compareMealWindows(before: MealWindowDiagnostic[], after: MealWindowDiagnostic[]) {
  return [...new Set([...before, ...after].map(window => window.windowKey))].flatMap(key => {
    const a = before.find(window => window.windowKey === key), b = after.find(window => window.windowKey === key)
    if (JSON.stringify(a?.countedStops) === JSON.stringify(b?.countedStops) &&
      a?.numericalLegality === b?.numericalLegality) return []
    return [{ windowKey: key, beforeNumericalLegality: a?.numericalLegality ?? 'not_required',
      afterNumericalLegality: b?.numericalLegality ?? 'not_required',
      beforeEvidenceCategory: a?.evidenceCategory ?? 'unknown', afterEvidenceCategory: b?.evidenceCategory ?? 'unknown',
      higherMealHintLost: a?.evidenceCategory === 'higher_meal_hint_unverified' &&
        b !== undefined && b.evidenceCategory !== 'higher_meal_hint_unverified',
      beforeCountedStops: (a?.countedStops ?? []).map(stop => ({ stopId: stop.stopId, placeId: stop.placeId })),
      afterCountedStops: (b?.countedStops ?? []).map(stop => ({ stopId: stop.stopId, placeId: stop.placeId })),
    }]
  })
}
export type DiagnosticStageContext = {
  attemptId?: number
  reason?: string
  disposition?: 'provisional' | 'selected' | 'rejected'
}

// These are evidence labels, never new selection or validation rules. In particular,
// absence of a museum label cannot disprove an outdoor art/cultural experience.
function themeEvidence(theme: Theme, venue: Venue): Evidence {
  const types = venue.types ?? []
  if (theme === 'culture') {
    if (hasConfirmedCulturalPrimaryPurpose(venue)) return { status: 'confirmed', basis: 'existing_cultural_primary_purpose_helper' }
    if (!types.length) return { status: 'unknown', basis: 'no_place_type_evidence' }
    return { status: 'insufficient_evidence', basis: 'taxonomy_does_not_establish_cultural_experience' }
  }
  const expected = theme === 'coffee' ? ['cafe', 'coffee_shop'] : ['park', 'natural_feature', 'hiking_area']
  if (types.some(type => expected.includes(type))) return { status: 'confirmed', basis: 'place_types' }
  if (!types.length) return { status: 'unknown', basis: 'no_place_type_evidence' }
  // Only unambiguous, conflicting primary venue types support a negative label.
  const conflicting = theme === 'coffee' ? ['museum', 'art_gallery', 'park', 'natural_feature'] : ['cafe', 'coffee_shop', 'museum']
  if (types.some(type => conflicting.includes(type))) return { status: 'not_matched', basis: 'different_primary_venue_type' }
  return { status: 'insufficient_evidence', basis: 'taxonomy_inconclusive' }
}

function coverage(evidence: Evidence[]): EvidenceStatus {
  if (evidence.some(item => item.status === 'confirmed')) return 'confirmed'
  if (!evidence.length || evidence.some(item => item.status === 'unknown')) return 'unknown'
  if (evidence.some(item => item.status === 'insufficient_evidence')) return 'insufficient_evidence'
  return 'not_matched'
}

/** Owned only by the existing opt-in, non-production debug session. No I/O or external calls. */
export class TripQualityDiagnostics {
  private readonly input: TripInput
  private readonly intent
  private candidates: VerifiedPlaceCandidate[] = []
  private mealCandidates: VerifiedPlaceCandidate[] = []
  private promptCandidates: VerifiedPlaceCandidate[] | null = null
  private promptConfirmedEntries: Partial<Record<Theme, number>> = {}
  private poolObserved = false
  private nextAttempt = 0
  private readonly evidenceOrigins = new Map<number, ReturnType<typeof getEvidencePlanVersion>>()
  private readonly stages: ReturnType<TripQualityDiagnostics['snapshot']>[] = []
  private readonly transitions: Array<{
    phase: string; planId: string; context: DiagnosticStageContext
    beforeStage: number; afterStage: number
    coverageAddedMinutes: number | null
    mealWindows: ReturnType<typeof compareMealWindows>
    changes: Array<{ stopId: string; kind: string; beforePlaceId: string | null; afterPlaceId: string | null
      beforeDuration: number | null; afterDuration: number | null; durationDelta: number | null
      beforeMealHint: string | null; afterMealHint: string | null
      beforeFoodPurpose: string | null; afterFoodPurpose: string | null; higherMealHintLost: boolean }>
  }> = []

  constructor(input: TripInput) {
    this.input = input
    this.intent = resolveCandidateRankingContext(input)
  }

  recordCandidates(pool: NearbyPlaceCandidates) {
    this.poolObserved = true
    this.candidates = [...new Map([...pool.allCandidates, ...pool.firstStopCandidates, ...pool.otherCandidates]
      .map(candidate => [candidate.placeId, candidate])).values()]
    this.mealCandidates = this.candidates.filter(candidate => candidate.role === 'food' &&
      !hasConfirmedCulturalPrimaryPurpose(candidate) && getMealSuitability(candidate) === 'meal_likely')
  }

  recordPrompt(selection: PromptCandidateSelection) {
    this.promptCandidates = [...new Map(selection.promptCandidates.map(candidate => [candidate.placeId, candidate])).values()]
    this.promptConfirmedEntries = Object.fromEntries(this.intent.themes.map(theme => [theme,
      selection.promptCandidates.filter(candidate => themeEvidence(theme, candidate).status === 'confirmed').length]))
  }

  beginAttempt(plan: TripPlan, phase: string) {
    const attemptId = ++this.nextAttempt
    this.evidenceOrigins.set(attemptId, getEvidencePlanVersion(plan))
    this.recordStage(plan, `${phase}:input`, { attemptId, disposition: 'provisional' })
    return attemptId
  }

  recordStage(plan: TripPlan, phase: string, context: DiagnosticStageContext = {}) {
    this.stages.push(this.snapshot(plan, phase, context))
  }

  recordTransition(before: TripPlan, after: TripPlan, phase: string, context: DiagnosticStageContext = {}) {
    const from = this.snapshot(before, `${phase}:before`, context)
    const to = this.snapshot(after, `${phase}:after`, context)
    const ids = new Set([...from.stops, ...to.stops].map(stop => stop.id))
    const changes = [...ids].flatMap(id => {
      const a = from.stops.find(stop => stop.id === id)
      const b = to.stops.find(stop => stop.id === id)
      const kind = !a ? 'added' : !b ? 'removed' : a.placeId !== b.placeId || a.name !== b.name ? 'replaced'
        : a.duration !== b.duration ? 'duration_changed' : a.type !== b.type ? 'purpose_changed'
        : a.meal.classificationHint !== b.meal.classificationHint || a.meal.foodPurposeHint !== b.meal.foodPurposeHint
          ? 'meal_evidence_changed' : null
      return kind ? [{ stopId: id, kind, beforePlaceId: a?.placeId ?? null, afterPlaceId: b?.placeId ?? null,
        beforeDuration: a?.duration ?? null, afterDuration: b?.duration ?? null,
        durationDelta: a && b ? b.duration - a.duration : null,
        beforeMealHint: a?.meal.classificationHint ?? null, afterMealHint: b?.meal.classificationHint ?? null,
        beforeFoodPurpose: a?.meal.foodPurposeHint ?? null, afterFoodPurpose: b?.meal.foodPurposeHint ?? null,
        higherMealHintLost: a?.type === 'food' && a.meal.classificationHint === 'meal_likely' &&
          (!b || b.type !== 'food' || b.meal.classificationHint !== 'meal_likely') }] : []
    })
    const beforeStage = this.stages.length
    const isCoverageStep = ['repair:coverage-existing-activities', 'repair:coverage-target',
      'repair:capacity-trim-coverage-trial'].includes(phase)
    this.transitions.push({ phase, planId: before.id, context: { ...context }, beforeStage, afterStage: beforeStage + 1,
      mealWindows: compareMealWindows(from.meals.windows, to.meals.windows),
      coverageAddedMinutes: isCoverageStep ? changes.reduce((sum, change) => sum + Math.max(0, change.durationDelta ?? 0), 0) : null,
      changes })
    this.stages.push(from, to)
  }

  private snapshot(plan: TripPlan, phase: string, context: DiagnosticStageContext) {
    const timelineInput = { ...this.input, scheduleStartTime: plan.scheduleStartTime }
    const arrivals = getEstimatedPlanArrivalMinutes(plan, timelineInput)
    const mealWindows = getRequiredMealWindows(timelineInput)
    const stops = plan.stops.map((stop, index) => {
      const candidate = this.candidates.find(item => stop.placeId && item.placeId === stop.placeId)
      // Never copy AI prose, arbitrary plan fields, prompts, tokens or historical events.
      const types = candidate?.types ?? stop.googleTypes ?? []
      const venue = { name: candidate?.name ?? stop.name, types, foodSubtype: candidate?.foodSubtype ?? stop.foodSubtype }
      const themes = Object.fromEntries(this.intent.themes.map(theme => [theme, themeEvidence(theme, venue)])) as Record<Theme, Evidence>
      if (stop.type === 'food' && themes.culture?.status === 'confirmed') {
        themes.culture = { status: 'insufficient_evidence', basis: 'cultural_venue_but_food_activity_purpose' }
      }
      return {
        id: stop.id, name: stop.name, placeId: stop.placeId ?? null, type: stop.type, duration: stop.duration,
        arrivalMinutes: arrivals[index], departureMinutes: arrivals[index] + stop.duration,
        evidenceSource: candidate ? 'candidate_place_id' : types.length ? 'stop_place_types' : 'unknown',
        googleTypes: [...types], foodSubtype: venue.foodSubtype ?? null,
        candidateRole: candidate?.role ?? stop.candidateRole ?? null,
        themes,
        durationReference: { minimum: getMinimumStopDuration(stop), default: getDefaultStopDuration(stop.type),
          maximum: getMaximumStopDuration(stop), basis: 'existing_type_name_soft_reference', hardLimit: false },
        exceedsReference: stop.duration > getMaximumStopDuration(stop),
        activityEvidence: { status: 'unknown' as const, basis: 'no_verified_activity_program_or_duration_evidence' },
        meal: {
          classificationHint: getMealSuitability(venue),
          // Use existing verified-place purpose hints without copying/generated prose.
          foodPurposeHint: stop.type === 'food' ? getFoodPurposeHint({ ...stop, name: venue.name,
            googleTypes: types, foodSubtype: venue.foodSubtype, description: '' }) : 'not_food',
          // Even restaurant types are a relative hint, not verified full-meal service.
          suitability: types.length || venue.foodSubtype ? 'uncertain' : 'unknown',
          verificationBasis: 'no_verified_menu_or_meal_service_evidence',
          satisfiesExistingMealWindows: mealWindows.filter(window => stop.type === 'food' &&
            isStopAlignedWithMealWindow(arrivals[index], Number(stop.duration) || getDefaultStopDuration('food'), window))
            .map(window => window.id),
        },
      }
    })
    const requestedStart = parseTimeToMinutes(this.input.startTime)
    const requestedEnd = parseTimeToMinutes(this.input.endTime)
    const validTimeWindow = requestedStart !== null && requestedEnd !== null && requestedStart !== requestedEnd
    const noFullMeals = this.input.tags.includes('no_full_meals')
    return {
      phase, planId: plan.id, planType: plan.type, context: { ...context },
      aiVersion: getEvidencePlanVersion(plan) ?? (context.attemptId ? this.evidenceOrigins.get(context.attemptId) : null) ?? null,
      requestedStartTime: this.input.startTime, requestedEndTime: this.input.endTime,
      scheduleStartTime: plan.scheduleStartTime ?? this.input.startTime,
      startDelayMinutes: requestedStart === null ? null : (arrivals[0] ?? requestedStart) - requestedStart,
      timelineBasis: 'existing_estimated_plan_arrivals',
      transportMinutes: plan.transportSegments.reduce((sum, leg) => sum + leg.duration, 0),
      stops,
      themeCoverage: Object.fromEntries(this.intent.themes.map(theme => [theme, {
        status: coverage(stops.map(stop => stop.themes[theme])),
        confirmedStopIds: stops.filter(stop => stop.themes[theme].status === 'confirmed').map(stop => stop.id),
        experienceDepth: 'unknown', // A venue category alone cannot prove a substantive experience.
      }])),
      meals: { requestedWindows: getRequiredMealWindows(this.input).map(window => window.id),
        effectiveWindows: mealWindows.map(window => window.id),
        requirement: { status: noFullMeals ? 'user_no_full_meals' : !validTimeWindow ? 'unknown'
          : mealWindows.length ? 'required_windows' : 'no_required_window',
          basis: noFullMeals ? 'explicit_no_full_meals_tag' : !validTimeWindow ? 'invalid_or_missing_time_window'
            : mealWindows.length ? 'existing_effective_window_can_fit_minimum_meal' : 'no_feasible_required_window',
          minimumDurationMinutes: MINIMUM_MEAL_DURATION_MINUTES,
          explicitFormalMealIntent: 'unknown', customTextInterpretation: 'not_inferred' },
        windows: describeMealWindows(mealWindows, stops, this.mealCandidates, this.poolObserved),
        existingRuleIssues: getRequiredMealCoverageIssues(plan, this.input),
        formalMealServiceVerified: 'unknown', formalMealServiceRequirement: 'not_specified_by_existing_validation',
        ruleBasis: 'food_stop_meal_timing_and_minimum_duration' },
    }
  }

  buildReport(finalPlans: TripPlan[]) {
    const final = finalPlans.map(plan => this.snapshot(plan, 'final-delivery', { disposition: 'selected' }))
    return {
      version: 1,
      intent: { explicitPositiveThemes: this.intent.themes, parsingStatus: this.intent.customStatus,
        source: 'existing_candidate_ranking_context', unrecognizedIntent: this.intent.customStatus === 'unknown' },
      candidateThemes: this.intent.themes.map(theme => {
        const pool = this.candidates.map(candidate => ({ placeId: candidate.placeId, name: candidate.name,
          evidence: themeEvidence(theme, candidate), score: candidate.score ?? null,
          poolOrder: this.candidates.indexOf(candidate) + 1,
          openingHoursKnown: candidate.openingHours?.isKnown ?? false,
          availabilitySlots: [...(candidate.availabilitySlots ?? [])],
          promptExposed: this.promptCandidates === null ? null : this.promptCandidates.some(item => item.placeId === candidate.placeId) }))
        return { theme, poolObserved: this.poolObserved, promptObserved: this.promptCandidates !== null,
          eligiblePoolConfirmedCount: this.poolObserved ? pool.filter(item => item.evidence.status === 'confirmed').length : null,
          eligiblePoolUncertainCount: this.poolObserved ? pool.filter(item => ['unknown', 'insufficient_evidence'].includes(item.evidence.status)).length : null,
          eligiblePoolNotMatchedCount: this.poolObserved ? pool.filter(item => item.evidence.status === 'not_matched').length : null,
          promptConfirmedCount: this.promptCandidates === null ? null : this.promptCandidates.filter(item => themeEvidence(theme, item).status === 'confirmed').length,
          promptConfirmedEntryCount: this.promptCandidates === null ? null : this.promptConfirmedEntries[theme] ?? 0,
          promptUncertainCount: this.promptCandidates === null ? null : this.promptCandidates.filter(item => ['unknown', 'insufficient_evidence'].includes(themeEvidence(theme, item).status)).length,
          eligibilityBasis: 'existing_filtered_candidate_pool_not_full_itinerary_feasibility',
          fullItineraryFeasibility: 'unknown', candidates: pool }
      }),
      stages: this.stages,
      transitions: this.transitions,
      earliestVisible: [...this.stages, ...final].flatMap((stage, stageIndex, all) => stage.stops
        .filter(stop => !all.slice(0, stageIndex).some(earlier => earlier.planId === stage.planId &&
          earlier.stops.some(item => item.id === stop.id && item.placeId === stop.placeId && item.name === stop.name)))
        .map(stop => ({ planId: stage.planId, stopId: stop.id, placeId: stop.placeId, name: stop.name,
          phase: stage.phase, duration: stop.duration, source: 'first_observed_snapshot_not_reconstructed_raw_json' }))),
      final,
      limitations: ['Venue evidence does not prove activity content, experience depth or a full meal menu.',
        'Provisional repair attempts may be discarded; final-delivery is authoritative.',
        'AI snapshots begin after the existing parser; omitted raw fields and unsaved JSON cannot be reconstructed.',
        'Grouped meal/timing repair snapshots do not identify every internal speculative substep.'],
    }
  }
}
