import https from 'node:https'
import { EventEmitter } from 'node:events'

export const FIXED_NOW = new Date('2026-10-08T00:00:00Z').getTime()

// Measured before implementation against aa49ca55, with the same fixed matrix below.
export const BASELINE = {
  city: { selected: ['A', 'far', 'B'], stay: 220, travel: 80, originalLoss: 15, valid: true, routeCalls: 3 },
  'valuable-far': { selected: ['A', 'far', 'B'], stay: 200, travel: 80, originalLoss: 0, valid: true, routeCalls: 3 },
  'explore-seventh': { selected: ['A', 'rank-7', 'B'], stay: 240, travel: 25, originalLoss: 0, valid: true, routeCalls: 3 },
  position: { selected: ['A', 'B', 'near', 'C'], stay: 210, travel: 90, originalLoss: 30, valid: true, routeCalls: 5 },
  compression: { selected: ['A', 'far', 'B'], stay: 220, travel: 80, originalLoss: 15, valid: true, routeCalls: 3 },
  deletion: { selected: ['A', 'far'], stay: 164, travel: 100, originalLoss: 81, valid: true, routeCalls: 4 },
  'legal-gap': { selected: ['A', 'B'], stay: 220, travel: 10, originalLoss: 0, valid: true, routeCalls: 1 },
  'routes-failure': { selected: ['A', 'B'], stay: 180, travel: 13, originalLoss: 0, valid: false, routeCalls: 1 },
  diversity: { selected: ['A', 'unused', 'B'], stay: 240, travel: 25, originalLoss: 0, valid: true, routeCalls: 3 },
  reuse: { selected: ['A', 'used', 'B'], stay: 240, travel: 25, originalLoss: 0, valid: true, routeCalls: 3 },
}

export function fixture(name) {
  const input = { startTime: '10:00', endTime: '15:00', tags: ['no_full_meals'],
    location: { name: 'fixture', lat: 22.6, lng: 120.3 }, transportMode: 'scooter' }
  const hours = { isKnown: true, isNeverOpen: false, utcOffsetMinutes: 0,
    windows: [{ openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 86400000) }] }
  const make = (id, duration, offset, score = 100) => ({ id, placeId: id, name: id,
    address: `${id} address`, description: '', type: 'main_activity', duration,
    lat: 22.6 + offset, lng: 120.3, distanceKm: offset * 111,
    googleMapsUrl: `https://example.com/${id}`, role: 'main_activity', score, openingHours: { ...hours } })
  let stops = [make('A', 90, 0), make('B', 75, 0.02)]
  let extras = [make('far', 75, 0.1), make('near', 75, 0.01)]
  let routes = { 'A>B': 10, 'A>far': 40, 'far>B': 40, 'B>far': 80,
    'A>near': 12, 'near>B': 13, 'B>near': 30 }
  let crossPlanUsed = new Set()
  if (name === 'valuable-far') {
    stops[0].duration = 60
    stops[1].duration = 65
    extras[0].score = 115
    extras[1].score = 90
  } else if (name === 'explore-seventh') {
    extras = Array.from({ length: 7 }, (_, i) => make(`rank-${i + 1}`, 75, 0.01 + i * 0.001, 100 - i * 10))
    routes = { 'A>B': 10 }
    for (const c of extras) Object.assign(routes, { [`A>${c.id}`]: 12, [`${c.id}>B`]: 13, [`B>${c.id}`]: 30 })
  } else if (name === 'position') {
    stops = [make('A', 60, 0), make('B', 60, 0.02), make('C', 60, 0.04)]
    extras = [make('near', 75, 0.01)]
    routes = { 'A>B': 10, 'B>C': 10, 'A>near': 10, 'near>B': 10,
      'B>near': 40, 'near>C': 40, 'C>near': 35 }
  } else if (name === 'compression') {
    extras[1].score = 99
  } else if (name === 'deletion') {
    extras[1].score = 99
    Object.assign(routes, { 'A>far': 100, 'far>B': 100, 'B>far': 200 })
  } else if (name === 'legal-gap') {
    stops.forEach(s => { s.duration = 110 })
  } else if (name === 'diversity') {
    extras = [make('used', 75, 0.01), make('unused', 75, 0.011, 99)]
    crossPlanUsed = new Set(['used'])
    routes = { 'A>B': 10, 'A>used': 12, 'used>B': 13, 'B>used': 30,
      'A>unused': 12, 'unused>B': 13, 'B>unused': 30 }
  } else if (name === 'reuse') {
    extras = [make('used', 75, 0.01)]
    crossPlanUsed = new Set(['used'])
    routes = { 'A>B': 10, 'A>used': 12, 'used>B': 13, 'B>used': 30 }
  }
  const plan = { id: 'explore', type: 'explore', title: '', subtitle: '', summary: '', budget: 0,
    transportMode: 'scooter', totalTime: 0, stops, rainBackup: [], rainTransportSegments: [],
    transportSegments: stops.slice(1).map((s, i) => ({ fromStopId: stops[i].id, toStopId: s.id,
      duration: routes[`${stops[i].id}>${s.id}`], mode: 'scooter', label: '' })) }
  const allCandidates = [...stops, ...extras]
  return { input, plan, extras, crossPlanUsed, routes, failRoutes: name === 'routes-failure',
    candidates: { allCandidates, firstStopCandidates: allCandidates.filter(c => c.distanceKm <= 2),
      otherCandidates: allCandidates } }
}

