// All network boundaries are mocked by the tracked generation fixture. This is a
// fresh process per mode so Places/Routes caches and fixture IDs start identically.
import { mock } from 'node:test'
import https from 'node:https'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync } from 'node:child_process'
import { styleGenerationFixture } from './style-generation.mjs'
import { mockGeneration, runHandler } from './plan-identity.mjs'

const mode = process.argv[2]
const scenario = process.argv[3] ?? 'positioning'
if (!['baseline', 'off', 'on'].includes(mode)) throw new Error('Expected baseline/off/on replay mode')
Object.assign(process.env, { GOOGLE_PLACES_API_KEY: 'unit-test-only', OPENAI_API_KEY: 'unit-test-only',
  SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'unit-test-only',
  NODE_ENV: 'development', ENABLE_LOCAL_FALLBACK_REFILL: 'false',
  TRIP_CANDIDATE_DEBUG: mode === 'on' ? 'true' : 'false' })
mock.method(console, 'info', () => {})
mock.method(console, 'warn', () => {})
mock.method(console, 'error', () => {})
mock.method(console, 'log', () => {})
mock.method(console, 'debug', () => {})
let reports = 0, reportBytes = 0, snapshots = 0, phases = [], reportBuildMs = 0
mock.method(fs, 'appendFileSync', (_path, value) => {
  const data = JSON.parse(value)
  if (data.event !== 'trip-candidate-debug-report') return
  reports++
  reportBytes += Buffer.byteLength(value)
  snapshots = data.report.qualityDiagnostics.stages.length
  phases = data.report.qualityDiagnostics.transitions.map(stage => stage.phase)
})
mock.method(fs, 'mkdirSync', () => undefined)
mock.method(fs, 'writeFileSync', (_path, value) => {
  const data = JSON.parse(value)
  if (!_path.endsWith('diagnostics.json')) return
  reports++
  reportBytes += Buffer.byteLength(value)
  snapshots = data.data.qualityDiagnostics.stages.length
  phases = data.data.qualityDiagnostics.transitions.map(stage => stage.phase)
})
syncBuiltinESMExports()
const { TripCandidateDebugSession } = await import('../../../api/_lib/trip-candidate-debug.ts')
const originalBuild = TripCandidateDebugSession.prototype.buildReport
mock.method(TripCandidateDebugSession.prototype, 'buildReport', function (...args) {
  const start = performance.now()
  const result = originalBuild.apply(this, args)
  reportBuildMs += performance.now() - start
  return result
})
const f = styleGenerationFixture(scenario === 'tail' ? 'positioning' : scenario)
if (scenario === 'tail') f.mockOptions.streamTail = true
f.input.category = 'other'
f.input.customCategory = '文化景點＋咖啡廳'
const calls = mockGeneration({ mock }, f, f.aiPlans, undefined, f.mockOptions)
let places = 0
const mockedRequest = https.request
mock.method(https, 'request', function (url, ...args) {
  if (new URL(url).hostname === 'places.googleapis.com') places++
  return mockedRequest.call(this, url, ...args)
})
let handler
if (mode === 'baseline') {
  // Read-only baseline from the task's recorded HEAD; never check out or edit it.
  const source = execFileSync('git', ['show', '825d0825:api/generate-trip.ts'], { encoding: 'utf8' })
  const { stripTypeScriptTypes } = await import('node:module')
  const resolved = source.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/generate-trip.ts', import.meta.url)).href
      : import.meta.resolve(specifier)
    return `from ${quote}${url}${quote}`
  })
  handler = (await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolved)).toString('base64')}`)).default
} else handler = (await import('../../../api/generate-trip.ts')).default
const start = performance.now()
const result = await runHandler(handler, f)
const output = { response: result.response, events: result.events, calls: { ai: calls.ai.length,
  places, routes: calls.routes.length, points: calls.points }, reports, reportBytes, snapshots, phases,
  reportBuildMs, elapsedMs: performance.now() - start }
mock.restoreAll()
process.stdout.write(JSON.stringify(output))
