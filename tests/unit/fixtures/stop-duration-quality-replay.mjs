import { mock } from 'node:test'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { durationQualityFixture, mockDurationQuality } from './stop-duration-quality.mjs'

const [mode, kind, style = 'explore'] = process.argv.slice(2)
if (!['baseline', 'current'].includes(mode)) throw Error('Expected baseline or current')
Object.assign(process.env, { NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'unit-test-only' })
const { TripCandidateDebugSession } = await import('../../../api/_lib/trip-candidate-debug.ts')
let api
if (mode === 'baseline') {
  const source = execFileSync('git', ['show', '9840b315:api/generate-trip.ts'], { encoding: 'utf8' })
  const resolved = source.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/generate-trip.ts', import.meta.url)).href
      : import.meta.resolve(specifier)
    return `from ${quote}${url}${quote}`
  })
  api = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolved)).toString('base64')}`)
} else api = await import('../../../api/generate-trip.ts')
const f = durationQualityFixture(kind, style)
const { counts, routeRequests } = mockDurationQuality({ mock }, f)
const debug = new TripCandidateDebugSession(f.input)
debug.recordCandidateSets(f.candidates)
const result = await api.repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates,
  new Set(), 'fixed-duration-replay', f.crossPlanUsed, debug)
if (!result.plan) throw Error(`No delivered plan: ${result.issues}`)
const issues = await api.getDeliveryPlanIssues(result.plan, f.input, 'fixed-duration-final', { candidates: f.candidates })
const quality = debug.buildReport([result.plan]).qualityDiagnostics
const report = { result, issues, counts, routeRequests, quality }
mock.restoreAll()
mock.timers.reset()
process.stdout.write(JSON.stringify(report))
