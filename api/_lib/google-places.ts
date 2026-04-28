/// <reference types="node" />

import type { TripPlan, Stop, TripInput } from '../../src/types/trip.js'
import type { GenerateTripPlansRequest, Persona } from '../../src/services/ai/types.js'

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY
const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText'
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places'
const FIRST_STOP_MAX_DISTANCE_KM = 2
const MIN_PLACE_MATCH_SCORE = 0.6
const PLACES_FIELD_MASK =
  'id,displayName,formattedAddress,location,rating,types,businessStatus,googleMapsUri'

interface GooglePlace {
  id: string
  displayName: {
    text: string
    languageCode: string
  }
  formattedAddress: string
  types?: string[]
  rating?: number
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY'
  googleMapsUri?: string
  location?: {
    latitude: number
    longitude: number
  }
}

interface GooglePlacesResponse {
  places?: GooglePlace[]
}

export type VerifiedPlaceCandidate = {
  name: string
  address: string
  placeId: string
  googleMapsUrl: string
  distanceKm?: number
  rating?: number
  types?: string[]
  lat?: number
  lng?: number
}

export type NearbyPlaceCandidates = {
  firstStopCandidates: VerifiedPlaceCandidate[]
  otherCandidates: VerifiedPlaceCandidate[]
  allCandidates: VerifiedPlaceCandidate[]
}

export type PlacesValidationIssue =
  | 'not_found'
  | 'low_similarity'
  | 'generic_name'
  | 'first_stop_too_far'
  | 'closed'
  | 'maps_uri_missing'

export interface PlacesValidationResult {
  validatedPlan: TripPlan
  invalidCount: number
  firstStopInvalid: boolean
  validationPerformed: boolean
  issues: Array<{
    stopId: string
    stopName: string
    reason: PlacesValidationIssue
    distanceKm?: number
  }>
}

interface ValidationContext {
  bias?: { lat: number; lng: number }
  enforceFirstStopDistance: boolean
}

function buildSearchQuery(input: TripInput, persona?: Persona): string {
  const city = input.location.name || ''
  const categoryMap: Record<string, string> = {
    date: 'romantic dating spots cafes restaurants',
    relax: 'peaceful parks spas teahouses',
    explore: 'sightseeing attractions museums landmarks',
    food: 'top rated restaurants local snacks famous food',
    outdoor: 'nature parks scenic views outdoor activities',
    indoor: 'museums malls art galleries indoor attractions',
    solo: 'bookstores quiet cafes solo friendly spots',
  }

  const tagMap: Record<string, string> = {
    not_too_tired: 'relaxing',
    indoor_first: 'indoor',
    hidden_gems: 'local favorites unique',
    short_distance: 'nearby',
    food_first: 'gourmet',
    photo_first: 'scenic photo spots',
    no_full_meals: 'light food drinks snacks',
  }

  const personaQuery = !input.category && persona?.companion ? persona.companion : ''
  const baseQuery =
    (input.category ? categoryMap[input.category] : undefined) ||
    [personaQuery, 'attractions'].filter(Boolean).join(' ')
  const tagQuery = input.tags.map((tag) => tagMap[tag]).filter(Boolean).join(' ')

  return `${city} ${baseQuery} ${tagQuery}`.trim()
}

export async function getNearbyRecommendations(request: GenerateTripPlansRequest): Promise<string> {
  return formatNearbyRecommendations(await getNearbyPlaceCandidates(request))
}

export async function getNearbyPlaceCandidates(
  request: GenerateTripPlansRequest,
): Promise<NearbyPlaceCandidates> {
  if (!GOOGLE_PLACES_API_KEY) {
    return { firstStopCandidates: [], otherCandidates: [], allCandidates: [] }
  }

  const input = request.input
  const lat = input.location.lat
  const lng = input.location.lng
  const queries = buildCandidateSearchQueries(input, request.persona)

  try {
    const results = await Promise.all(
      queries.map((textQuery) =>
        searchPlaces(textQuery, {
          bias: lat && lng ? { lat, lng } : undefined,
          maxResultCount: 20,
        }),
      ),
    )
    const places = dedupePlaces(results.flat())

    if (places.length === 0) {
      return { firstStopCandidates: [], otherCandidates: [], allCandidates: [] }
    }

    const candidates = places
      .map((place) => toVerifiedPlaceCandidate(place, lat, lng))
      .filter((candidate): candidate is VerifiedPlaceCandidate => Boolean(candidate))
      .sort((left, right) => (left.distanceKm ?? 999) - (right.distanceKm ?? 999))

    const firstStopCandidates = candidates.filter(
      (candidate) =>
        typeof candidate.distanceKm === 'number' &&
        candidate.distanceKm <= FIRST_STOP_MAX_DISTANCE_KM,
    )
    const otherCandidates = candidates.filter(
      (candidate) =>
        typeof candidate.distanceKm !== 'number' || candidate.distanceKm <= 5,
    )

    return {
      firstStopCandidates,
      otherCandidates,
      allCandidates: candidates,
    }
  } catch (error) {
    console.error('Failed to get nearby recommendations:', error)
    return { firstStopCandidates: [], otherCandidates: [], allCandidates: [] }
  }
}

