import { mock } from 'node:test'
import fs from 'node:fs'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { mealReliabilityGenerationFixture } from './meal-reliability.mjs'
import { mockGeneration, runHandler } from './plan-identity.mjs'

const [mode, kind] = process.argv.slice(2)
if (!['off', 'on', 'production'].includes(mode)) throw Error('Expected off/on/production')
Object.assign(process.env, { GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only',
  NODE_ENV: mode === 'production' ? 'production' : 'development', ENABLE_LOCAL_FALLBACK_REFILL: 'false',
  TRIP_CANDIDATE_DEBUG: mode === 'off' ? 'false' : 'true' })
for (const key of ['info', 'warn', 'error', 'log', 'debug']) mock.method(console, key, () => {})
let reports = 0, bytes = 0, quality = null, snapshots = 0, reportBuildMs = 0
mock.method(fs, 'appendFileSync', (_path, value) => {
  const data = JSON.parse(value)
  if (data.event === 'trip-candidate-debug-report') {
    reports++; bytes += Buffer.byteLength(value); quality = data.report.qualityDiagnostics
  }
})
mock.method(fs, 'mkdirSync', () => undefined)
mock.method(fs, 'writeFileSync', (_path, value) => {
  if (!_path.endsWith('diagnostics.json')) return
  const data = JSON.parse(value)
  reports++; bytes += Buffer.byteLength(value); quality = data.data.qualityDiagnostics
})
syncBuiltinESMExports()
const { TripQualityDiagnostics } = await import('../../../api/_lib/trip-quality-diagnostics.ts')
const snapshot = TripQualityDiagnostics.prototype.snapshot
mock.method(TripQualityDiagnostics.prototype, 'snapshot', function (...args) {
  snapshots++; return snapshot.apply(this, args)
})
const { TripCandidateDebugSession } = await import('../../../api/_lib/trip-candidate-debug.ts')
const build = TripCandidateDebugSession.prototype.buildReport
mock.method(TripCandidateDebugSession.prototype, 'buildReport', function (...args) {
  const start = performance.now(), result = build.apply(this, args)
  reportBuildMs += performance.now() - start
  return result
})
const f = mealReliabilityGenerationFixture(kind)
const calls = mockGeneration({ mock }, f, f.aiPlans)
let places = 0
const httpsEndpoints = {}
const request = https.request
mock.method(https, 'request', function (url, ...args) {
  const target = new URL(url), endpoint = `${target.hostname}${target.pathname}`
  httpsEndpoints[endpoint] = (httpsEndpoints[endpoint] ?? 0) + 1
  if (target.hostname === 'places.googleapis.com') places++
  return request.call(this, url, ...args)
})
const handler = (await import('../../../api/generate-trip.ts')).default
const start = performance.now(), result = await runHandler(handler, f)
process.stdout.write(JSON.stringify({ ...result, quality, reports, snapshots, bytes, reportBuildMs,
  elapsedMs: performance.now() - start,
  calls: { ai: calls.ai.length, places, routes: calls.routes.length, points: calls.points, httpsEndpoints } }))
mock.restoreAll()
