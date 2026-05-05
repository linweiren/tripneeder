/// <reference types="node" />

import https from 'node:https'
import type { TripPlan, Stop, TripInput } from '../../src/types/trip.js'
import type { GenerateTripPlansRequest, Persona } from '../../src/services/ai/types.js'

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY
const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText'
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places'
const FIRST_STOP_MAX_DISTANCE_KM = 2
const MAIN_CANDIDATE_MAX_DISTANCE_KM = 5
const BACKUP_CANDIDATE_MAX_DISTANCE_KM = 10
const MIN_MAIN_CANDIDATES = 18
const MIN_FIRST_STOP_CANDIDATES = 4
const MIN_FOOD_CANDIDATES = 6
const MIN_ACTIVITY_CANDIDATES = 12
const MIN_INDOOR_CANDIDATES = 8
const MAX_GAP_SEARCH_QUERIES = 6
const MIN_PLACE_MATCH_SCORE = 0.6
const CLOSING_BUFFER_MINUTES = 30
const MIN_CANDIDATE_VISIT_MINUTES = 40
const MIN_FOOD_CANDIDATE_VISIT_MINUTES = 45
const EARLY_MORNING_ACTIVE_START_MINUTES = 6 * 60
const MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES = MIN_CANDIDATE_VISIT_MINUTES * 2 + 18
const PLACES_FIELD_MASK =
  'id,displayName,formattedAddress,location,rating,types,businessStatus,googleMapsUri,currentOpeningHours,regularOpeningHours,utcOffsetMinutes'

const placeDetailsCache = new Map<string, GooglePlace | null>()

type GoogleOpeningHoursPoint = {
  date?: {
    year?: number
    month?: number
    day?: number
  }
  day?: number
  hour?: number
  minute?: number
}

type GoogleOpeningHoursPeriod = {
  open?: GoogleOpeningHoursPoint
  close?: GoogleOpeningHoursPoint
}

type GoogleOpeningHours = {
  periods?: GoogleOpeningHoursPeriod[]
  weekdayDescriptions?: string[]
  openNow?: boolean
}

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
  currentOpeningHours?: GoogleOpeningHours
  regularOpeningHours?: GoogleOpeningHours
  utcOffsetMinutes?: number
  location?: {
    latitude: number
    longitude: number
  }
}

interface GooglePlacesResponse {
  places?: GooglePlace[]
}

type GoogleGeocodeResponse = {
  status?: string
  results?: Array<{
    formatted_address: string
    geometry?: {
      location?: {
        lat: number
        lng: number
      }
    }
  }>
}

export type VerifiedPlaceCandidate = {
  name: string
  address: string
  placeId: string
  googleMapsUrl: string
  distanceKm?: number
  rating?: number
  types?: string[]
  role?: 'food' | 'main_activity' | 'open_space' | 'shopping' | 'short_visit'
  foodSubtype?: 'cafe' | 'dessert' | 'restaurant' | 'snack'
  score?: number
  openingHours?: OpeningHoursMetadata
  openingHoursSummary?: string
  availabilitySlots?: string[]
  lat?: number
  lng?: number
}

type OpeningWindow = {
  openAt: Date
  closeAt: Date
}

type OpeningHoursMetadata = {
  windows: OpeningWindow[]
  source: 'current' | 'regular'
  utcOffsetMinutes?: number
  isKnown: boolean
  isNeverOpen: boolean
}

type CandidateGaps = {
  needsFirstStop: boolean
  needsFood: boolean
  needsMainActivity: boolean
  needsIndoor: boolean
  needsEvening: boolean
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
  | 'unknown_opening_hours'
  | 'outside_opening_hours'
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
    arrivalTime?: string
    leaveTime?: string
    openingWindows?: string[]
  }>
}

export type OpeningHoursValidationIssue = {
  stopId: string
  stopName: string
  reason: 'unknown_opening_hours' | 'outside_opening_hours'
  arrivalTime?: string
  leaveTime?: string
  openingWindows?: string[]
}

export type OpeningHoursTimelineResolution = {
  startMinutes: number | null
  issues: OpeningHoursValidationIssue[]
}

type MinuteInterval = {
  start: number
  end: number
}

interface ValidationContext {
  bias?: { lat: number; lng: number }
  enforceFirstStopDistance: boolean
  input?: TripInput
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
          radiusMeters: MAIN_CANDIDATE_MAX_DISTANCE_KM * 1000,
        }),
      ),
    )
    let places = dedupePlaces(results.flat())

    if (places.length === 0) {
      return { firstStopCandidates: [], otherCandidates: [], allCandidates: [] }
    }

    const tripWindow = buildTripWindow(input)
    let candidates = prepareCandidates(places, input, tripWindow, lat, lng)
    const candidateGaps = getCandidateGaps(candidates, input)
    const gapQueries = buildCandidateGapSearchQueries(input, request.persona, candidateGaps)

    if (gapQueries.length > 0) {
      const knownPlaceIds = new Set(places.map((place) => place.id).filter(Boolean))
      const gapResults = await Promise.all(
        gapQueries.map((textQuery) =>
          searchPlaces(textQuery, {
            bias: lat && lng ? { lat, lng } : undefined,
            maxResultCount: 20,
            radiusMeters: BACKUP_CANDIDATE_MAX_DISTANCE_KM * 1000,
          }),
        ),
      )
      const newPlaces = dedupePlaces(gapResults.flat()).filter(
        (place) => place.id && !knownPlaceIds.has(place.id),
      )

      if (newPlaces.length > 0) {
        places = dedupePlaces([...places, ...newPlaces])
        candidates = prepareCandidates(places, input, tripWindow, lat, lng)
      }
    }

    logCandidatePoolSummary(input, candidates, candidateGaps, gapQueries.length)

    const firstStopCandidates = candidates.filter(
      (candidate) =>
        typeof candidate.distanceKm === 'number' &&
        candidate.distanceKm <= FIRST_STOP_MAX_DISTANCE_KM,
    )
    const mainCandidates = candidates.filter(
      (candidate) =>
        typeof candidate.distanceKm !== 'number' ||
        candidate.distanceKm <= MAIN_CANDIDATE_MAX_DISTANCE_KM,
    )
    const backupCandidates = candidates.filter(
      (candidate) =>
        typeof candidate.distanceKm !== 'number' ||
        candidate.distanceKm <= BACKUP_CANDIDATE_MAX_DISTANCE_KM,
    )
    const otherCandidates =
      mainCandidates.length >= MIN_MAIN_CANDIDATES ? mainCandidates : backupCandidates

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

