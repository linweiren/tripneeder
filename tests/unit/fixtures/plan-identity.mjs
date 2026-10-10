import https from 'node:https'
import { EventEmitter } from 'node:events'
import { suitabilityFixture } from './meal-suitability.mjs'
import { FIXED_NOW } from './supplement-quality.mjs'

let sequence = 0
export function identityFixture() {
  const f = suitabilityFixture('museum-coherent')
  const suffix = `identity-${++sequence}`
  const idMap = new Map(f.candidates.allCandidates.map(c => [c.placeId, `${c.placeId}-${suffix}`]))
  const rename = stop => ({ ...stop, id: `${stop.id}-${suffix}`, placeId: idMap.get(stop.placeId) })
  f.plan.stops = f.plan.stops.map(rename)
  f.candidates.allCandidates = f.candidates.allCandidates.map(rename)
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = Object.fromEntries(Object.entries(f.routes).map(([key, duration]) => {
    const [from, to] = key.split('>')
    return [`${idMap.get(from)}>${idMap.get(to)}`, duration]
  }))
  f.plan.transportSegments = f.plan.stops.slice(1).map((stop, index) => ({
    fromStopId: f.plan.stops[index].id, toStopId: stop.id, mode: 'scooter', label: '',
    duration: f.routes[`${f.plan.stops[index].placeId}>${stop.placeId}`],
  }))
  f.plan.totalTime = f.plan.stops.reduce((n, s) => n + s.duration, 0) + 8
  f.plan.title = '原始合法方案'
  f.plans = ['safe', 'balanced', 'explore'].map(type => ({ ...structuredClone(f.plan), id: type, type }))
  return f
}

// Every external boundary is mocked. Unexpected URLs fail the test rather than
// falling through to a live service; the production handler and final gates run.
export function mockGeneration(t, f, initial, refill = (ids) => f.plans.filter(p => ids.includes(p.type)), options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const calls = { ai: [], routes: [], points: 0 }
  const places = f.candidates.allCandidates.map(c => ({
    id: c.placeId, displayName: { text: c.name }, formattedAddress: c.address,
    location: { latitude: c.lat, longitude: c.lng },
    types: c.types ?? (c.type === 'food' ? ['restaurant'] : ['tourist_attraction']),
    businessStatus: 'OPERATIONAL', utcOffsetMinutes: 0, rating: 4.5, userRatingCount: 100,
    googleMapsUri: c.googleMapsUrl,
    regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 0, minute: 0 }, close: { day: (day + 1) % 7, hour: 0, minute: 0 },
    })) },
  }))
  const byPosition = new Map(f.candidates.allCandidates.map(c => [`${c.lat},${c.lng}`, c.placeId]))
  t.mock.method(https, 'request', (url, _init, callback) => {
    const target = new URL(url)
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      let payload, status = 200
      if (target.hostname === 'unit-test.supabase.co') {
        if (target.pathname.endsWith('/get_my_points_balance')) payload = 100
        else if (target.pathname.endsWith('/consume_points_for_analysis')) { calls.points++; payload = null }
        else if (target.pathname.includes('/rpc/')) payload = null
        else if (target.pathname.endsWith('/profiles')) payload = options.persona ?? {}
        else if (target.pathname.endsWith('/personalization_events')) payload = options.preferenceEvents ?? []
        else throw new Error(`Unexpected mock Supabase URL: ${target}`)
      } else if (target.hostname === 'places.googleapis.com') {
        if (target.pathname.endsWith(':searchText')) payload = { places }
        else {
          payload = places.find(p => p.id === decodeURIComponent(target.pathname.split('/').at(-1)))
          if (!payload) { payload = { error: { message: 'fixture place not found' } }; status = 404 }
        }
      } else if (target.hostname === 'routes.googleapis.com') {
        const data = JSON.parse(body)
        const point = value => byPosition.get(`${value.location.latLng.latitude},${value.location.latLng.longitude}`)
        const key = `${point(data.origin)}>${point(data.destination)}`
        calls.routes.push(key)
        const duration = f.routes[key]
        payload = options.failRoutes || duration === undefined ? { routes: [] }
          : { routes: [{ duration: `${duration * 60}s`, distanceMeters: 1000 }] }
      } else throw new Error(`Unexpected mock HTTPS URL: ${target}`)
      const res = new EventEmitter()
      res.statusCode = status
      res.headers = { 'content-type': 'application/json' }
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify(payload)))
      res.emit('end')
    })
    return req
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assertOpenAi(url)
    const body = JSON.parse(init.body)
    calls.ai.push(body)
    if (body.stream) {
      const content = typeof initial === 'string' ? initial : JSON.stringify({ plans: initial })
      const event = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}`
      // Exercise both ordinary SSE chunks and the trailing-buffer parser.
      return new Response(options.streamTail ? event : `${event}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const prompt = body.messages[0].content
    const targetIds = /需重產的方案 ID：([^\n]*)/.exec(prompt)?.[1].trim().split(/,\s*/) ?? ['safe', 'balanced', 'explore']
    const plans = await refill(targetIds, calls.ai.length, body)
    return new Response(JSON.stringify({ choices: [{ message: { content:
      typeof plans === 'string' ? plans : JSON.stringify({ plans }) } }] }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

function assertOpenAi(url) {
  if (String(url) !== 'https://api.openai.com/v1/chat/completions') {
    throw new Error(`Unexpected mock fetch URL: ${url}`)
  }
}

export async function runHandler(handler, f) {
  const events = []
  let statusCode = 200
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url')}.fixture`
  const res = {
    status(code) { statusCode = code; return this },
    setHeader() {},
    json(body) { events.push({ event: 'http-error', ...body }) },
    write(chunk) { events.push(JSON.parse(chunk)) },
    end() {},
  }
  await handler({ method: 'POST', body: { input: f.input }, headers: { authorization: `Bearer ${token}` } }, res)
  return { statusCode, events, response: events.find(e => e.event === 'done')?.response }
}
