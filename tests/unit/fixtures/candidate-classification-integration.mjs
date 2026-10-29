import https from 'node:https'
import { EventEmitter } from 'node:events'
import { classificationInput, classificationPlace, CLASSIFICATION_NOW } from './candidate-classification.mjs'

export const INTEGRATION_NOW = CLASSIFICATION_NOW
export const CULTURE_REPLAYS = ['museum-cafe', 'alien', 'wrong-id-museum-name']

// The six culture regressions reproduce the prior audit's venue evidence, AI
// identity conflicts and 90/75/70-minute skeleton. Business hours and coordinates
// are fixed test data, not fresh facts about ALIEN or any other real venue.
export function integrationFixture(kind, tags = [], style = 'explore', variant = '') {
  const prefix = `${kind}-${tags.includes('food_first') ? 'food-first' : 'explore'}-${variant}`
  const make = (suffix, name, types, latitude) => classificationPlace(`${prefix}-${suffix}`, name, types,
    `高雄市文化路${suffix === 'anchor' ? 1 : suffix === 'target' ? 2 : 3}號`,
    { location: { latitude, longitude: 120.3 } })
  const anchor = make('anchor', '地方歷史博物館甲', ['museum', 'tourist_attraction'], 22.605)
  const target = make('target', '城市藝術博物館乙', ['museum', 'cafe', 'restaurant', 'food'], 22.607)
  const meal = make('meal', '澄心客家風味料理餐廳', ['restaurant', 'chinese_restaurant', 'food'], 22.609)
  const rawPlaces = [anchor, target, meal]
  if (kind === 'alien') Object.assign(target, {
    displayName: { text: '金馬賓館當代美術館 ALIEN Art Centre' },
    types: ['cultural_center', 'museum', 'art_museum', 'restaurant', 'food'],
  })
  if (kind === 'restaurant') Object.assign(target, {
    displayName: { text: '河畔古早味風味料理餐廳' }, types: ['restaurant', 'food'],
  })
  if (kind === 'cafe') Object.assign(target, {
    displayName: { text: '時光藝境庭園咖啡館' }, types: ['cafe', 'food'],
  })
  if (kind === 'dessert') Object.assign(target, {
    displayName: { text: '手作甜點店' }, types: ['dessert_shop', 'bakery', 'food'],
  })
  if (kind === 'bar' || kind === 'bar-default-role') Object.assign(target, {
    displayName: { text: '暮光 Lounge' }, types: ['bar'],
  })
  if (kind === 'default-main') Object.assign(target, {
    displayName: { text: '複合生活空間' }, types: ['point_of_interest'],
  })
  if (kind === 'ambiguous-mixed') Object.assign(target, {
    displayName: { text: '複合生活空間' }, types: ['museum', 'restaurant', 'food'],
  })
  if (kind === 'museum-cafe-business') Object.assign(target, {
    displayName: { text: '博物館咖啡廳' }, types: ['museum', 'cafe', 'food'],
  })
  if (kind === 'pure-museum-ai-food') target.types = ['museum']
  if (kind === 'closed-culture' || kind === 'closing-buffer') {
    target.currentOpeningHours = { periods: [{
      open: { day: 0, hour: 0, minute: 0, date: { year: 2026, month: 10, day: 4 } },
      close: { day: 0, hour: kind === 'closed-culture' ? 10 : 13, minute: kind === 'closed-culture' ? 30 : 0,
        date: { year: 2026, month: 10, day: 4 } },
    }] }
  }
  if (['closed-culture', 'closing-buffer', 'diversity'].includes(kind)) {
    rawPlaces.push(make('alternative', '城市藝術博物館丙', ['museum', 'cafe', 'food'], 22.608))
  }
  if (kind === 'far-first') target.location.latitude = 22.63
  if (kind === 'unknown-hours') target.currentOpeningHours = undefined
  if (kind === 'culture-only') rawPlaces.splice(rawPlaces.indexOf(meal), 1)
  const asStop = (place, type, duration, index) => ({ id: `${prefix}-stop-${index}`,
    name: place.displayName.text, address: place.formattedAddress, placeId: place.id,
    type, duration, description: '', googleMapsUrl: place.googleMapsUri,
    lat: place.location.latitude, lng: place.location.longitude })
  const targetType = ['cafe', 'dessert', 'pure-museum-ai-food', 'mixed-ai-food'].includes(kind) ? 'food' : 'main_activity'
  let stops = [asStop(anchor, 'main_activity', 90, 0), asStop(target, targetType, 75, 1), asStop(meal, 'food', 70, 2)]
  if (kind === 'wrong-id-museum-name') stops[1].placeId = meal.id
  if (kind === 'wrong-id-restaurant-name') Object.assign(stops[1], { name: meal.displayName.text })
  if (kind === 'wrong-id-unsupported-alias') Object.assign(stops[1], {
    name: '未獲核實的文化別名', placeId: meal.id,
  })
  if (kind === 'far-first') stops = [stops[1], stops[0], stops[2]]
  if (kind === 'culture-only') stops = stops.slice(0, 2)
  const input = classificationInput({ tags })
  const plan = { id: style, type: style, title: '', subtitle: '', summary: '', budget: 0,
    transportMode: 'scooter', totalTime: 0, stops, rainBackup: [], rainTransportSegments: [],
    transportSegments: stops.slice(1).map((s, i) => ({ fromStopId: stops[i].id,
      toStopId: s.id, mode: 'scooter', duration: 4, label: '' })) }
  return { kind, input, plan, rawPlaces, anchor, target, meal, failRoutes: kind === 'routes-failure' }
}