function prepareCandidates(
  places: GooglePlace[],
  input: TripInput,
  tripWindow: ReturnType<typeof buildTripWindow>,
  lat?: number,
  lng?: number,
) {
  return places
    .map((place) => toVerifiedPlaceCandidate(place, lat, lng))
    .filter((candidate): candidate is VerifiedPlaceCandidate => Boolean(candidate))
    .filter((candidate) => isCandidateUsableDuringTrip(candidate, tripWindow))
    .map((candidate) => addAvailabilitySlots(candidate, tripWindow))
    .map((candidate) => scoreCandidate(candidate, input))
    .sort(compareCandidates)
}

export async function resolveLocation(
  name: string,
): Promise<{ lat: number; lng: number; formattedName: string } | null> {
  if (!GOOGLE_PLACES_API_KEY || !name.trim()) return null

  // 策略 1：使用 Geocoding API (對地標與模糊地址辨識度較高)
  try {
    const response = await googleFetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name)}&key=${GOOGLE_PLACES_API_KEY}&language=zh-TW`
    )
    const data = (await response.json()) as GoogleGeocodeResponse

    if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
      const result = data.results[0]
      const location = result.geometry!.location!
      return {
        lat: location.lat,
        lng: location.lng,
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
  const nearStops = candidates.firstStopCandidates.slice(0, 12).map(formatCandidateForPrompt)
  const foodStops = candidates.otherCandidates
    .filter((candidate) => candidate.role === 'food')
    .slice(0, 12)
    .map(formatCandidateForPrompt)
  const mainStops = candidates.otherCandidates
    .filter((candidate) =>
      ['main_activity', 'open_space', 'shopping'].includes(candidate.role ?? ''),
    )
    .slice(0, 18)
    .map(formatCandidateForPrompt)
  const fallbackStops = candidates.otherCandidates
    .filter((candidate) => !['food', 'short_visit'].includes(candidate.role ?? ''))
    .slice(0, 18)
    .map(formatCandidateForPrompt)

  const sections: string[] = []
  if (nearStops.length > 0) {
    sections.push(
      [`FIRST_STOP_CANDIDATES_WITHIN_${FIRST_STOP_MAX_DISTANCE_KM}KM:`, ...nearStops].join(
        '\n',
      ),
    )
  }
  if (foodStops.length > 0) {
    sections.push(['FOOD_CANDIDATES:', ...foodStops].join('\n'))
  }
  if (mainStops.length > 0) {
    sections.push(['MAIN_ACTIVITY_CANDIDATES:', ...mainStops].join('\n'))
  } else if (fallbackStops.length > 0) {
    sections.push(['MAIN_ACTIVITY_CANDIDATES:', ...fallbackStops].join('\n'))
  }

  return sections.join('\n\n')
}

function buildCandidateSearchQueries(input: TripInput, persona?: Persona) {
  const name = input.location.name || ''
  const hasCoords = typeof input.location.lat === 'number' && typeof input.location.lng === 'number'
  const includesEvening = tripOverlapsWindow(input, 17 * 60, 22 * 60)
  const includesLateNight = tripOverlapsWindow(input, 21 * 60, 26 * 60)
  const includesEarlyMorning = tripOverlapsClockWindow(input, 0, EARLY_MORNING_ACTIVE_START_MINUTES)
  
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

    if (includesEvening) {
      queries.push(
        '夜間景點 夜市 晚間活動 night market night attractions',
        '晚間咖啡 甜點 酒吧 夜景 cafe dessert bar night view',
      )
    }

    if (includesLateNight) {
      queries.push(
        '24小時 營業 深夜景點 late night 24 hours',
      )
    }

    if (includesEarlyMorning) {
      queries.push(
        '24小時 營業 清晨 凌晨 可停留 places open 24 hours early morning',
      )
    }
  } else {
    // 缺乏座標時，才依賴地名作為前綴
    queries.push(
      `${name} attractions restaurants cafes`,
      `${name} parks museums landmarks`,
      `${name} local food dessert coffee`
    )

    if (includesEvening) {
      queries.push(
        `${name} 夜間景點 夜市 晚間活動`,
        `${name} 晚間咖啡 甜點 夜景`,
      )
    }

    if (includesLateNight) {
      queries.push(`${name} 24小時 深夜 營業`)
    }

    if (includesEarlyMorning) {
      queries.push(`${name} 24小時 清晨 凌晨 營業`)
    }
  }

  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean))).slice(
    0,
    MAX_GAP_SEARCH_QUERIES,
  )
}

function buildCandidateGapSearchQueries(
  input: TripInput,
  persona: Persona | undefined,
  gaps: CandidateGaps,
) {
  const name = input.location.name || ''
  const hasCoords = typeof input.location.lat === 'number' && typeof input.location.lng === 'number'
  const prefix = hasCoords ? '' : `${name} `
  const includesEarlyMorning = tripOverlapsClockWindow(input, 0, EARLY_MORNING_ACTIVE_START_MINUTES)
  const queries: string[] = []

  if (gaps.needsFirstStop) {
    queries.push(
      `${prefix}附近景點 咖啡 公園 商場 可短程抵達`,
      `${prefix}nearby attractions cafe mall park`,
    )
  }

  if (gaps.needsMainActivity) {
    queries.push(
      `${prefix}博物館 展覽 藝文 景點 tourist attraction museum gallery`,
      `${prefix}商場 百貨 老街 市集 觀光景點 mall market attraction`,
    )
  }

  if (gaps.needsFood) {
    queries.push(
      `${prefix}餐廳 咖啡 甜點 營業 restaurant cafe dessert`,
      `${prefix}在地美食 小吃 晚餐 午餐 local food restaurant`,
    )
  }

  if (gaps.needsIndoor) {
    queries.push(
      `${prefix}室內景點 展覽 博物館 商場 indoor attractions museum mall`,
      `${prefix}有遮蔽景點 咖啡 書店 百貨 indoor cafe bookstore`,
    )
  }

  if (gaps.needsEvening) {
    queries.push(
      `${prefix}夜間景點 夜市 晚間咖啡 夜景 night market night view`,
      `${prefix}24小時 深夜 營業 late night 24 hours`,
    )
  }

  if (includesEarlyMorning && (gaps.needsFirstStop || gaps.needsMainActivity || gaps.needsFood)) {
    queries.push(
      `${prefix}24小時 營業 清晨 凌晨 可停留`,
      `${prefix}open 24 hours early morning cafe park attraction`,
    )
  }

  const personaFallback = buildSearchQuery(input, persona)
  if (gaps.needsMainActivity && personaFallback) {
    queries.push(`${personaFallback} 營業中 景點`)
  }

  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)))
}

function getCandidateGaps(candidates: VerifiedPlaceCandidate[], input: TripInput): CandidateGaps {
  const includesEvening = tripOverlapsWindow(input, 17 * 60, 22 * 60)
  const includesLateNight = tripOverlapsWindow(input, 21 * 60, 26 * 60)
  const firstStopCount = candidates.filter(
    (candidate) =>
      typeof candidate.distanceKm === 'number' &&
      candidate.distanceKm <= FIRST_STOP_MAX_DISTANCE_KM,
  ).length
  const mainDistanceCandidates = candidates.filter(
    (candidate) =>
      typeof candidate.distanceKm !== 'number' ||
      candidate.distanceKm <= MAIN_CANDIDATE_MAX_DISTANCE_KM,
  )
  const foodCount = mainDistanceCandidates.filter((candidate) => candidate.role === 'food').length
  const activityCount = mainDistanceCandidates.filter((candidate) =>
    ['main_activity', 'open_space', 'shopping'].includes(candidate.role ?? ''),
  ).length
  const indoorCount = mainDistanceCandidates.filter(isIndoorCandidate).length
  const eveningCount = candidates.filter((candidate) =>
    candidate.availabilitySlots?.includes('late'),
  ).length

  return {
    needsFirstStop: firstStopCount < MIN_FIRST_STOP_CANDIDATES,
    needsFood: foodCount < MIN_FOOD_CANDIDATES,
    needsMainActivity: activityCount < MIN_ACTIVITY_CANDIDATES,
    needsIndoor: input.tags.includes('indoor_first') && indoorCount < MIN_INDOOR_CANDIDATES,
    needsEvening: (includesEvening || includesLateNight) && eveningCount < MIN_ACTIVITY_CANDIDATES,
  }
}

function isIndoorCandidate(candidate: VerifiedPlaceCandidate) {
  const types = candidate.types ?? []
  const text = `${candidate.name} ${candidate.address}`.toLocaleLowerCase('zh-TW')

  return (
    candidate.role === 'food' ||
    candidate.role === 'shopping' ||
    types.some((type) =>
      [
        'museum',
        'art_gallery',
        'shopping_mall',
        'department_store',
        'book_store',
        'movie_theater',
        'aquarium',
      ].includes(type),
    ) ||
    /(室內|展覽|博物館|美術館|百貨|商場|書店|咖啡|影城|水族館|mall|museum|gallery|cafe)/i.test(text)
  )
}

function logCandidatePoolSummary(
  input: TripInput,
  candidates: VerifiedPlaceCandidate[],
  initialGaps: CandidateGaps,
  gapQueryCount: number,
) {
  const firstStopCount = candidates.filter(
    (candidate) =>
      typeof candidate.distanceKm === 'number' &&
      candidate.distanceKm <= FIRST_STOP_MAX_DISTANCE_KM,
  ).length
  const foodCount = candidates.filter((candidate) => candidate.role === 'food').length
  const activityCount = candidates.filter((candidate) =>
    ['main_activity', 'open_space', 'shopping'].includes(candidate.role ?? ''),
  ).length
  const indoorCount = candidates.filter(isIndoorCandidate).length

  console.info('[candidate-pool]', {
    location: input.location.name,
    total: candidates.length,
    firstStopCount,
    foodCount,
    activityCount,
    indoorCount,
    gapQueryCount,
    initialGaps,
  })
}

function tripOverlapsWindow(input: TripInput, windowStartMinutes: number, windowEndMinutes: number) {
  const tripWindow = buildTripWindow(input)
  if (!tripWindow) return false

  return tripWindow.startMinutes < windowEndMinutes && tripWindow.endMinutes > windowStartMinutes
}

function tripOverlapsClockWindow(input: TripInput, windowStartMinutes: number, windowEndMinutes: number) {
  if (!isCompleteTime(input.startTime) || !isCompleteTime(input.endTime)) return false

  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)
  if (end <= start) end += 24 * 60

  return (
    (start < windowEndMinutes && end > windowStartMinutes) ||
    (start < windowEndMinutes + 24 * 60 && end > windowStartMinutes + 24 * 60)
  )
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

  const openingHours = buildOpeningHoursMetadata(place)

  return {
    name: place.displayName.text,
    address: place.formattedAddress,
    placeId: place.id,
    googleMapsUrl: buildGoogleMapsPlaceUrl(place),
    distanceKm,
    rating: place.rating,
    types: place.types,
    role: inferCandidateRole(place.types ?? [], place.displayName.text, place.formattedAddress),
    foodSubtype: inferFoodSubtype(place.types ?? [], place.displayName.text, place.formattedAddress),
    openingHours,
    openingHoursSummary: formatOpeningHoursSummary(openingHours),
    lat: place.location?.latitude,
    lng: place.location?.longitude,
  }
}

function formatCandidateForPrompt(candidate: VerifiedPlaceCandidate) {
  const distanceText =
    candidate.distanceKm === undefined ? '' : `, distance=${candidate.distanceKm.toFixed(1)}km`
  const ratingText = candidate.rating ? `, rating=${candidate.rating}` : ''
  const roleText = candidate.role ? `, role=${candidate.role}` : ''
  const foodSubtypeText = candidate.foodSubtype ? `, foodSubtype=${candidate.foodSubtype}` : ''
  const scoreText = typeof candidate.score === 'number' ? `, score=${candidate.score.toFixed(1)}` : ''
  const hoursText = candidate.openingHoursSummary ? `, hours="${candidate.openingHoursSummary}"` : ''
  const slotsText = candidate.availabilitySlots?.length
    ? `, bestSlots="${candidate.availabilitySlots.join(',')}"`
    : ''

  return `- name="${candidate.name}", address="${candidate.address}", placeId="${candidate.placeId}"${distanceText}${ratingText}${roleText}${foodSubtypeText}${scoreText}${hoursText}${slotsText}`
}

function buildTripWindow(input: TripInput) {
  if (!isCompleteTime(input.startTime) || !isCompleteTime(input.endTime)) return null

  const startMinutes = parseTimeToMinutes(input.startTime)
  let endMinutes = parseTimeToMinutes(input.endTime)
  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60
  }
  const activeStartMinutes = shouldUseEarlyMorningActiveWindow(startMinutes, endMinutes)
    ? EARLY_MORNING_ACTIVE_START_MINUTES
    : startMinutes

  return {
    startMinutes: activeStartMinutes,
    endMinutes,
  }
}

function shouldUseEarlyMorningActiveWindow(startMinutes: number, endMinutes: number) {
  return (
    startMinutes < EARLY_MORNING_ACTIVE_START_MINUTES &&
    endMinutes > EARLY_MORNING_ACTIVE_START_MINUTES &&
    endMinutes - EARLY_MORNING_ACTIVE_START_MINUTES >= MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES
  )
}

function isCandidateUsableDuringTrip(
  candidate: VerifiedPlaceCandidate,
  tripWindow: ReturnType<typeof buildTripWindow>,
) {
  const openingHours = candidate.openingHours
  if (!openingHours || !openingHours.isKnown) return false
  if (!tripWindow) return true
  if (openingHours.isNeverOpen) return false

  const tripStart = buildTripDateAtMinutes(tripWindow.startMinutes, openingHours.utcOffsetMinutes)
  const tripEnd = buildTripDateAtMinutes(tripWindow.endMinutes, openingHours.utcOffsetMinutes)

  return openingHours.windows.some((window) =>
    hasUsableOpeningOverlap(
      window,
      tripStart,
      tripEnd,
      getMinimumCandidateVisitMinutes(candidate),
    ),
  )
}

function addAvailabilitySlots(
  candidate: VerifiedPlaceCandidate,
  tripWindow: ReturnType<typeof buildTripWindow>,
): VerifiedPlaceCandidate {
  return {
    ...candidate,
    availabilitySlots: getCandidateAvailabilitySlots(candidate, tripWindow),
  }
}

function getCandidateAvailabilitySlots(
  candidate: VerifiedPlaceCandidate,
  tripWindow: ReturnType<typeof buildTripWindow>,
) {
  const fallbackSlots = ['early', 'middle', 'late']
  const openingHours = candidate.openingHours
  if (!openingHours || !openingHours.isKnown) return []
  if (!tripWindow) return fallbackSlots
  if (openingHours.isNeverOpen) return []

  const tripDuration = tripWindow.endMinutes - tripWindow.startMinutes
  if (tripDuration <= 0) return fallbackSlots

  const slotLength = Math.max(30, Math.floor(tripDuration / 3))
  const slotStarts = [
    tripWindow.startMinutes,
    Math.min(tripWindow.endMinutes - 30, tripWindow.startMinutes + slotLength),
    Math.min(tripWindow.endMinutes - 30, tripWindow.startMinutes + slotLength * 2),
  ]
  const slotEnds = [
    Math.min(tripWindow.endMinutes, tripWindow.startMinutes + slotLength),
    Math.min(tripWindow.endMinutes, tripWindow.startMinutes + slotLength * 2),
    tripWindow.endMinutes,
  ]
  const slotNames = ['early', 'middle', 'late']

  return slotStarts
    .map((startMinutes, index) => ({
      slot: slotNames[index],
      usable: isOpeningHoursUsableWithinRange(
        openingHours,
        startMinutes,
        slotEnds[index],
        getMinimumCandidateVisitMinutes(candidate),
      ),
    }))
    .filter((item) => item.usable)
    .map((item) => item.slot)
}

export function isCandidateOpenForVisit(
  candidate: VerifiedPlaceCandidate,
  arrivalMinutes: number,
  durationMinutes: number,
) {
  const openingHours = candidate.openingHours
  if (!openingHours || !openingHours.isKnown) return false
  if (openingHours.isNeverOpen) return false

  return isOpeningHoursUsableForVisit(openingHours, arrivalMinutes, durationMinutes)
}

function scoreCandidate(
  candidate: VerifiedPlaceCandidate,
  input: TripInput,
): VerifiedPlaceCandidate {
  const distanceKm = candidate.distanceKm ?? MAIN_CANDIDATE_MAX_DISTANCE_KM
  const rating = candidate.rating ?? 4
  const role = candidate.role ?? 'main_activity'
  const wantsFoodFirst = input.tags.includes('food_first')
  const wantsIndoor = input.tags.includes('indoor_first')
  const wantsPhoto = input.tags.includes('photo_first')

  let score = 50
  score += Math.max(0, 25 - distanceKm * 4)
  score += Math.max(0, (rating - 3.5) * 12)
  score += candidate.openingHours?.isKnown ? 4 : 0
  score += candidate.availabilitySlots?.length ? candidate.availabilitySlots.length * 2 : 4

  if (role === 'short_visit') score -= 35
  if (role === 'food') {
    score += wantsFoodFirst ? 18 : 4
    score += getFoodSubtypeScore(candidate, wantsFoodFirst)
  }
  if (role === 'open_space') score += wantsPhoto ? 8 : 2
  if (role === 'shopping') score += wantsIndoor ? 10 : 3
  if (role === 'main_activity') score += 10
  if (isShortVisitCandidatePlace(candidate.name, candidate.address)) score -= 30

  return {
    ...candidate,
    score: Math.round(score * 10) / 10,
  }
}

function getFoodSubtypeScore(candidate: VerifiedPlaceCandidate, wantsFoodFirst: boolean) {
  if (candidate.foodSubtype === 'cafe') return wantsFoodFirst ? 4 : 14
  if (candidate.foodSubtype === 'dessert') return wantsFoodFirst ? 4 : 10
  if (candidate.foodSubtype === 'restaurant') return wantsFoodFirst ? 8 : 6
  if (candidate.foodSubtype === 'snack') return wantsFoodFirst ? 10 : -8

  return 0
}

function compareCandidates(left: VerifiedPlaceCandidate, right: VerifiedPlaceCandidate) {
  const scoreDelta = (right.score ?? 0) - (left.score ?? 0)
  if (scoreDelta !== 0) return scoreDelta

  const leftDistance = left.distanceKm ?? Number.POSITIVE_INFINITY
  const rightDistance = right.distanceKm ?? Number.POSITIVE_INFINITY
  if (leftDistance !== rightDistance) return leftDistance - rightDistance

  const ratingDelta = (right.rating ?? 0) - (left.rating ?? 0)
  if (ratingDelta !== 0) return ratingDelta

  const nameDelta = left.name.localeCompare(right.name, 'zh-TW')
  if (nameDelta !== 0) return nameDelta

  return left.placeId.localeCompare(right.placeId)
}

function isShortVisitCandidatePlace(name: string, address: string) {
  const text = `${name} ${address}`.toLocaleLowerCase('zh-TW')
  return /(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)
}

function inferFoodSubtype(
  types: string[],
  name: string,
  address: string,
): VerifiedPlaceCandidate['foodSubtype'] {
  const text = `${name} ${address}`.toLocaleLowerCase('zh-TW')

  if (types.some((type) => ['cafe'].includes(type)) || /(咖啡|coffee|cafe|珈琲)/i.test(text)) {
    return 'cafe'
  }

  if (types.some((type) => ['bakery'].includes(type)) || /(甜點|蛋糕|冰品|烘焙|麵包|dessert|bakery)/i.test(text)) {
    return 'dessert'
  }

  if (/(小吃|傳統美食|夜市|市場|攤|鹽酥|滷味|肉圓|米糕|碗粿|臭豆腐|snack)/i.test(text)) {
    return 'snack'
  }

  if (
    types.some((type) => ['restaurant', 'meal_takeaway', 'food'].includes(type)) ||
    /(餐廳|食堂|料理|早午餐|bistro|restaurant|brunch)/i.test(text)
  ) {
    return 'restaurant'
  }

  return undefined
}

function inferCandidateRole(
  types: string[],
  name: string,
  address: string,
): VerifiedPlaceCandidate['role'] {
  const text = `${name} ${address}`.toLocaleLowerCase('zh-TW')
  if (types.some((type) => ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food'].includes(type))) {
    return 'food'
  }
  if (/(局|署|所|處|公所|辦公|服務中心|銀行|郵局|醫院|診所|公司|分局)/.test(text)) {
    return 'short_visit'
  }
  if (types.some((type) => ['shopping_mall', 'department_store', 'market'].includes(type))) {
    return 'shopping'
  }
  if (types.some((type) => ['park', 'tourist_attraction', 'natural_feature'].includes(type))) {
    return /(公園|步道|海邊|湖|山|森林|河濱|草地|park)/i.test(text)
      ? 'open_space'
      : 'main_activity'
  }
  if (types.some((type) => ['museum', 'art_gallery', 'amusement_park', 'zoo', 'aquarium'].includes(type))) {
    return 'main_activity'
  }

  return 'main_activity'
}

function buildOpeningHoursMetadata(place: GooglePlace): OpeningHoursMetadata | undefined {
  const sourceHours = place.currentOpeningHours?.periods
    ? { hours: place.currentOpeningHours, source: 'current' as const }
    : place.regularOpeningHours?.periods
      ? { hours: place.regularOpeningHours, source: 'regular' as const }
      : null

  if (!sourceHours) return undefined

  const periods = sourceHours.hours.periods
  if (!periods) return undefined

  if (periods.length === 0) {
    return {
      windows: [],
      source: sourceHours.source,
      utcOffsetMinutes: place.utcOffsetMinutes,
      isKnown: true,
      isNeverOpen: true,
    }
  }

  const windows = periods
    .map((period) => toOpeningWindow(period, place.utcOffsetMinutes))
    .filter((window): window is OpeningWindow => Boolean(window))

  return {
    windows,
    source: sourceHours.source,
    utcOffsetMinutes: place.utcOffsetMinutes,
    isKnown: windows.length > 0,
    isNeverOpen: false,
  }
}

function toOpeningWindow(
  period: GoogleOpeningHoursPeriod,
  utcOffsetMinutes = 0,
): OpeningWindow | null {
  if (!period.open) return null

  const openAt = openingPointToDate(period.open, utcOffsetMinutes)
  if (!openAt) return null

  const closeAt = period.close
    ? openingPointToDate(period.close, utcOffsetMinutes, openAt)
    : new Date(openAt.getTime() + 7 * 24 * 60 * 60 * 1000)

  if (!closeAt || closeAt <= openAt) return null

  return { openAt, closeAt }
}

function openingPointToDate(
  point: GoogleOpeningHoursPoint,
  utcOffsetMinutes = 0,
  previousPoint?: Date,
) {
  const hour = point.hour ?? 0
  const minute = point.minute ?? 0

  if (point.date?.year && point.date.month && point.date.day) {
    return buildDateFromLocalParts(
      point.date.year,
      point.date.month,
      point.date.day,
      hour,
      minute,
      utcOffsetMinutes,
    )
  }

  if (typeof point.day !== 'number') return null

  const baseLocal = getCurrentLocalDateParts(utcOffsetMinutes)
  const candidate = buildNextDateForGoogleDay(baseLocal, point.day, hour, minute, utcOffsetMinutes)
  if (!previousPoint || candidate > previousPoint) return candidate

  return new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000)
}

function buildNextDateForGoogleDay(
  baseLocal: { year: number; month: number; day: number; googleDay: number },
  googleDay: number,
  hour: number,
  minute: number,
  utcOffsetMinutes: number,
) {
  const dayDelta = (googleDay - baseLocal.googleDay + 7) % 7
  const baseUtc = buildDateFromLocalParts(
    baseLocal.year,
    baseLocal.month,
    baseLocal.day,
    hour,
    minute,
    utcOffsetMinutes,
  )
  return new Date(baseUtc.getTime() + dayDelta * 24 * 60 * 60 * 1000)
}

function getCurrentLocalDateParts(utcOffsetMinutes = 0) {
  const localNow = new Date(Date.now() + utcOffsetMinutes * 60 * 1000)
  return {
    year: localNow.getUTCFullYear(),
    month: localNow.getUTCMonth() + 1,
    day: localNow.getUTCDate(),
    googleDay: localNow.getUTCDay(),
  }
}

function buildDateFromLocalParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  utcOffsetMinutes = 0,
) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - utcOffsetMinutes * 60 * 1000)
}

function buildTripDateAtMinutes(totalMinutes: number, utcOffsetMinutes = 0) {
  const baseLocal = getCurrentLocalDateParts(utcOffsetMinutes)
  const dayOffset = Math.floor(totalMinutes / (24 * 60))
  const minutesInDay = totalMinutes % (24 * 60)
  const hour = Math.floor(minutesInDay / 60)
  const minute = minutesInDay % 60
  return new Date(
    buildDateFromLocalParts(
      baseLocal.year,
      baseLocal.month,
      baseLocal.day,
      hour,
      minute,
      utcOffsetMinutes,
    ).getTime() +
      dayOffset * 24 * 60 * 60 * 1000,
  )
}

function dateToTripMinutes(date: Date, utcOffsetMinutes = 0) {
  const baseLocal = getCurrentLocalDateParts(utcOffsetMinutes)
  const localDate = new Date(date.getTime() + utcOffsetMinutes * 60 * 1000)
  const baseLocalMidnightMs = Date.UTC(baseLocal.year, baseLocal.month - 1, baseLocal.day)
  const targetLocalMs = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    localDate.getUTCHours(),
    localDate.getUTCMinutes(),
  )

  return Math.round((targetLocalMs - baseLocalMidnightMs) / (60 * 1000))
}

function getMinimumCandidateVisitMinutes(candidate: VerifiedPlaceCandidate) {
  return candidate.role === 'food'
    ? MIN_FOOD_CANDIDATE_VISIT_MINUTES
    : MIN_CANDIDATE_VISIT_MINUTES
}

function hasUsableOpeningOverlap(
  window: OpeningWindow,
  tripStart: Date,
  tripEnd: Date,
  minimumVisitMinutes: number,
) {
  const comfortableLeaveAt = new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000)
  const earliestArrivalAt = new Date(Math.max(window.openAt.getTime(), tripStart.getTime()))
  const latestLeaveAt = new Date(Math.min(comfortableLeaveAt.getTime(), tripEnd.getTime()))

  return latestLeaveAt.getTime() - earliestArrivalAt.getTime() >= minimumVisitMinutes * 60 * 1000
}

function formatOpeningHoursSummary(openingHours?: OpeningHoursMetadata) {
  if (!openingHours || !openingHours.isKnown) return 'unknown'
  if (openingHours.isNeverOpen) return 'closed'

  const windows = openingHours.windows.slice(0, 3).map((window) => {
    const comfortableLeaveAt = new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000)
    return `${formatLocalTime(window.openAt, openingHours.utcOffsetMinutes)}-${formatLocalTime(
      window.closeAt,
      openingHours.utcOffsetMinutes,
    )}, leaveBy=${formatLocalTime(comfortableLeaveAt, openingHours.utcOffsetMinutes)}`
  })

  return windows.join('; ')
}

function formatLocalTime(date: Date, utcOffsetMinutes = 0) {
  const localDate = new Date(date.getTime() + utcOffsetMinutes * 60 * 1000)
  return `${String(localDate.getUTCHours()).padStart(2, '0')}:${String(
    localDate.getUTCMinutes(),
  ).padStart(2, '0')}`
}

async function searchPlaces(
  textQuery: string,
  options: {
    bias?: { lat: number; lng: number }
    maxResultCount?: number
    radiusMeters?: number
  } = {},
): Promise<GooglePlace[]> {
  if (!GOOGLE_PLACES_API_KEY) return []

  const response = await googleFetch(SEARCH_TEXT_URL, {
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
              radius: options.radiusMeters ?? MAIN_CANDIDATE_MAX_DISTANCE_KM * 1000,
            },
          }
        : undefined,
    }),
  })

  if (!response.ok) return []

  const data = (await response.json()) as GooglePlacesResponse
  const places = data.places ?? []
  places.forEach((place) => {
    if (place.id) placeDetailsCache.set(place.id, place)
  })

  return places
}

async function getPlaceById(placeId: string): Promise<GooglePlace | null> {
  if (!GOOGLE_PLACES_API_KEY || !placeId.trim()) return null

  if (placeDetailsCache.has(placeId)) {
    return placeDetailsCache.get(placeId) ?? null
  }

  const response = await googleFetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=zh-TW`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
  })

  if (!response.ok) {
    placeDetailsCache.set(placeId, null)
    return null
  }

  const place = (await response.json()) as GooglePlace
  placeDetailsCache.set(placeId, place)
  return place
}