export async function resolveLocation(
  name: string,
): Promise<{ lat: number; lng: number; formattedName: string } | null> {
  if (!GOOGLE_PLACES_API_KEY || !name.trim()) return null

  // 策略 1：使用 Geocoding API (對地標與模糊地址辨識度較高)
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name)}&key=${GOOGLE_PLACES_API_KEY}&language=zh-TW`
    )
    const data = await response.json()

    if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
      const result = data.results[0]
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedName: result.formatted_address,
      }
    }
  } catch (error) {
    console.error('Geocoding resolution failed:', error)
  }

  // 策略 2：回退到 Places API (若 Geocoding 沒抓到，嘗試 Places Text Search)
  try {
    const places = await searchPlaces(name, { maxResultCount: 1 })
    const place = places[0]

    if (place && place.location) {
      return {
        lat: place.location.latitude,
        lng: place.location.longitude,
        formattedName: place.displayName.text,
      }
    }
  } catch (error) {
    console.error('Places resolution failed:', error)
  }

  return null
}

export function formatNearbyRecommendations(candidates: NearbyPlaceCandidates): string {
  const nearStops = candidates.firstStopCandidates.map(formatCandidateForPrompt)
  const otherStops = candidates.otherCandidates.map(formatCandidateForPrompt)

  const sections: string[] = []
  if (nearStops.length > 0) {
    sections.push(
      [`FIRST_STOP_CANDIDATES_WITHIN_${FIRST_STOP_MAX_DISTANCE_KM}KM:`, ...nearStops].join(
        '\n',
      ),
    )
  }
  if (otherStops.length > 0) {
    sections.push(['OTHER_REAL_PLACE_CANDIDATES_WITHIN_5KM:', ...otherStops].join('\n'))
  }

  return sections.join('\n\n')
}

function buildCandidateSearchQueries(input: TripInput, persona?: Persona) {
  const name = input.location.name || ''
  const hasCoords = typeof input.location.lat === 'number' && typeof input.location.lng === 'number'
  
  // 若有座標，我們可以使用更廣泛的類別搜尋，而不必在地名後面附加關鍵字
  // 這能避免當起點是特定景點（如「境園農場」）時，搜尋結果被侷限在該景點內
  const queries = [
    buildSearchQuery(input, persona), // 原有的偏好搜尋
  ]

  if (hasCoords) {
    // 座標驅動的廣域搜尋
    queries.push(
      '熱門景點 觀光地標 attractions',
      '特色餐廳 當地美食 restaurants food',
      '咖啡廳 甜點店 cafe dessert',
      '公園 戶外休閒 parks outdoor'
    )
  } else {
    // 缺乏座標時，才依賴地名作為前綴
    queries.push(
      `${name} attractions restaurants cafes`,
      `${name} parks museums landmarks`,
      `${name} local food dessert coffee`
    )
  }

  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)))
}

function dedupePlaces(places: GooglePlace[]) {
  const seen = new Set<string>()
  return places.filter((place) => {
    if (!place.id || seen.has(place.id)) return false
    seen.add(place.id)
    return true
  })
}

function toVerifiedPlaceCandidate(
  place: GooglePlace,
  lat?: number,
  lng?: number,
): VerifiedPlaceCandidate | null {
  if (!isOperationalPlace(place) || !place.id) return null

  const distanceKm =
    lat && lng && place.location
      ? calculateDistance(lat, lng, place.location.latitude, place.location.longitude)
      : undefined

  return {
    name: place.displayName.text,
    address: place.formattedAddress,
    placeId: place.id,
    googleMapsUrl: buildGoogleMapsPlaceUrl(place),
    distanceKm,
    rating: place.rating,
    types: place.types,
    lat: place.location?.latitude,
    lng: place.location?.longitude,
  }
}

function formatCandidateForPrompt(candidate: VerifiedPlaceCandidate) {
  const distanceText =
    candidate.distanceKm === undefined ? '' : `, distance=${candidate.distanceKm.toFixed(1)}km`
  const ratingText = candidate.rating ? `, rating=${candidate.rating}` : ''

  return `- name="${candidate.name}", address="${candidate.address}", placeId="${candidate.placeId}"${distanceText}${ratingText}`
}

async function searchPlaces(
  textQuery: string,
  options: {
    bias?: { lat: number; lng: number }
    maxResultCount?: number
  } = {},
): Promise<GooglePlace[]> {
  if (!GOOGLE_PLACES_API_KEY) return []

  const response = await fetch(SEARCH_TEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': `places.${PLACES_FIELD_MASK.replaceAll(',', ',places.')}`,
    },
    body: JSON.stringify({
      textQuery,
      languageCode: 'zh-TW',
      maxResultCount: options.maxResultCount ?? 5,
      locationBias: options.bias
        ? {
            circle: {
              center: { latitude: options.bias.lat, longitude: options.bias.lng },
              radius: 5000.0,
            },
          }
        : undefined,
    }),
  })

  if (!response.ok) return []

  const data = (await response.json()) as GooglePlacesResponse
  return data.places ?? []
}

async function getPlaceById(placeId: string): Promise<GooglePlace | null> {
  if (!GOOGLE_PLACES_API_KEY || !placeId.trim()) return null

  const response = await fetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=zh-TW`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
  })

  if (!response.ok) return null

  return (await response.json()) as GooglePlace
}

