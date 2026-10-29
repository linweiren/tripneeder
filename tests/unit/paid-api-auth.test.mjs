import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { mockGeneration } from './fixtures/plan-identity.mjs'
import { mealReliabilityGenerationFixture } from './fixtures/meal-reliability.mjs'
import { reverseGeocodeCoordinates } from '../../src/services/auth/reverseGeocode.ts'

Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_ANON_KEY: 'public-unit-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'admin-unit-test-key' })
const names = ['generate-trip-details', 'get-candidates', 'geocode', 'recompute-routes']
const apis = Object.fromEntries(await Promise.all(names.map(async name => [name, (await import(`../../api/${name}.ts`)).default])))
const verifiedId = '11111111-1111-4111-8111-111111111111'
const validToken = 'valid-unit-test-session'
const forged = `fixture.${Buffer.from(JSON.stringify({ sub: 'attacker', exp: 9999999999 })).toString('base64url')}.wrong-signature`
const input = { category: 'explore', startTime: '08:00', endTime: '18:00', transportMode: 'scooter', tags: [],
  location: { name: 'fixture', lat: 22.6, lng: 120.3 } }
const stops = [{ id: 'a', placeId: 'a', name: 'A', lat: 22.6, lng: 120.3, type: 'main_activity', duration: 45 },
  { id: 'b', placeId: 'b', name: 'B', lat: 22.61, lng: 120.3, type: 'main_activity', duration: 45 }]
const bodies = { 'generate-trip-details': { input, plan: { id: 'safe', type: 'safe', stops, transportSegments: [] } },
  'get-candidates': { input }, geocode: { lat: 22.6, lng: 120.3 }, 'recompute-routes': { stops, transportMode: 'scooter' } }
const authUrl = 'https://unit-test.supabase.co/auth/v1/user'

function sink() {
  return { statusCode: 200, body: undefined, headers: {}, ended: false,
    status(code) { this.statusCode = code; return this }, json(body) { this.body = body },
    setHeader(key, value) { this.headers[key] = value }, end() { this.ended = true } }
}
function quiet(t) {
  for (const key of ['warn', 'error', 'info', 'debug']) t.mock.method(console, key, () => {})
}
function authResponse() { return Response.json({ id: verifiedId, aud: 'authenticated', role: 'authenticated' }) }

for (const name of names) for (const [kind, header, authResult] of [
  ['no token', undefined], ['malformed header', 'Basic invalid'],
  ['forged JWT', `Bearer ${forged}`, () => Response.json({ msg: 'invalid signature' }, { status: 401 })],
  ['expired token', 'Bearer expired', () => Response.json({ msg: 'JWT expired' }, { status: 401 })],
  ['revoked token', 'Bearer revoked', () => Response.json({ msg: 'session not found' }, { status: 403 })],
  ['no verified identity', 'Bearer no-user', () => Response.json({})],
  ['verification outage', 'Bearer unavailable', () => Response.json({}, { status: 503 })],
  ['verification network error', 'Bearer network-error', () => { throw Error('mock connection failed') }],
]) test(`${name}: ${kind} cannot reach a paid provider`, async t => {
  quiet(t)
  let authCalls = 0
  t.mock.method(https, 'request', () => { assert.fail('No Google, Supabase REST, or points call is allowed') })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), authUrl, 'Only the free Supabase identity verification may be called')
    assert.equal(new Headers(init.headers).get('authorization'), header)
    assert.equal(new Headers(init.headers).get('apikey'), 'public-unit-test-key')
    authCalls++
    return authResult()
  })
  const res = sink()
  await apis[name]({ method: 'POST', headers: { authorization: header }, body: structuredClone(bodies[name]) }, res)
  assert.equal(res.statusCode, kind.startsWith('verification') ? 503 : 401)
  assert.equal(authCalls, authResult ? 1 : 0)
  assert.doesNotMatch(JSON.stringify(res.body), /attacker|wrong-signature|unit-test-key|connection failed/)
})

for (const name of names) for (const method of ['OPTIONS', 'GET']) test(`${name}: ${method} needs no token or provider call`, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected fetch'))
  t.mock.method(https, 'request', () => assert.fail('Unexpected HTTPS'))
  const res = sink()
  res.headers['Access-Control-Allow-Origin'] = 'https://existing-browser-origin.example'
  await apis[name]({ method }, res)
  assert.equal(res.statusCode, method === 'OPTIONS' ? 204 : 405)
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://existing-browser-origin.example')
  if (method === 'OPTIONS') {
    assert.equal(res.ended, true)
    assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/)
  }
})

