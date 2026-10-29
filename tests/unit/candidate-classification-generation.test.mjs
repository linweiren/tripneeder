import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { writeFileSync } from 'node:fs'
import { identityFixture, mockGeneration, runHandler } from './fixtures/plan-identity.mjs'
import { getActivityPurpose } from '../../api/_lib/trip-activity-purpose.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.OPENAI_API_KEY = 'unit-test-only'
process.env.SUPABASE_URL = 'https://unit-test.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
process.env.ENABLE_LOCAL_FALLBACK_REFILL = 'false'
process.env.TRIP_CANDIDATE_DEBUG = 'false'

// generate-trip.ts was unchanged in v1. Load that exact production module in
// memory for an opt-in before/after audit, without editing the working tree.
// Candidate culture rules and all network fixture inputs are identical.
async function loadV1Delivery() {
  const original = execFileSync('git', ['show', 'ff5b32ca:api/generate-trip.ts'],
    { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
  const source = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../api/generate-trip.ts', import.meta.url)).href : import.meta.resolve(specifier)
    return `from ${quote}${url}${quote}`
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const api = process.env.CLASSIFICATION_USE_V1_GROUNDING ? await loadV1Delivery() : await import('../../api/generate-trip.ts')
const observations = []

for (const tags of [[], ['food_first']]) {
  test(`complete mocked generation preserves cultural choices and merges duplicate routes, tags=${tags}`, async t => {
    const f = identityFixture()
    f.input.tags = tags
    const culture = f.candidates.allCandidates[0]
    Object.assign(culture, { name: '金馬賓館當代美術館 ALIEN Art Centre',
      types: ['cultural_center', 'museum', 'art_museum', 'restaurant', 'food'] })
    f.plans.forEach(p => p.stops.forEach(s => {
      if (s.placeId === culture.placeId) s.name = culture.name
    }))
    const calls = mockGeneration(t, f, f.plans)
    t.mock.method(console, 'info', () => {})
    const underlyingMock = https.request
    const placesCalls = { search: 0, details: 0 }
    t.mock.method(https, 'request', (...args) => {
      const target = new URL(args[0])
      if (target.hostname === 'places.googleapis.com') {
        if (target.pathname.endsWith(':searchText')) placesCalls.search++
        else placesCalls.details++
      }
      return underlyingMock(...args)
    })
    const result = await runHandler(api.default, f)
    assert.ok(result.response, JSON.stringify(result.events))
    const finalIssues = []
    for (const plan of result.response.plans) {
      finalIssues.push(await api.getDeliveryPlanIssues(plan, f.input, 'classification-handler-final', { candidates: f.candidates }))
    }
    const row = { tags, delivered: result.response.plans.map(p => ({ style: p.type,
        culture: p.stops.filter(s => s.placeId === culture.placeId).map(s => ({ type: s.type,
          duration: s.duration, purpose: getActivityPurpose(s), candidateRole: s.candidateRole })),
        mealIssues: getRequiredMealCoverageIssues(p, f.input) })), finalIssues,
      calls: { ai: calls.ai.length, routes: calls.routes.length, ...placesCalls }, warnings: result.response.warnings ?? [] }
    observations.push(row)
    t.diagnostic(JSON.stringify(row))
    assert.deepEqual(result.response.plans.map(p => p.type), ['safe', 'balanced'])
    assert.match(result.response.warnings.join(' '), /探索方案.*合併顯示/)
    assert.equal(calls.ai.length, 1, 'no AI refill needed')
    assert.deepEqual(placesCalls, { search: 12, details: 0 }, 'same fixed request budget as v1')
    assert.equal(calls.routes.length, 8, 'same fixed route request budget as v1')
    assert.ok(!row.warnings.some(w => w.includes('Routes')))
    const initialPrompt = calls.ai[0].messages[0].content
    assert.match(initialPrompt, /name="金馬賓館當代美術館 ALIEN Art Centre"[^\n]*role=main_activity/)
    for (const [i, plan] of result.response.plans.entries()) {
      const stop = plan.stops.find(s => s.placeId === culture.placeId)
      assert.ok(stop, 'scarce cultural alternatives may reuse the verified original')
      assert.equal(stop.type, 'main_activity')
      assert.equal(stop.duration, 90)
      assert.equal(getActivityPurpose(stop), 'culture')
      assert.deepEqual(row.delivered[i].mealIssues, [])
      assert.deepEqual(finalIssues[i], [])
    }
  })
}

test.after(() => {
  if (process.env.CLASSIFICATION_GENERATION_AUDIT_OUTPUT) writeFileSync(process.env.CLASSIFICATION_GENERATION_AUDIT_OUTPUT,
    JSON.stringify({ evidence: 'Actual handler, mocked AI/Places/Routes/Supabase; no live services', observations }, null, 2) + '\n')
})