async function searchPlace(
  name: string,
  address: string,
  bias?: { lat: number; lng: number },
  placeId?: string,
): Promise<{ place: GooglePlace | null; reason?: PlacesValidationIssue }> {
  if (placeId?.trim()) {
    const place = await getPlaceById(placeId)

    if (!place) {
      return { place: null, reason: 'not_found' }
    }

    if (!isOperationalPlace(place)) {
      return { place: null, reason: 'closed' }
    }

    return { place }
  }

  const query = `${name} ${address}`.trim()
  if (!query) return { place: null, reason: 'not_found' }

  const places = await searchPlaces(query, { bias, maxResultCount: 3 })
  return pickBestPlaceMatch(name, address, places)
}

function pickBestPlaceMatch(
  name: string,
  address: string,
  places: GooglePlace[],
): { place: GooglePlace | null; reason?: PlacesValidationIssue } {
  if (places.length === 0) return { place: null, reason: 'not_found' }
  if (isGenericPlaceName(name)) return { place: null, reason: 'generic_name' }

  let best: { place: GooglePlace; score: number } | null = null
  let bestOperational: { place: GooglePlace; score: number } | null = null
  for (const place of places) {
    const score = scorePlaceMatch(name, address, place)
    if (!best || score > best.score) {
      best = { place, score }
    }
    if (isOperationalPlace(place) && (!bestOperational || score > bestOperational.score)) {
      bestOperational = { place, score }
    }
  }

  if (bestOperational && bestOperational.score >= MIN_PLACE_MATCH_SCORE) {
    return { place: bestOperational.place }
  }

  if (best && best.score >= MIN_PLACE_MATCH_SCORE && !isOperationalPlace(best.place)) {
    return { place: null, reason: 'closed' }
  }

  return { place: null, reason: 'low_similarity' }
}

function isOperationalPlace(place: GooglePlace): boolean {
  return !place.businessStatus || place.businessStatus === 'OPERATIONAL'
}

function scorePlaceMatch(name: string, address: string, place: GooglePlace): number {
  const nameScore = similarityScore(name, place.displayName.text)
  const addressScore =
    address && place.formattedAddress ? similarityScore(address, place.formattedAddress) : 0
  const exactNameBonus = normalizeText(name) === normalizeText(place.displayName.text) ? 0.35 : 0

  return Math.max(nameScore, nameScore * 0.75 + addressScore * 0.25 + exactNameBonus)
}

function isGenericPlaceName(name: string): boolean {
  const normalized = normalizeText(name)
  if (!normalized) return true

  const genericNames = new Set([
    '親民餐廳',
    '特色小吃',
    '在地小吃',
    '當地小吃',
    '附近餐廳',
    '平價餐廳',
    '咖啡廳',
    '甜點店',
    '景點',
    '公園',
    '夜市',
    '餐廳',
    '小吃',
    '美食',
    '午餐',
    '晚餐',
    '早午餐',
    '市集',
    '商圈',
  ].map(normalizeText))

  if (genericNames.has(normalized)) return true

  const genericPatterns = [
    /^(附近|周邊|在地|當地|特色|推薦|熱門|平價|親民|知名|有名).{0,8}(餐廳|小吃|美食|咖啡|甜點|景點|店)$/,
    /^.{0,6}(餐廳|小吃|美食|咖啡廳|甜點店|景點)$/,
  ]

  return genericPatterns.some((pattern) => pattern.test(name.trim()))
}

