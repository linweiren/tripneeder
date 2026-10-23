import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { resolveCandidateRankingContext, resolveVisitRequirements, type VisitRequirement } from './candidate-ranking-context.js'
import { hasConfirmedCulturalPrimaryPurpose, type NearbyPlaceCandidates, type VerifiedPlaceCandidate } from './google-places.js'

type Venue = { name: string; types?: string[]; role?: string; foodSubtype?: string; visitType?: Stop['type'] }
export type VisitStatus = 'satisfied' | 'alternative' | 'unmet' | 'unknown'

export function visitVenue(stop: Stop, candidates?: NearbyPlaceCandidates): Venue {
  const candidate = candidates?.allCandidates.find(item => stop.placeId && item.placeId === stop.placeId)
  return stop.googleTypes ? { name: stop.name, types: stop.googleTypes,
    role: stop.candidateRole ?? candidate?.role, foodSubtype: stop.foodSubtype ?? candidate?.foodSubtype, visitType: stop.type }
    : { ...(candidate ?? { name: stop.name, role: stop.candidateRole, foodSubtype: stop.foodSubtype }), visitType: stop.type }
}

// Attached cafe metadata on an established cultural venue is not an independent cafe visit.
export function isConfirmedCafe(venue: Venue) {
  return Boolean(venue.types?.some(type => ['cafe', 'coffee_shop'].includes(type))) &&
    (venue.role === 'food' || venue.visitType === 'food' || !hasConfirmedCulturalPrimaryPurpose(venue))
}

export function isForbiddenVisit(venue: Venue, input: TripInput) {
  return resolveCandidateRankingContext(input).avoidCoffee && isConfirmedCafe(venue)
}

export function isForbiddenStop(stop: Stop, input: TripInput, candidates?: NearbyPlaceCandidates) {
  return isForbiddenVisit(visitVenue(stop, candidates), input) || Boolean(candidates?.allCandidates.some(candidate =>
    candidate.placeId === stop.placeId && isForbiddenVisit(candidate, input)))
}

export function filterDemandCandidates(candidates: NearbyPlaceCandidates, input: TripInput): NearbyPlaceCandidates {
  if (!resolveCandidateRankingContext(input).avoidCoffee) return candidates
  const allowed = (candidate: VerifiedPlaceCandidate) => !isConfirmedCafe(candidate)
  return { allCandidates: candidates.allCandidates.filter(allowed),
    firstStopCandidates: candidates.firstStopCandidates.filter(allowed),
    otherCandidates: candidates.otherCandidates.filter(allowed) }
}

export function getForbiddenVisitIssues(plan: TripPlan, input: TripInput, candidates?: NearbyPlaceCandidates) {
  if (!resolveCandidateRankingContext(input).avoidCoffee) return []
  return [...plan.stops, ...(plan.rainBackup ?? [])]
    .filter(stop => isForbiddenStop(stop, input, candidates))
    .map(stop => `${stop.name} 不符合本次「不要咖啡廳」限制`)
}

function confirmedCulture(venue: Venue) {
  if (hasConfirmedCulturalPrimaryPurpose(venue)) return true
  const types = venue.types ?? []
  return venue.role !== 'food' && types.some(type => ['cultural_center', 'performing_arts_theater'].includes(type)) &&
    !types.some(type => ['cafe', 'coffee_shop', 'restaurant', 'park', 'natural_feature'].includes(type))
}

export function visitRequirementEvidence(requirement: VisitRequirement, venue: Venue): VisitStatus {
  const types = venue.types ?? []
  if (requirement.theme === 'culture' && confirmedCulture(venue)) {
    return !requirement.cultureTypes?.length || requirement.cultureTypes.some(type => types.includes(type))
      ? 'satisfied' : 'alternative'
  }
  if (requirement.theme === 'coffee') {
    if (isConfirmedCafe(venue)) return 'satisfied'
    if (types.includes('tea_house')) return 'alternative'
  }
  if (requirement.theme === 'outdoor' && types.some(type =>
    ['park', 'city_park', 'national_park', 'hiking_area', 'natural_feature'].includes(type))) return 'satisfied'
  // Generic attractions, historical hints and missing metadata do not disprove an activity.
  const specific = ['museum', 'art_gallery', 'cultural_center', 'performing_arts_theater', 'cafe',
    'coffee_shop', 'tea_house', 'restaurant', 'park', 'city_park', 'national_park', 'hiking_area', 'book_store', 'shopping_mall']
  if (!types.some(type => specific.includes(type)) ||
    requirement.theme === 'culture' && types.some(type => ['museum', 'art_gallery', 'cultural_center'].includes(type))) return 'unknown'
  return 'unmet'
}

export function assessVisitRequirements(plan: TripPlan, input: TripInput, candidates?: NearbyPlaceCandidates) {
  return resolveVisitRequirements(input).map(requirement => {
    const evidence = plan.stops.map(stop => {
      const venue = visitVenue(stop, candidates)
      // A cultural place used solely for food cannot establish a cultural activity.
      return requirement.theme === 'culture' && stop.type === 'food' && confirmedCulture(venue) ? 'unknown'
        : visitRequirementEvidence(requirement, venue)
    })
    const status: VisitStatus = evidence.includes('satisfied') ? 'satisfied'
      : evidence.includes('alternative') ? 'alternative' : evidence.includes('unknown') ? 'unknown' : 'unmet'
    // Venue evidence and delivery confirmation are separate from the existence
    // of other real-world options. A bounded pool cannot establish that absence.
    const fulfillment = status === 'satisfied' ? 'satisfied' : status === 'alternative' ? 'alternative' : 'not_confirmed'
    return { ...requirement, status, fulfillment, otherOptionsAvailability: 'unknown' as const }
  })
}

export function getVisitRequirementWarnings(plan: TripPlan, input: TripInput, candidates?: NearbyPlaceCandidates) {
  const requirements = assessVisitRequirements(plan, input, candidates)
  const missing = requirements.filter(item => item.fulfillment === 'not_confirmed').map(item => item.label)
  const alternatives = requirements.filter(item => item.fulfillment === 'alternative').map(item => item.label)
  return [
    ...(missing.length ? [`未安排可確認符合「${missing.join('、')}」需求的活動；已保留其他可用活動，目前無法確認是否另有合適地點。`] : []),
    ...(alternatives.length ? [`未安排可確認符合「${alternatives.join('、')}」需求的活動，已採用有相關用途證據的體驗替代。`] : []),
  ]
}
