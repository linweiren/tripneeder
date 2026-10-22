import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { intentCases, intentGroundingFixture } from './intent-candidate-grounding.mjs'
import { mockGeneration, runHandler } from './plan-identity.mjs'

const mode = process.argv[2]
assert.ok(['before', 'after', 'projection-before'].includes(mode))
Object.assign(process.env, { GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only',
  NODE_ENV: 'production', ENABLE_LOCAL_FALLBACK_REFILL: 'false' })
let handler
if (mode === 'before' || mode === 'projection-before') {
  const file = new URL('../../../api/generate-trip.ts', import.meta.url)
  const ref = mode === 'before' ? 'fedd41fc' : '342847c'
  const source = execFileSync('git', ['show', `${ref}:api/generate-trip.ts`], { encoding: 'utf8' })
  let projectionUrl
  if (mode === 'projection-before') {
    const projectionFile = new URL('../../../api/_lib/trip-intent-candidate-grounding.ts', import.meta.url)
    const original = execFileSync('git', ['show', `${ref}:api/_lib/trip-intent-candidate-grounding.ts`], { encoding: 'utf8' })
    const projection = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_m, q, s) =>
      `from ${q}${new URL(s.replace(/\.js$/, '.ts'), projectionFile).href}${q}`)
    projectionUrl = `data:text/javascript;base64,${Buffer.from(projection).toString('base64')}`
  }
  const js = stripTypeScriptTypes(source).replace(/from (['"])([^'"]+)\1/g, (_m, q, s) =>
    `from ${q}${projectionUrl && s === './_lib/trip-intent-candidate-grounding.js' ? projectionUrl
      : s.startsWith('.') ? new URL(s.replace(/\.js$/, '.ts'), file).href : import.meta.resolve(s)}${q}`)
  handler = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).default
} else handler = (await import('../../../api/generate-trip.ts')).default
const rows = []
for (const kind of intentCases) {
  const deny = () => { throw Error('Unmocked network forbidden') }
  for (const key of ['info', 'warn', 'error', 'log', 'debug']) mock.method(console, key, () => {})
  mock.method(globalThis, 'fetch', deny)
  mock.method(http, 'request', deny); mock.method(net, 'connect', deny)
  mock.method(net, 'createConnection', deny); mock.method(tls, 'connect', deny)
  const f = intentGroundingFixture(kind)
  mockGeneration({ mock }, f, f.aiPlans, undefined, f.mockOptions)
  const request = https.request, fetch = globalThis.fetch, calls = []
  mock.method(https, 'request', (url, options, callback) => {
    const target = new URL(url)
    assert.ok(['routes.googleapis.com', 'places.googleapis.com', 'unit-test.supabase.co'].includes(target.hostname))
    const entry = { url: String(url), options, body: '' }; calls.push(entry)
    const req = request(url, options, res => {
      // Controlled closed-culture response; no actual Places request occurs.
      if (target.hostname === 'places.googleapis.com') {
        const emit = res.emit
        res.emit = function (event, value, ...args) {
          if (event === 'data') {
            const payload = JSON.parse(value)
            value = Buffer.from(JSON.stringify(payload.places ? { ...payload, places: payload.places.map(f.transformPlace) } : f.transformPlace(payload)))
          }
          return emit.call(this, event, value, ...args)
        }
      }
      callback(res)
    })
    const write = req.write
    req.write = value => { entry.body += value; return write.call(req, value) }
    return req
  })
  mock.method(globalThis, 'fetch', (url, init) => { calls.push({ url: String(url), init }); return fetch(url, init) })
  const result = await runHandler(handler, f)
  assert.equal(result.statusCode, 200, kind)
  assert.ok(result.response?.plans.length, `${kind}: complete final response`)
  rows.push({ kind, result, calls })
  mock.restoreAll(); mock.timers.reset()
}
process.stdout.write(JSON.stringify(rows))
