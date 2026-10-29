import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { foodPurposeFixture } from './food-purpose-protection.mjs'
import { FIXED_NOW, mockMatrix } from './supplement-quality.mjs'
import { mealReliabilityGenerationFixture } from './meal-reliability.mjs'
import { mockGeneration, runHandler } from './plan-identity.mjs'
import { assertDemandDelivery } from './demand-delivery-contract.mjs'

const mode = process.argv[2]
assert.ok(['before', 'after'].includes(mode))
Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only', ENABLE_LOCAL_FALLBACK_REFILL: 'false' })
const { finalizePlanText } = await import('../../../api/_lib/trip-plan-text-consistency.ts')
let handlerSourceSha256
async function implementation(file) {
  const sourceUrl = new URL(`../../../api/${file}`, import.meta.url)
  const source = mode === 'before' ? execFileSync('git', ['show', `19a538d:api/${file}`], { encoding: 'utf8' }) : readFileSync(sourceUrl, 'utf8')
  if (file === 'generate-trip.ts') handlerSourceSha256 = createHash('sha256').update(source).digest('hex')
  const js = stripTypeScriptTypes(source).replace(/from (['"])([^'"]+)\1/g, (_m, quote, specifier) => {
    const url = specifier.startsWith('.') ? new URL(specifier.replace(/\.js$/, '.ts'), sourceUrl).href : import.meta.resolve(specifier)
    return `from ${quote}${url}${quote}`
  })
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const api = await implementation('generate-trip.ts'), details = await implementation('generate-trip-details.ts')
const deny = () => { throw Error('Unmocked network forbidden') }
function guard() {
  for (const key of ['info', 'warn', 'error', 'debug', 'log']) mock.method(console, key, () => {})
  mock.method(globalThis, 'fetch', deny)
  mock.method(http, 'request', deny); mock.method(net, 'connect', deny)
  mock.method(net, 'createConnection', deny); mock.method(tls, 'connect', deny)
}
function record() {
  const request = https.request, fetch = globalThis.fetch, calls = []
  mock.method(https, 'request', (url, options, callback) => {
    assert.ok(['routes.googleapis.com', 'places.googleapis.com', 'unit-test.supabase.co'].includes(new URL(url).hostname))
    const entry = { url: String(url), options, body: '' }; calls.push(entry)
    const req = request(url, options, callback), write = req.write
    req.write = value => { entry.body += value; return write.call(req, value) }
    return req
  })
  mock.method(globalThis, 'fetch', (url, init) => { calls.push({ url: String(url), init }); return fetch(url, init) })
  return calls
}
const rows = []
for (const style of ['safe', 'balanced', 'explore']) for (const kind of ['grounding', 'repair', 'fallback', 'duration', 'unreferenced',
  'fallback-removed', 'art-description', 'region-description', 'short-reference']) {
  guard(); mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  const f = foodPurposeFixture(kind.startsWith('fallback') ? 'costly-meal' : kind === 'repair' ? 'closed-original' : 'same-coffee', style, kind)
  if (!kind.startsWith('fallback')) {
    f.food.name = kind === 'art-description' ? '藝術館' : kind === 'region-description' ? '新港咖啡館' : '眷鳥咖啡商行'
    f.alt.name = kind === 'art-description' ? '地方文物館' : '草圖咖啡'
    f.alt.types = ['cafe']; f.alt.foodSubtype = 'cafe'
    if (kind === 'art-description') {
      f.input.tags = ['no_full_meals']
      for (const c of [f.food, f.alt]) Object.assign(c, { type: 'main_activity', role: 'main_activity', types: ['museum'], foodSubtype: undefined })
    }
    if (kind === 'region-description') for (const c of [f.food, f.alt]) c.address = '嘉義縣新港鄉中山路1號'
    for (const s of f.plan.stops) if (s.id === f.food.id) Object.assign(s, { name: f.food.name, address: f.food.address, type: f.food.type })
    for (const c of [f.food, f.alt]) Object.assign(f.placeOverrides[c.placeId], { displayName: { text: c.name }, types: c.types, formattedAddress: c.address })
  }
  if (kind === 'grounding') {
    // A real identity replacement, not an alias correction at the same placeId.
    f.plan.stops[1].address = f.alt.address
    f.candidates.allCandidates = f.candidates.allCandidates.filter(c => c.placeId !== f.food.placeId)
    f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  }
  if (kind === 'duration') { f.crossUsed.clear(); f.plan.stops[0].duration += 5 }
  f.plan.title = ['unreferenced', 'art-description', 'region-description', 'short-reference'].includes(kind) ? '城市走走' : `${f.food.name}小旅行`
  f.plan.subtitle = '按照自己的步調走走'
  f.plan.summary = {
    unreferenced: '沿途看看街景。', fallback: `到${f.food.name}用餐。`,
    'fallback-removed': `到「${f.alt.name}」用餐。`, 'art-description': '欣賞藝術館藏。',
    'region-description': '在新港喝咖啡，再沿途散步。', 'short-reference': '在眷鳥喝咖啡，再沿途散步。',
  }[kind] ?? '在眷鳥咖啡商行喝咖啡，再沿途散步。'
  mockMatrix({ mock }, f)
  const calls = record(), source = structuredClone(f.plan)
  const grounded = api.applyCandidateGroundingToPlan(f.plan, f.candidates)
  const result = await api.repairAndValidatePlanForDelivery(grounded, f.input, f.candidates, new Set(), 'text-replay', f.crossUsed)
  assert.ok(result.plan, `${kind}/${style}`)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(f.plan, source)
  const plan = mode === 'after' ? finalizePlanText(result.plan) : result.plan
  rows.push({ kind, style, plan, calls })
  mock.restoreAll(); mock.timers.reset()
}

async function generationReplay(general = false) {
guard()
const f = mealReliabilityGenerationFixture('sketch-safe')
// Preserve the original culture+coffee scenario, plus the general control whose
// text should still change only when it references a replaced identity.
if (general) { f.input.category = 'explore'; f.input.customCategory = '' }
const cafe = f.candidates.allCandidates.find(c => c.type === 'food')
cafe.name = '草圖咖啡'
for (const p of f.plans) {
  p.stops.find(s => s.type === 'food').name = '眷鳥咖啡商行'
  p.stops.find(s => s.type === 'food').placeId = 'retired-bird-cafe'
  p.title = p.type === 'safe' ? '眷鳥咖啡商行小旅行' : '城市走走'
  p.subtitle = p.type === 'explore' ? '到眷鳥咖啡商行休息' : '沿途看看風景'
  p.summary = p.type === 'safe' ? '在眷鳥咖啡商行喝咖啡，再沿途散步。' : p.type === 'balanced' ? '在草圖咖啡休息，再沿途走走。' : '沿途看看街景。'
}
f.aiPlans = structuredClone(f.plans)
mockGeneration({ mock }, f, f.aiPlans)
const generationCalls = record(), generation = await runHandler(api.default, f)
assert.equal(generation.statusCode, 200)
assert.ok(generation.response)
if (mode === 'after') await assertDemandDelivery(generation, f)
mock.restoreAll(); mock.timers.reset()
return { generation, generationCalls, input: f.input }
}
const mixed = await generationReplay(), general = await generationReplay(true)

const detailRows = []
for (const kind of ['merged-main', 'removed-rain']) {
  guard()
  const d = mealReliabilityGenerationFixture('sketch-safe')
  mockGeneration({ mock }, d, d.aiPlans)
  const plan = structuredClone(d.plans[0])
  const rain = { ...plan.stops.find(s => s.type === 'food'), id: 'rain-old', placeId: 'unavailable-rain', name: '眷鳥咖啡商行' }
  plan.summary = kind === 'removed-rain' ? '雨天到眷鳥咖啡商行休息。' : '沿途看看街景。'
  mock.method(globalThis, 'fetch', async url => {
    if (mode === 'after' && String(url) === 'https://unit-test.supabase.co/auth/v1/user') {
      return Response.json({ id: 'fixture-user', role: 'authenticated' })
    }
    assert.equal(String(url), 'https://api.openai.com/v1/responses')
    return new Response(JSON.stringify({ output_text: JSON.stringify({ plan: {
      stops: plan.stops.map(s => ({ id: s.id, description: '補充細節' })),
      rainBackup: kind === 'removed-rain' ? [rain] : [], rainTransportSegments: [],
    } }) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const calls = record(), response = { statusCode: 200, body: null }
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url')}.fixture`
  await details.default({ method: 'POST', body: { input: d.input, plan }, headers: { authorization: `Bearer ${token}` } }, {
    status(code) { response.statusCode = code; return this }, setHeader() {}, json(body) { response.body = body },
  })
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.ok(response.body.plan)
  detailRows.push({ kind, plan: response.body.plan, calls })
  mock.restoreAll(); mock.timers.reset()
}
process.stdout.write(JSON.stringify({ rows, ...mixed, general, detailRows, handlerSourceSha256 }))
