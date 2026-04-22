/// <reference types="node" />

import type { Stop, TransportMode, TransportSegment } from '../../src/types/trip.js'

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

export async function getRouteInfo(
  from: Stop,
  to: Stop,
  mode: TransportMode,
): Promise<{ routeInfo: { durationMinutes?: number; distanceMeters?: number } | null; apiFailed: boolean }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (
    !apiKey ||
    typeof from.lat !== 'number' ||
    typeof from.lng !== 'number' ||
    typeof to.lat !== 'number' ||
    typeof to.lng !== 'number'
  ) {
    return { routeInfo: null, apiFailed: !apiKey }
  }

  try {
    const response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: { latitude: from.lat, longitude: from.lng },
          },
        },
        destination: {
          location: {
            latLng: { latitude: to.lat, longitude: to.lng },
          },
        },
        travelMode: toRoutesTravelMode(mode),
      }),
    })

    if (!response.ok) {
      // 403 Forbidden often means API not enabled
      return { routeInfo: null, apiFailed: response.status === 403 || response.status === 401 }
    }

    const data = (await response.json()) as {
      routes?: Array<{ duration?: string; distanceMeters?: number }>
    }
    const route = data.routes?.[0]
    if (!route) return { routeInfo: null, apiFailed: false }

    return {
      routeInfo: {
        durationMinutes: parseGoogleDurationToMinutes(route.duration),
        distanceMeters: route.distanceMeters,
      },
      apiFailed: false,
    }
  } catch {
    return { routeInfo: null, apiFailed: true }
  }
}

function toRoutesTravelMode(mode: TransportMode) {
  if (mode === 'public_transit') return 'TRANSIT'
  if (mode === 'scooter') return 'TWO_WHEELER'

  return 'DRIVE'
}

function parseGoogleDurationToMinutes(duration?: string) {
  const seconds = Number(duration?.replace(/s$/, ''))
  if (!Number.isFinite(seconds)) return undefined

  return Math.max(1, Math.round(seconds / 60))
}

export function estimateSegmentDuration(from: Stop, to: Stop, mode: TransportMode) {
  const distanceKm = getStopDistanceKm(from, to)

  if (distanceKm === null) {
    return mode === 'public_transit' ? 25 : 18
  }

  const speedByMode: Record<TransportMode, number> = {
    scooter: 24,
    car: 28,
    public_transit: 16,
  }
  const bufferByMode: Record<TransportMode, number> = {
    scooter: 7,
    car: 10,
    public_transit: 14,
  }
  const minutes = Math.round((distanceKm / speedByMode[mode]) * 60 + bufferByMode[mode])

  return clamp(minutes, mode === 'public_transit' ? 12 : 8, mode === 'public_transit' ? 55 : 45)
}

function getStopDistanceKm(from: Stop, to: Stop) {
  if (
    typeof from.lat !== 'number' ||
    typeof from.lng !== 'number' ||
    typeof to.lat !== 'number' ||
    typeof to.lng !== 'number'
  ) {
    return null
  }

  return calculateDistance(from.lat, from.lng, to.lat, to.lng)
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

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function buildTransportLabel(
  mode: TransportMode,
  publicTransitType?: TransportSegment['publicTransitType'],
  distanceMeters?: number,
  isEstimated?: boolean,
) {
  const distanceText =
    typeof distanceMeters === 'number' && distanceMeters > 0
      ? `約 ${formatDistance(distanceMeters)}`
      : ''
  const prefix = isEstimated ? '(估算)' : ''

  if (mode === 'public_transit') {
    if (publicTransitType === 'walk') return prefix + joinTransportLabel('步行轉乘', distanceText)
    if (publicTransitType === 'metro') return prefix + joinTransportLabel('捷運接駁', distanceText)
    if (publicTransitType === 'bus') return prefix + joinTransportLabel('公車接駁', distanceText)
    if (publicTransitType === 'train') return prefix + joinTransportLabel('鐵路接駁', distanceText)
    return prefix + joinTransportLabel('大眾運輸', distanceText)
  }

  return prefix + joinTransportLabel(mode === 'car' ? '開車前往' : '騎車前往', distanceText)
}

function joinTransportLabel(label: string, distanceText: string) {
  return distanceText ? `${label}・${distanceText}` : label
}

function formatDistance(distanceMeters: number) {
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`

  return `${(distanceMeters / 1000).toFixed(1)} km`
}

export async function repairTransportSegments(
  segments: TransportSegment[],
  stops: Stop[],
  fallbackMode: TransportMode,
): Promise<{ segments: TransportSegment[]; routesFailed: boolean }> {
  const expectedLength = Math.max(stops.length - 1, 0)
  let routesFailed = false

  const nextSegments = await Promise.all(
    Array.from({ length: expectedLength }, async (_, index) => {
      const existing = segments[index]
      const mode = existing?.mode ?? fallbackMode
      const { routeInfo, apiFailed } = await getRouteInfo(stops[index], stops[index + 1], mode)

      if (apiFailed) {
        routesFailed = true
      }

      const duration =
        routeInfo?.durationMinutes ?? estimateSegmentDuration(stops[index], stops[index + 1], mode)

      return {
        fromStopId: stops[index].id,
        toStopId: stops[index + 1].id,
        mode,
        publicTransitType: existing?.publicTransitType,
        duration,
        label: buildTransportLabel(
          mode,
          existing?.publicTransitType,
          routeInfo?.distanceMeters,
          !routeInfo, // isEstimated if no routeInfo returned
        ),
      }
    }),
  )

  return { segments: nextSegments, routesFailed }
}