export function mockMatrix(t, f, delayMs = 0) {
  const calls = []
  calls.stats = { waves: 0, peak: 0, active: 0 }
  const byPosition = new Map(f.candidates.allCandidates.map(c => [`${c.lat},${c.lng}`, c.placeId]))
  t.mock.method(https, 'request', (url, _options, callback) => {
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = chunk => { body += chunk }
    req.destroy = error => req.emit('error', error)
    req.end = () => {
      const isRoute = String(url).includes('routes.googleapis.com')
      if (isRoute) {
        if (calls.stats.active === 0) calls.stats.waves++
        calls.stats.active++
        calls.stats.peak = Math.max(calls.stats.peak, calls.stats.active)
      }
      const deliver = () => {
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      let payload
      if (String(url).includes('routes.googleapis.com')) {
        const data = JSON.parse(body)
        const id = point => byPosition.get(`${point.location.latLng.latitude},${point.location.latLng.longitude}`)
        const key = `${id(data.origin)}>${id(data.destination)}`
        calls.push(key)
        const duration = f.routes[key]
        payload = f.failRoutes || duration === undefined ? { routes: [] }
          : { routes: [{ duration: `${duration * 60}s`, distanceMeters: 1000 }] }
      } else {
        const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
        payload = { id, displayName: { text: id }, formattedAddress: `${id} address`, utcOffsetMinutes: 0,
          regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({
            open: { day, hour: 0, minute: 0 }, close: { day: (day + 1) % 7, hour: 0, minute: 0 },
          })) } }
        if (f.placeOverrides?.[id]) payload = { ...payload, ...f.placeOverrides[id] }
      }
      res.emit('data', Buffer.from(JSON.stringify(payload)))
      res.emit('end')
      if (isRoute) calls.stats.active--
      }
      if (delayMs && isRoute) setTimeout(deliver, delayMs)
      else queueMicrotask(deliver)
    }
    return req
  })
  return calls
}

export function metrics(f, result, issues, calls) {
  const p = result.plan
  return { selected: p.stops.map(s => s.placeId), stay: p.stops.reduce((n, s) => n + s.duration, 0),
    travel: p.transportSegments.reduce((n, s) => n + s.duration, 0),
    originalLoss: f.plan.stops.reduce((n, s) => n + Math.max(0, s.duration -
      (p.stops.find(next => next.placeId === s.placeId)?.duration ?? 0)), 0),
    valid: issues.length === 0 && !result.routesFailed, routeCalls: calls.length }
}
