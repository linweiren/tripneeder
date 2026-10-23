import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { syncBuiltinESMExports, stripTypeScriptTypes } from 'node:module'
import { intentGroundingFixture } from './intent-candidate-grounding.mjs'
import { mealReliabilityGenerationFixture } from './meal-reliability.mjs'
import { mockGeneration, runHandler } from './plan-identity.mjs'
import { assertDemandDelivery } from './demand-delivery-contract.mjs'

const [mode, kind = 'normal'] = process.argv.slice(2)
assert.ok(['baseline', 'off', 'on', 'production', 'writefail', 'partial-writefail', 'directoryfail'].includes(mode))
let root = process.env.ACCEPTANCE_REPLAY_ROOT || mkdtempSync(join(tmpdir(), 'trip-acceptance-'))
if (mode === 'directoryfail') { root = join(root, 'existing-file'); writeFileSync(root, 'UNCHANGED') }
Object.assign(process.env, { GOOGLE_PLACES_API_KEY: 'SECRET_KEY', OPENAI_API_KEY: 'SECRET_KEY',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'SECRET_KEY',
  NODE_ENV: mode === 'production' ? 'production' : 'development', ENABLE_LOCAL_FALLBACK_REFILL: 'false',
  TRIP_CANDIDATE_DEBUG: ['off', 'baseline'].includes(mode) ? 'false' : 'true', TRIP_ACCEPTANCE_EVIDENCE_DIR: root })
const logs = []
for (const key of ['info', 'warn', 'error', 'log', 'debug']) mock.method(console, key, (...args) => {
  if (String(args[0]).startsWith('[acceptance-evidence-')) logs.push(args)
})
mock.method(fs, 'appendFileSync', () => {}) // Never alter the developer's legacy logs.
const originalWrite = fs.writeFileSync
if (mode === 'writefail') mock.method(fs, 'writeFileSync', () => { throw Error('SECRET_DISK_ERROR') })
if (mode === 'partial-writefail') mock.method(fs, 'writeFileSync', (file, ...args) => {
  if (file.endsWith('prompt-evidence.json')) throw Error('SECRET_DISK_ERROR')
  return originalWrite(file, ...args)
})
syncBuiltinESMExports()
const deny = () => { throw Error('Unmocked network forbidden') }
mock.method(globalThis, 'fetch', deny); mock.method(http, 'request', deny)
mock.method(net, 'connect', deny); mock.method(net, 'createConnection', deny); mock.method(tls, 'connect', deny)
const f = kind === 'fallback' ? mealReliabilityGenerationFixture('fallback-meal')
  : intentGroundingFixture(kind.startsWith('related-') ? kind : kind === 'history-coffee' ? 'history-coffee' : ['retry', 'retry-envelope'].includes(kind) ? 'retry-invalid' : ['refill', 'reject-refill'].includes(kind) ? 'retry-balanced' : 'mixed')
const validPlans = structuredClone(f.plans)
if (kind === 'raw-identity') {
  f.aiPlans[0].id = 'original-safe-alias'
  f.aiPlans.push({ ...structuredClone(f.aiPlans[1]), id: 'duplicate-balanced' },
    { id: 'invalid-plan', type: 'invalid', stops: [{ id: 'bad stop', placeId: null, duration: -1 }], token: 'SECRET_MODEL_TEXT' })
}
if (kind === 'geocoding-details') {
  delete f.input.location.lat; delete f.input.location.lng
  for (const plan of f.aiPlans) {
    const stop = plan.stops.find(s => s.type === 'food')
    Object.assign(stop, { placeId: 'uncached-dining', name: '測試正餐食堂', address: '高雄市測試路99號' })
  }
}
const initial = kind === 'parse-failure' ? 'NOT_JSON SECRET_MODEL_TEXT'
  : kind === 'stream-fallback' ? JSON.stringify({ plans: f.aiPlans }).slice(0, -1) : f.aiPlans
mockGeneration({ mock }, f, initial, ids => kind === 'reject-refill'
  ? [{ ...structuredClone(validPlans.find(p => p.type === 'explore')), id: 'unrequested-explore' }]
  : validPlans.filter(p => ids.includes(p.type)), f.mockOptions)
