export type TripCategory =
  | 'date'
  | 'relax'
  | 'explore'
  | 'food'
  | 'outdoor'
  | 'indoor'
  | 'solo'
  | 'other'

export type BudgetLevel = 'budget' | 'standard' | 'premium' | 'luxury'

export type TripTag =
  | 'not_too_tired'
  | 'indoor_first'
  | 'hidden_gems'
  | 'short_distance'
  | 'food_first'
  | 'photo_first'
  | 'no_full_meals'

export type TransportMode = 'scooter' | 'car' | 'public_transit'

export type PublicTransitType = 'bus' | 'metro' | 'train' | 'walk' | 'mixed'

export type PlanType = 'safe' | 'balanced' | 'explore'

export type StopType = 'main_activity' | 'food' | 'ending_or_transition'

export type TripLocation = {
  name: string
  lat?: number
  lng?: number
}

export type TripInput = {
  category?: TripCategory
  customCategory?: string
  startTime: string
  endTime: string
  transportMode?: TransportMode
  budget?: BudgetLevel
  people?: number
  tags: TripTag[]
  location: TripLocation
}

export type Stop = {
  id: string
  name: string
  type: StopType
  description: string
  address: string
  duration: number
  transport?: string
  googleMapsUrl?: string
  placeId?: string
  lat?: number
  lng?: number
}

export type TransportSegment = {
  fromStopId: string
  toStopId: string
  mode: TransportMode
  publicTransitType?: PublicTransitType
  duration: number
  label: string
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

export type TripPlan = {
  id: string
  type: PlanType
  title: string
  subtitle: string
  summary: string
  totalTime: number
  budget: number
  transportMode: TransportMode
  stops: Stop[]
  transportSegments: TransportSegment[]
  rainBackup: Stop[]
  rainTransportSegments: TransportSegment[]
  scheduleStartTime?: string
  isDetailComplete?: boolean
}
