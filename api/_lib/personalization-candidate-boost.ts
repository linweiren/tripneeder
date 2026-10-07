import type { PreferenceProfile, PreferenceScoreMap } from '../../src/services/personalization/preferenceProfile.js'
import { normalizePersonalizationGoogleTypes } from '../../src/services/personalization/googleTypeNormalization.js'
import type { VerifiedPlaceCandidate } from './google-places.js'

export type PersonalizationCandidateBoost = {
  bonus: number
  confidence: number
  rawSignal: number
  matchedSignals: string[]
}

const MAX_PERSONALIZATION_BOOST = 3
const FULL_CONFIDENCE_SAMPLE_COUNT = 15
const PROFILE_SCORE_SATURATION = 8
const MAX_GOOGLE_TYPE_MATCHES = 2
const SECOND_GOOGLE_TYPE_MATCH_WEIGHT = 0.5
const BOOST_DECIMALS = 2

const SIGNAL_WEIGHTS = {
  googleTypes: 0.45,
  candidateRole: 0.3,
  foodSubtype: 0.2,
  stopType: 0.1,
} as const

export function getPersonalizationCandidateBoost(
  candidate: VerifiedPlaceCandidate,
  profile?: PreferenceProfile | null,
): PersonalizationCandidateBoost {
  if (!profile || profile.sampleCount <= 0) {
    return emptyBoost()
  }

  const confidence = getProfileConfidence(profile.sampleCount)
  if (confidence <= 0) return emptyBoost()

  const matchedSignals: string[] = []
  const googleTypeSignal = getGoogleTypeSignal(candidate.types, profile.googleTypeScores, matchedSignals)
  const roleSignal = getSingleSignal(
    candidate.role,
    profile.candidateRoleScores,
    'candidateRole',
    matchedSignals,
  )
  const foodSubtypeSignal = getSingleSignal(
    candidate.foodSubtype,
    profile.foodSubtypeScores,
    'foodSubtype',
    matchedSignals,
  )
  const stopTypeSignal = getSingleSignal(
    inferCandidateStopType(candidate),
    profile.stopTypeScores,
    'stopType',
    matchedSignals,
  )

  const rawSignal = Math.min(
    1,
    googleTypeSignal * SIGNAL_WEIGHTS.googleTypes
      + roleSignal * SIGNAL_WEIGHTS.candidateRole
      + foodSubtypeSignal * SIGNAL_WEIGHTS.foodSubtype
      + stopTypeSignal * SIGNAL_WEIGHTS.stopType,
  )
  const bonus = roundBoost(Math.min(MAX_PERSONALIZATION_BOOST, MAX_PERSONALIZATION_BOOST * confidence * rawSignal))

  return {
    bonus,
    confidence: roundBoost(confidence),
    rawSignal: roundBoost(rawSignal),
    matchedSignals,
  }
}

export function getPersonalizedCandidateScore(
  baseScore: number,
  candidate: VerifiedPlaceCandidate,
  profile?: PreferenceProfile | null,
): { finalScore: number; boost: PersonalizationCandidateBoost } {
  const boost = getPersonalizationCandidateBoost(candidate, profile)
  const finalScore = Math.round((baseScore + boost.bonus) * 10) / 10

  return {
    finalScore,
    boost,
  }
}

export function getPersonalizationBoostCap() {
  return MAX_PERSONALIZATION_BOOST
}

export function getProfileConfidence(sampleCount: number) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0
  return Math.min(1, sampleCount / FULL_CONFIDENCE_SAMPLE_COUNT)
}

function getGoogleTypeSignal(
  types: readonly string[] | null | undefined,
  scores: PreferenceScoreMap,
  matchedSignals: string[],
) {
  const matches = normalizePersonalizationGoogleTypes(types)
    .map((type) => ({ type, signal: saturateScore(scores[type] ?? 0) }))
    .filter((match) => match.signal > 0)
    .sort((left, right) => right.signal - left.signal || left.type.localeCompare(right.type))
    .slice(0, MAX_GOOGLE_TYPE_MATCHES)

  if (matches.length === 0) return 0

  for (const match of matches) {
    matchedSignals.push(`googleType:${match.type}`)
  }

  // Only exact matches contribute; a second match adds evidence within the remaining headroom.
  const s1 = matches[0].signal
  const s2 = matches[1]?.signal ?? 0
  return s1 + SECOND_GOOGLE_TYPE_MATCH_WEIGHT * s2 * (1 - s1)
}

function getSingleSignal(
  key: string | null | undefined,
  scores: PreferenceScoreMap,
  label: string,
  matchedSignals: string[],
) {
  if (!key) return 0
  const score = scores[key] ?? 0
  if (score <= 0) return 0
  matchedSignals.push(`${label}:${key}`)
  return saturateScore(score)
}

function inferCandidateStopType(candidate: VerifiedPlaceCandidate) {
  if (candidate.role === 'food') return 'food'
  if (candidate.role === 'short_visit') return 'ending_or_transition'
  return 'main_activity'
}

function saturateScore(score: number) {
  if (!Number.isFinite(score) || score <= 0) return 0
  return score / (score + PROFILE_SCORE_SATURATION)
}

function roundBoost(value: number) {
  return Number(value.toFixed(BOOST_DECIMALS))
}

function emptyBoost(): PersonalizationCandidateBoost {
  return {
    bonus: 0,
    confidence: 0,
    rawSignal: 0,
    matchedSignals: [],
  }
}