function googleFetch(url: string, init?: RequestInit) {
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init?.headers)
    const body = init?.body
    const req = https.request(
      url,
      {
        method: init?.method ?? 'GET',
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

    req.setTimeout(15000, () => {
      req.destroy(new Error('Google API request timed out'))
    })
    req.on('error', reject)

    if (typeof body === 'string' || body instanceof Uint8Array) {
      req.write(body)
    } else if (body != null) {
      req.write(String(body))
    }

    req.end()
  })
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

function isPlaceOpenForVisit(place: GooglePlace, arrivalMinutes: number, durationMinutes: number) {
  const openingHours = buildOpeningHoursMetadata(place)
  if (!openingHours || !openingHours.isKnown) return false
  if (openingHours.isNeverOpen) return false

  return isOpeningHoursUsableForVisit(openingHours, arrivalMinutes, durationMinutes)
}

function isOpeningHoursUsableForVisit(
  openingHours: OpeningHoursMetadata,
  arrivalMinutes: number,
  durationMinutes: number,
) {
  const arrivalAt = buildTripDateAtMinutes(arrivalMinutes, openingHours.utcOffsetMinutes)
  const leaveAt = new Date(arrivalAt.getTime() + Math.max(0, durationMinutes) * 60 * 1000)
  return openingHours.windows.some((window) => {
    const comfortableLeaveAt = new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000)
    return arrivalAt >= window.openAt && leaveAt <= comfortableLeaveAt
  })
}