function similarityScore(a: string, b: string): number {
  const left = tokenizeForSimilarity(a)
  const right = tokenizeForSimilarity(b)
  if (left.size === 0 || right.size === 0) return 0

  let intersection = 0
  left.forEach((token) => {
    if (right.has(token)) intersection++
  })

  return intersection / Math.max(left.size, right.size)
}

function tokenizeForSimilarity(value: string): Set<string> {
  const normalized = normalizeText(value)
  const tokens = new Set<string>()
  const parts = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []

  for (const part of parts) {
    tokens.add(part)
  }

  for (let index = 0; index < normalized.length - 1; index++) {
    const pair = normalized.slice(index, index + 2)
    if (/^[\u4e00-\u9fff]{2}$/.test(pair)) {
      tokens.add(pair)
    }
  }

  return tokens
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('zh-TW')
    .replace(/[()[\]{}（）【】「」『』,，.。:：;；/\\|｜\s_-]+/g, '')
    .trim()
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadiusKm * c
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

async function validateStop(
  stop: Stop,
  context: ValidationContext,
  index: number,
): Promise<{ stop: Stop; issue?: PlacesValidationResult['issues'][number] }> {
  if (isGenericPlaceName(stop.name)) {
    return {
      stop,
      issue: {
        stopId: stop.id,
        stopName: stop.name,
        reason: 'generic_name',
      },
    }
  }

  const { place: googlePlace, reason } = await searchPlace(
    stop.name,
    stop.address,
    context.bias,
    stop.placeId,
  )
  if (!googlePlace) {
    return {
      stop,
      issue: {
        stopId: stop.id,
        stopName: stop.name,
        reason: reason ?? 'not_found',
      },
    }
  }

  if (context.enforceFirstStopDistance && index === 0 && context.bias && googlePlace.location) {
    const distanceKm = calculateDistance(
      context.bias.lat,
      context.bias.lng,
      googlePlace.location.latitude,
      googlePlace.location.longitude,
    )

    if (distanceKm > FIRST_STOP_MAX_DISTANCE_KM) {
      return {
        stop,
        issue: {
          stopId: stop.id,
          stopName: stop.name,
          reason: 'first_stop_too_far',
          distanceKm,
        },
      }
    }
  }

  return {
    stop: {
      ...stop,
      name: googlePlace.displayName.text,
      address: googlePlace.formattedAddress,
      placeId: googlePlace.id,
      googleMapsUrl: buildGoogleMapsPlaceUrl(googlePlace),
      lat: googlePlace.location?.latitude,
      lng: googlePlace.location?.longitude,
    },
  }
}

function buildGoogleMapsPlaceUrl(place: Pick<GooglePlace, 'id' | 'googleMapsUri'>) {
  return place.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.id)}`
}

export async function validateStopsWithPlaces(
  plan: TripPlan,
  bias?: { lat: number; lng: number },
): Promise<PlacesValidationResult> {
  if (!GOOGLE_PLACES_API_KEY) {
    return {
      validatedPlan: plan,
      invalidCount: 0,
      firstStopInvalid: false,
      validationPerformed: false,
      issues: [],
    }
  }

  const mainResults = await Promise.all(
    plan.stops.map((stop, index) =>
      validateStop(stop, { bias, enforceFirstStopDistance: true }, index),
    ),
  )

  const rainResults = await Promise.all(
    (plan.rainBackup ?? []).map((stop, index) =>
      validateStop(stop, { bias, enforceFirstStopDistance: false }, index),
    ),
  )

  const issues = [...mainResults, ...rainResults]
    .map((result) => result.issue)
    .filter((issue): issue is PlacesValidationResult['issues'][number] => Boolean(issue))

  const firstStopInvalid = Boolean(mainResults[0]?.issue)

  return {
    validatedPlan: {
      ...plan,
      stops: mainResults.map((result) => result.stop),
      rainBackup: rainResults.map((result) => result.stop),
    },
    invalidCount: issues.length,
    firstStopInvalid,
    validationPerformed: true,
    issues,
  }
}