// All external calls are intercepted, including rejected candidates' Details.
// Counts distinguish paid boundaries; an unexpected URL cannot reach a service.
export function mockIntegrationNetwork(t, fixture) {
  const calls = { searches: [], details: [], routes: [] }
  t.mock.timers.enable({ apis: ['Date'], now: INTEGRATION_NOW })
  t.mock.method(console, 'info', () => {})
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external fetch') })
  const byId = new Map(fixture.rawPlaces.map(p => [p.id, p]))
  const byPosition = new Map(fixture.rawPlaces.map(p => [`${p.location.latitude},${p.location.longitude}`, p.id]))
  t.mock.method(https, 'request', (url, options, callback) => {
    const target = new URL(url)
    if (!['places.googleapis.com', 'routes.googleapis.com'].includes(target.hostname)) {
      throw new Error(`Unexpected external request: ${url}`)
    }
    let body = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { body += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      let payload, statusCode = 200
      if (target.hostname === 'routes.googleapis.com') {
        const data = JSON.parse(body)
        const id = point => byPosition.get(`${point.location.latLng.latitude},${point.location.latLng.longitude}`)
        calls.routes.push(`${id(data.origin)}>${id(data.destination)}`)
        payload = fixture.failRoutes ? { routes: [] } : { routes: [{ duration: '240s', distanceMeters: 1000 }] }
      } else if (target.pathname === '/v1/places:searchText') {
        calls.searches.push({ body: JSON.parse(body), mask: options.headers['x-goog-fieldmask'] })
        payload = { places: fixture.rawPlaces }
      } else if (target.pathname.startsWith('/v1/places/')) {
        const id = decodeURIComponent(target.pathname.split('/').at(-1))
        calls.details.push(id)
        payload = byId.get(id)
        if (!payload) { statusCode = 404; payload = { error: { message: 'Unknown fixture ID' } } }
      } else throw new Error(`Unexpected Places endpoint: ${url}`)
      const res = new EventEmitter()
      res.statusCode = statusCode
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify(payload)))
      res.emit('end')
    })
    return req
  })
  return calls
}

export function stopObservation(stop, getActivityPurpose) {
  return stop && { name: stop.name, placeId: stop.placeId, candidateRole: stop.candidateRole,
    type: stop.type, duration: stop.duration, purpose: getActivityPurpose(stop) }
}