function isOpeningHoursUsableWithinRange(
  openingHours: OpeningHoursMetadata,
  rangeStartMinutes: number,
  rangeEndMinutes: number,
  durationMinutes: number,
) {
  const rangeStartAt = buildTripDateAtMinutes(rangeStartMinutes, openingHours.utcOffsetMinutes)
  const rangeEndAt = buildTripDateAtMinutes(rangeEndMinutes, openingHours.utcOffsetMinutes)
  const durationMs = Math.max(0, durationMinutes) * 60 * 1000

  return openingHours.windows.some((window) => {
    const comfortableLeaveAt = new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000)
    const earliestArrivalAt = new Date(Math.max(window.openAt.getTime(), rangeStartAt.getTime()))
    const latestArrivalAt = new Date(
      Math.min(comfortableLeaveAt.getTime() - durationMs, rangeEndAt.getTime() - durationMs),
    )

    return latestArrivalAt >= earliestArrivalAt
  })
}

function estimateStopArrivalMinutes(
  stops: Stop[],
  transportSegments: TripPlan['transportSegments'],
  input: TripInput,
) {
  if (!isCompleteTime(input.startTime)) return []

  const arrivals: number[] = []
  let currentMinutes = parseTimeToMinutes(input.startTime)

  stops.forEach((stop, index) => {
    arrivals[index] = currentMinutes

    const nextStop = stops[index + 1]
    if (!nextStop) return

    const segment = findTransportSegmentBetween(transportSegments ?? [], stop.id, nextStop.id, index)
    currentMinutes += Math.max(0, Number(stop.duration) || 0)
    currentMinutes += Math.max(0, Number(segment?.duration) || 0)
  })

  return arrivals
}