test('authenticated details preserve itinerary, use the verified identity, and consume zero points', async t => {
  quiet(t)
  const f = mealReliabilityGenerationFixture('sketch-safe')
  const calls = mockGeneration(t, f, f.aiPlans)
  let authCalls = 0, aiCalls = 0, profileCalls = 0
  const request = https.request
  t.mock.method(https, 'request', (url, options, callback) => {
    const u = new URL(url)
    assert.ok(!u.pathname.includes('/rpc/'), 'Details must not initialize, check, or debit points')
    if (u.hostname === 'unit-test.supabase.co' && u.pathname.endsWith('/profiles')) {
      assert.equal(u.searchParams.get('id'), `eq.${verifiedId}`)
      profileCalls++
    }
    return request(url, options, callback)
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === authUrl) {
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${validToken}`)
      authCalls++
      return authResponse()
    }
    assert.equal(String(url), 'https://api.openai.com/v1/responses')
    aiCalls++
    return Response.json({ output_text: JSON.stringify({ plan: {
      stops: f.plan.stops.map(s => ({ id: s.id, description: 'fixture details' })), rainBackup: [], rainTransportSegments: [],
    } }) })
  })
  const res = sink()
  await apis['generate-trip-details']({ method: 'POST', headers: { authorization: `Bearer ${validToken}` },
    body: { input: f.input, plan: structuredClone(f.plan) } }, res)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(authCalls, 1)
  assert.equal(profileCalls, 1)
  assert.equal(aiCalls, 1)
  assert.equal(calls.points, 0)
  assert.deepEqual(res.body.plan.stops.map(s => [s.id, s.placeId, s.type, s.duration]),
    f.plan.stops.map(s => [s.id, s.placeId, s.type, s.duration]))
})

for (const name of ['get-candidates', 'geocode', 'recompute-routes']) test(`${name}: valid session retains the existing result`, async t => {
  quiet(t)
  const f = mealReliabilityGenerationFixture('sketch-safe')
  const calls = mockGeneration(t, f, f.aiPlans)
  let authCalls = 0, geocodingCalls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === authUrl) {
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${validToken}`)
      authCalls++
      return authResponse()
    }
    assert.equal(new URL(url).hostname, 'maps.googleapis.com')
    geocodingCalls++
    return Response.json({ status: 'OK', results: [{ formatted_address: 'fixture address', address_components: [
      { types: ['administrative_area_level_1'], long_name: '高雄市' },
      { types: ['locality'], long_name: '新興區' }, { types: ['country'], short_name: 'TW' },
    ] }] })
  })
  const res = sink()
  const body = name === 'get-candidates' ? { input: f.input } : name === 'recompute-routes'
    ? { stops: f.plan.stops, transportMode: 'scooter' } : bodies.geocode
  await apis[name]({ method: 'POST', headers: { authorization: `Bearer ${validToken}` }, body }, res)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(authCalls, 1)
  assert.equal(calls.points, 0)
  if (name === 'get-candidates') assert.ok(res.body.allCandidates.length > 0)
  if (name === 'geocode') {
    assert.equal(geocodingCalls, 1)
    assert.deepEqual(res.body, { name: '高雄市新興區', address: 'fixture address', country: 'TW' })
  }
  if (name === 'recompute-routes') {
    assert.equal(res.body.transportSegments.length, f.plan.stops.length - 1)
    assert.equal(res.body.routesFailed, false)
  }
})

for (const name of names) test(`${name}: signed-in malformed input still returns 400 without a paid call`, async t => {
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(String(url), authUrl); return authResponse() })
  t.mock.method(https, 'request', () => assert.fail('Unexpected paid request'))
  const res = sink()
  await apis[name]({ method: 'POST', headers: { authorization: `Bearer ${validToken}` }, body: {} }, res)
  assert.equal(res.statusCode, 400)
})

test('anonymous GPS requires no reverse-geocoding request; authenticated lookup forwards the session', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    assert.equal(url, '/api/geocode')
    assert.equal(init.headers.Authorization, `Bearer ${validToken}`)
    assert.deepEqual(JSON.parse(init.body), { lat: 22.6, lng: 120.3 })
    return Response.json({ name: 'fixture location' })
  })
  assert.equal(await reverseGeocodeCoordinates(22.6, 120.3), null)
  assert.equal(calls, 0)
  assert.deepEqual(await reverseGeocodeCoordinates(22.6, 120.3, validToken), { name: 'fixture location' })
  assert.equal(calls, 1)
})

test('expired browser lookup returns no name so existing GPS coordinates remain usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'expired' }, { status: 401 }))
  assert.equal(await reverseGeocodeCoordinates(22.6, 120.3, 'expired'), null)
})
