import type { Stop, TripInput, TripPlan } from '../../src/types/trip.js'
import { resolveCandidateRankingContext, resolveVisitRequirements, type VisitRequirement } from './candidate-ranking-context.js'
import { hasConfirmedCulturalPrimaryPurpose, type NearbyPlaceCandidates, type VerifiedPlaceCandidate } from './google-places.js'
import { getCulturalContentEvidence } from './trip-cultural-content-evidence.js'

type Venue = { name: string; placeId?: string; lat?: number; lng?: number; types?: string[];
  role?: string; foodSubtype?: string; visitType?: Stop['type'] }
export type VisitStatus = 'satisfied' | 'alternative' | 'unmet' | 'unknown'

export function visitVenue(stop: Stop, candidates?: NearbyPlaceCandidates): Venue {
  const candidate = candidates?.allCandidates.find(item => stop.placeId && item.placeId === stop.placeId)
  return stop.googleTypes ? { name: stop.name, placeId: stop.placeId, lat: candidate?.lat ?? stop.lat,
    lng: candidate?.lng ?? stop.lng, types: stop.googleTypes,
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
  if (requirement.theme === 'culture' && venue.visitType !== 'food' && venue.role !== 'food' && getCulturalContentEvidence(venue)) {
    return !requirement.cultureTypes?.length ? 'satisfied'
      : requirement.cultureTypes.some(type => types.includes(type)) ? 'satisfied' : 'alternative'
  }
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

// An optional preference may not lose a confirmed core visit. Necessary safety
// replacement keeps its existing pool and final legality checks, not this guard.
export function preservesCoreVisitRequirements(original: Stop, replacement: VerifiedPlaceCandidate,
  input: TripInput, candidates: NearbyPlaceCandidates) {
  const before = visitVenue(original, candidates)
  const after = { ...replacement, visitType: replacement.role === 'food' ? 'food' as const : original.type }
  return resolveVisitRequirements(input).every(requirement => {
    if (visitRequirementEvidence(requirement, before) !== 'satisfied') return true
    if (visitRequirementEvidence(requirement, after) !== 'satisfied') return false
    // A venue-purpose hint cannot displace source-backed cultural content.
    return requirement.theme !== 'culture' || !getCulturalContentEvidence(before) ||
      Boolean(getCulturalContentEvidence(after))
  })
}

export function getSelectedCulturalContent(plan: TripPlan, input: TripInput, candidates?: NearbyPlaceCandidates) {
  if (!resolveVisitRequirements(input).some(requirement => requirement.theme === 'culture')) return []
  return plan.stops.filter(stop => stop.type !== 'food').flatMap(stop => {
    const evidence = getCulturalContentEvidence(visitVenue(stop, candidates))
    return evidence ? [{ name: stop.name, ...evidence }] : []
  })
}

export function getVisitRequirementContentText(plan: TripPlan, input: TripInput, candidates?: NearbyPlaceCandidates) {
  const content = getSelectedCulturalContent(plan, input, candidates)
  if (!content.length && assessVisitRequirements(plan, input, candidates).some(item =>
    item.theme === 'culture' && item.cultureTypes?.length && item.fulfillment === 'satisfied')) {
    return '文化內容說明：已安排相關場館；目前僅有場館用途資料，具體文化活動內容、當日場次、入場與體驗時間仍待確認。'
  }
  return content.length ? `已確認文化內容：${content.map(item =>
    `${item.name}（${item.content}；來源：${item.sourceUrl}）`).join('；')}。當日場次、入場條件與實際體驗時間仍待確認。` : ''
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
  // The existing assessment can establish a museum/gallery visit's venue purpose.
  // It cannot establish activity content from taxonomy. Disclose that distinction.
  const contentUnknown = requirements.some(item => item.theme === 'culture' && !item.cultureTypes?.length &&
    item.fulfillment === 'satisfied') && getSelectedCulturalContent(plan, input, candidates).length === 0
  return [
    ...(missing.length ? [`未安排可確認符合「${missing.join('、')}」需求的活動；已保留其他可用活動，目前無法確認是否另有合適地點。`] : []),
    ...(alternatives.length ? [`未安排可確認符合「${alternatives.join('、')}」需求的活動，已採用有相關用途證據的體驗替代。`] : []),
    ...(contentUnknown ? ['已安排文化場館；目前僅有場館用途資料，具體文化活動內容、當日場次、入場與體驗時間仍待確認。'] : []),
  ]
}