function estimateStopOffsetMinutes(
  stops: Stop[],
  transportSegments: TripPlan['transportSegments'],
) {
  const offsets: number[] = []
  let currentMinutes = 0

  stops.forEach((stop, index) => {
    offsets[index] = currentMinutes

    const nextStop = stops[index + 1]
    if (!nextStop) return

    const segment = findTransportSegmentBetween(transportSegments ?? [], stop.id, nextStop.id, index)
    currentMinutes += Math.max(0, Number(stop.duration) || 0)
    currentMinutes += Math.max(0, Number(segment?.duration) || 0)
  })

  return offsets
}

function estimateStopListTotalDuration(
  stops: Stop[],
  transportSegments: TripPlan['transportSegments'],
  offsets = estimateStopOffsetMinutes(stops, transportSegments),
) {
  const lastStop = stops[stops.length - 1]
  if (!lastStop) return 0

  return (offsets[stops.length - 1] ?? 0) + Math.max(0, Number(lastStop.duration) || 0)
}

function findTransportSegmentBetween(
  segments: TripPlan['transportSegments'],
  fromStopId: string,
  toStopId: string,
  index: number,
) {
  return (
    segments.find(
      (segment) => segment.fromStopId === fromStopId && segment.toStopId === toStopId,
    ) ?? segments[index]
  )
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

function isCompleteTime(value?: string) {
  return Boolean(value && /^\d{2}:\d{2}$/.test(value))
}

function parseTimeToMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

async function validateStop(
  stop: Stop,
  context: ValidationContext,
  index: number,
  arrivalMinutes?: number,
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

  if (
    context.input &&
    typeof arrivalMinutes === 'number' &&
    !isPlaceOpenForVisit(googlePlace, arrivalMinutes, Number(stop.duration) || 0)
  ) {
    const openingHours = buildOpeningHoursMetadata(googlePlace)
    return {
      stop,
      issue: {
        stopId: stop.id,
        stopName: stop.name,
        reason: openingHours?.isKnown ? 'outside_opening_hours' : 'unknown_opening_hours',
        ...describeOpeningHoursMismatch(
          googlePlace,
          arrivalMinutes,
          Number(stop.duration) || 0,
        ),
      },
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
  input?: TripInput,
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

  const mainArrivalMinutes = input ? estimateStopArrivalMinutes(plan.stops, plan.transportSegments, input) : []
  const rainArrivalMinutes = input
    ? estimateStopArrivalMinutes(plan.rainBackup ?? [], plan.rainTransportSegments ?? [], input)
    : []

  const mainResults = await Promise.all(
    plan.stops.map((stop, index) =>
      validateStop(
        stop,
        { bias, enforceFirstStopDistance: true, input },
        index,
        mainArrivalMinutes[index],
      ),
    ),
  )

  const rainResults = await Promise.all(
    (plan.rainBackup ?? []).map((stop, index) =>
      validateStop(
        stop,
        { bias, enforceFirstStopDistance: false, input },
        index,
        rainArrivalMinutes[index],
      ),
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

export async function validatePlanOpeningHours(
  plan: TripPlan,
  input: TripInput,
  options: { includeRainBackup?: boolean } = {},
): Promise<OpeningHoursValidationIssue[]> {
  if (!GOOGLE_PLACES_API_KEY) return []

  const mainIssues = await validateStopListOpeningHours(
    plan.stops ?? [],
    plan.transportSegments ?? [],
    input,
  )

  if (!options.includeRainBackup) {
    return mainIssues
  }

  const rainIssues = await validateStopListOpeningHours(
    plan.rainBackup ?? [],
    plan.rainTransportSegments ?? [],
    input,
  )

  return [...mainIssues, ...rainIssues]
}

export async function resolveOpeningHoursTimelineStart(
  plan: TripPlan,
  input: TripInput,
  options: { earliestStartMinutes?: number; startStepMinutes?: number } = {},
): Promise<OpeningHoursTimelineResolution> {
  if (!GOOGLE_PLACES_API_KEY || !isCompleteTime(input.startTime) || !isCompleteTime(input.endTime)) {
    return { startMinutes: null, issues: [] }
  }

  const originalStart = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)
  if (end <= originalStart) end += 24 * 60

  const earliestStart = options.earliestStartMinutes ?? originalStart
  const startStepMinutes = Math.max(1, options.startStepMinutes ?? 1)
  const stops = plan.stops ?? []
  if (stops.length === 0) {
    return { startMinutes: snapMinutesUp(earliestStart, startStepMinutes), issues: [] }
  }

  const offsets = estimateStopOffsetMinutes(stops, plan.transportSegments ?? [])
  const totalDuration = estimateStopListTotalDuration(
    stops,
    plan.transportSegments ?? [],
    offsets,
  )
  const latestStart = end - totalDuration
  if (latestStart < earliestStart) {
    return { startMinutes: null, issues: [] }
  }

  const entries = await Promise.all(
    stops.map(async (stop, index) => ({
      stop,
      offset: offsets[index] ?? 0,
      place: stop.placeId ? await getPlaceById(stop.placeId) : null,
    })),
  )

  const blockingIssues: OpeningHoursValidationIssue[] = []
  const timelineIntervalSets: MinuteInterval[][] = []

  for (const entry of entries) {
    if (!entry.place) continue

    const openingHours = buildOpeningHoursMetadata(entry.place)
    const duration = Math.max(0, Number(entry.stop.duration) || 0)

    if (!openingHours || !openingHours.isKnown) {
      blockingIssues.push({
        stopId: entry.stop.id,
        stopName: entry.stop.name,
        reason: 'unknown_opening_hours',
        ...describeOpeningHoursMismatch(
          entry.place,
          earliestStart + entry.offset,
          duration,
        ),
      })
      continue
    }

    const startIntervals = getTimelineStartIntervalsForOpeningHours(
      openingHours,
      entry.offset,
      duration,
    )

    if (openingHours.isNeverOpen || startIntervals.length === 0) {
      blockingIssues.push({
        stopId: entry.stop.id,
        stopName: entry.stop.name,
        reason: 'outside_opening_hours',
        ...describeOpeningHoursMismatch(
          entry.place,
          earliestStart + entry.offset,
          duration,
        ),
      })
      continue
    }

    timelineIntervalSets.push(startIntervals)
  }

  if (blockingIssues.length > 0) {
    return { startMinutes: null, issues: blockingIssues }
  }

  let feasibleIntervals: MinuteInterval[] = [{ start: earliestStart, end: latestStart }]
  for (const intervalSet of timelineIntervalSets) {
    feasibleIntervals = intersectMinuteIntervals(feasibleIntervals, intervalSet)
    if (feasibleIntervals.length === 0) break
  }

  if (feasibleIntervals.length === 0) {
    return {
      startMinutes: null,
      issues: buildOpeningHoursIssuesForTimelineStart(entries, earliestStart),
    }
  }

  const snappedStart = findFirstSnappedMinuteInIntervals(feasibleIntervals, startStepMinutes)
  if (snappedStart === null) {
    return {
      startMinutes: null,
      issues: buildOpeningHoursIssuesForTimelineStart(entries, earliestStart),
    }
  }

  return {
    startMinutes: snappedStart,
    issues: [],
  }
}

async function validateStopListOpeningHours(
  stops: Stop[],
  transportSegments: TripPlan['transportSegments'],
  input: TripInput,
) {
  const arrivalMinutes = estimateStopArrivalMinutes(stops, transportSegments, input)
  const issues = await Promise.all(
    stops.map(async (stop, index): Promise<OpeningHoursValidationIssue | null> => {
      if (!stop.placeId || typeof arrivalMinutes[index] !== 'number') return null

      const place = await getPlaceById(stop.placeId)
      if (!place) return null

      const openingHours = buildOpeningHoursMetadata(place)
      if (!openingHours || !openingHours.isKnown) {
        return {
          stopId: stop.id,
          stopName: stop.name,
          reason: 'unknown_opening_hours',
          ...describeOpeningHoursMismatch(place, arrivalMinutes[index], Number(stop.duration) || 0),
        }
      }

      if (isPlaceOpenForVisit(place, arrivalMinutes[index], Number(stop.duration) || 0)) return null

      return {
        stopId: stop.id,
        stopName: stop.name,
        reason: 'outside_opening_hours',
        ...describeOpeningHoursMismatch(place, arrivalMinutes[index], Number(stop.duration) || 0),
      }
    }),
  )

  return issues.filter((issue): issue is OpeningHoursValidationIssue => Boolean(issue))
}

function getTimelineStartIntervalsForOpeningHours(
  openingHours: OpeningHoursMetadata,
  stopOffsetMinutes: number,
  durationMinutes: number,
) {
  const intervals = openingHours.windows
    .map((window) => {
      const openMinutes = dateToTripMinutes(window.openAt, openingHours.utcOffsetMinutes)
      const comfortableLeaveMinutes = dateToTripMinutes(
        new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000),
        openingHours.utcOffsetMinutes,
      )

      return {
        start: openMinutes - stopOffsetMinutes,
        end: comfortableLeaveMinutes - Math.max(0, durationMinutes) - stopOffsetMinutes,
      }
    })
    .filter((interval) => interval.end >= interval.start)

  return mergeMinuteIntervals(intervals)
}

function intersectMinuteIntervals(left: MinuteInterval[], right: MinuteInterval[]) {
  const intersections: MinuteInterval[] = []

  for (const leftInterval of left) {
    for (const rightInterval of right) {
      const start = Math.max(leftInterval.start, rightInterval.start)
      const end = Math.min(leftInterval.end, rightInterval.end)
      if (end >= start) intersections.push({ start, end })
    }
  }

  return mergeMinuteIntervals(intersections)
}

function mergeMinuteIntervals(intervals: MinuteInterval[]) {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))
    .sort((left, right) => left.start - right.start)

  const merged: MinuteInterval[] = []
  for (const interval of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }

  return merged
}

function findFirstSnappedMinuteInIntervals(intervals: MinuteInterval[], stepMinutes: number) {
  for (const interval of intervals) {
    const snapped = snapMinutesUp(interval.start, stepMinutes)
    if (snapped <= interval.end) return snapped
  }

  return null
}

function snapMinutesUp(minutes: number, stepMinutes: number) {
  return Math.ceil(minutes / stepMinutes) * stepMinutes
}

function buildOpeningHoursIssuesForTimelineStart(
  entries: Array<{ stop: Stop; offset: number; place: GooglePlace | null }>,
  timelineStartMinutes: number,
) {
  return entries
    .map((entry) => {
      if (!entry.place) return null
      return buildOpeningHoursIssue(
        entry.stop,
        entry.place,
        timelineStartMinutes + entry.offset,
        Math.max(0, Number(entry.stop.duration) || 0),
      )
    })
    .filter((issue): issue is OpeningHoursValidationIssue => Boolean(issue))
}

function buildOpeningHoursIssue(
  stop: Stop,
  place: GooglePlace,
  arrivalMinutes: number,
  durationMinutes: number,
): OpeningHoursValidationIssue | null {
  const openingHours = buildOpeningHoursMetadata(place)

  if (!openingHours || !openingHours.isKnown) {
    return {
      stopId: stop.id,
      stopName: stop.name,
      reason: 'unknown_opening_hours',
      ...describeOpeningHoursMismatch(place, arrivalMinutes, durationMinutes),
    }
  }

  if (openingHours.isNeverOpen || !isOpeningHoursUsableForVisit(openingHours, arrivalMinutes, durationMinutes)) {
    return {
      stopId: stop.id,
      stopName: stop.name,
      reason: 'outside_opening_hours',
      ...describeOpeningHoursMismatch(place, arrivalMinutes, durationMinutes),
    }
  }

  return null
}

function describeOpeningHoursMismatch(
  place: GooglePlace,
  arrivalMinutes: number,
  durationMinutes: number,
) {
  const openingHours = buildOpeningHoursMetadata(place)
  const utcOffsetMinutes = openingHours?.utcOffsetMinutes ?? place.utcOffsetMinutes
  const arrivalAt = buildTripDateAtMinutes(arrivalMinutes, utcOffsetMinutes)
  const leaveAt = new Date(arrivalAt.getTime() + Math.max(0, durationMinutes) * 60 * 1000)

  return {
    arrivalTime: formatLocalTime(arrivalAt, utcOffsetMinutes),
    leaveTime: formatLocalTime(leaveAt, utcOffsetMinutes),
    openingWindows: openingHours?.windows.slice(0, 4).map((window) => {
      const leaveBy = new Date(window.closeAt.getTime() - CLOSING_BUFFER_MINUTES * 60 * 1000)
      return `${formatLocalTime(window.openAt, utcOffsetMinutes)}-${formatLocalTime(window.closeAt, utcOffsetMinutes)} leaveBy=${formatLocalTime(leaveBy, utcOffsetMinutes)}`
    }),
  }
}