const request = https.request, fetch = globalThis.fetch, calls = []
function reply(callback, data, status = 200) {
  const req = new EventEmitter(); req.write = () => {}; req.setTimeout = () => req
  req.destroy = error => req.emit('error', error)
  req.end = () => queueMicrotask(() => {
    const res = new EventEmitter(); res.statusCode = status; res.headers = {}; callback(res)
    res.emit('data', Buffer.from(JSON.stringify(data))); res.emit('end')
  })
  return req
}
mock.method(https, 'request', (url, options, callback) => {
  const target = new URL(url)
  assert.ok(['maps.googleapis.com', 'places.googleapis.com', 'routes.googleapis.com', 'unit-test.supabase.co'].includes(target.hostname))
  const entry = { url: String(url), options, body: '' }; calls.push(entry)
  let req
  if (target.hostname === 'maps.googleapis.com') req = reply(callback, { status: 'OK', results: [{ formatted_address: '高雄中央公園',
    geometry: { location: { lat: 22.6, lng: 120.3 } }, address_components: [{ long_name: '台灣', short_name: 'TW', types: ['country'] }] }] })
  else if (target.pathname.endsWith('/uncached-dining')) req = reply(callback, {
    id: 'uncached-dining', displayName: { text: '測試正餐食堂' }, formattedAddress: '高雄市測試路99號',
    types: ['restaurant'], businessStatus: 'OPERATIONAL', googleMapsUri: 'https://example.com/dining',
    location: { latitude: 22.612, longitude: 120.3 }, utcOffsetMinutes: 0,
    regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 0 }, close: { day: (day + 1) % 7, hour: 0 } })) },
  })
  else if (kind === 'points-failure' && target.pathname.endsWith('/consume_points_for_analysis')) req = reply(callback, { code: 'P0001', message: 'mock debit failed' }, 400)
  else if (kind === 'route-failure' && target.hostname === 'routes.googleapis.com') req = reply(callback, { error: {} }, 403)
  else req = request(url, options, callback)
  const write = req.write
  req.write = value => { entry.body += value; return write.call(req, value) }
  return req
})
mock.method(globalThis, 'fetch', async (url, init) => {
  calls.push({ url: String(url), init })
  if (kind === 'ai-http-failure') return new Response('{}', { status: 503 })
  if (kind === 'ai-network-failure') throw Error('SECRET_NETWORK_ERROR')
  const response = await fetch(url, init)
  if (kind === 'retry-envelope' && !JSON.parse(init.body).stream) return Response.json({ choices: [], usage: { total_tokens: 123 } })
  if (kind === 'usage' && JSON.parse(init.body).stream) return new Response(await response.text() +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, token: 'SECRET_KEY' } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } })
  if (kind === 'usage' && !JSON.parse(init.body).stream) {
    const value = await response.json()
    return Response.json({ ...value, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, token: 'SECRET_KEY' } })
  }
  return response
})
let handler
const file = new URL('../../../api/generate-trip.ts', import.meta.url)
const source = readFileSync(file, 'utf8')
const handlerSourceSha256 = createHash('sha256').update(source).digest('hex')
if (mode === 'baseline') {
  // Direct current implementation vs current wrapper off/on: observation alone
  // may not alter delivery. No historical recommendation code is substituted.
  const wrapper = 'return withAcceptanceEvidence(req.body, res, sink => generateTrip(req, sink))'
  assert.equal(source.split(wrapper).length, 2)
  const js = stripTypeScriptTypes(source.replace(wrapper, 'return generateTrip(req, res)')).replace(/from (['"])([^'"]+)\1/g, (_m, q, s) =>
    `from ${q}${s.startsWith('.') ? new URL(s.replace(/\.js$/, '.ts'), file).href : import.meta.resolve(s)}${q}`)
  handler = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).default
} else handler = (await import('../../../api/generate-trip.ts')).default
const result = await runHandler(handler, f)
if (result.response) {
  const states = await assertDemandDelivery(result, f)
  if (['normal', 'history-coffee', 'related-history', 'related-retry', 'related-refill'].includes(kind)) {
    assert.ok(states.every(state => Object.values(state).every(value => value === 'satisfied')))
  }
}
const folders = mode !== 'directoryfail' && existsSync(root) ? readdirSync(root) : []
if (mode === 'directoryfail') assert.equal(readFileSync(root, 'utf8'), 'UNCHANGED')
const bundles = folders.map(folder => {
  const directory = join(root, folder), files = readdirSync(directory), data = {}
  for (const file of files) data[file] = JSON.parse(readFileSync(join(directory, file), 'utf8'))
  if (data['manifest.json']) {
    assert.equal(data['manifest.json'].requestId, folder)
    for (const [file, sha] of Object.entries(data['manifest.json'].files)) {
      assert.equal(createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'), sha)
      assert.equal(data[file].requestId, folder)
    }
  }
  return { directory, files, data }
})
process.stdout.write(JSON.stringify({ mode, kind, result, calls, logs, bundles, handlerSourceSha256 }))
mock.restoreAll(); mock.timers.reset()
