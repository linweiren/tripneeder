import test from 'node:test'
import assert from 'node:assert/strict'
import { areDeliveryChoicesEquivalent, finalizeDeliveryChoices } from '../../api/_lib/trip-delivery-coherence.ts'
import { identityFixture } from './fixtures/plan-identity.mjs'
import { applyCandidateGroundingToPlan } from '../../api/generate-trip.ts'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as identity from '../../src/services/ai/tripPlanIdentity.ts'
import * as timing from '../../src/utils/tripTiming.ts'

const input = { location: { name: '固定起點' }, tags: [], startTime: '18:00', endTime: '20:00', people: 2 }
const stop = (name, placeId, type, duration) => ({ id: placeId, name, placeId, type, duration, address: '固定地址', description: '' })
const route = type => ({ id: type, type, title: type === 'balanced' ? '蓮池潭浪漫夜景' : '仁武多元夜間體驗',
  subtitle: '', summary: '', budget: type === 'balanced' ? 800 : 600, totalTime: 95, transportMode: 'scooter',
  stops: [stop('九番埤濕地公園', 'park', 'main_activity', 50), stop('城裡的小月光－大中店', 'cafe', 'food', 40)],
  transportSegments: [{ fromStopId: 'park', toStopId: 'cafe', mode: 'scooter', duration: 5, label: '' }], rainBackup: [], rainTransportSegments: [] })

test('reported Balanced/Explore route, order and time collapse honestly after all repairs', () => {
  const plans = [route('balanced'), route('explore')], frozen = structuredClone(plans)
  const result = finalizeDeliveryChoices(plans, input)
  assert.deepEqual(result.plans.map(plan => plan.type), ['balanced'])
  assert.match(result.warnings.join(' '), /探索方案.*平衡方案.*合併/)
  assert.deepEqual(result.plans[0].stops, frozen[0].stops)
  assert.deepEqual(result.plans[0].transportSegments, frozen[0].transportSegments)
  assert.deepEqual(plans, frozen, 'never mutate the validated input or force worse stops')
})

test('different raw place IDs can converge during actual candidate grounding; the delivery boundary detects it', () => {
  const f = identityFixture()
  const drafts = ['balanced', 'explore'].map((type, index) => ({ ...structuredClone(f.plan), id: type, type,
    stops: f.plan.stops.map(stop => ({ ...stop, placeId: `unverified-${index}-${stop.id}` })) }))
  assert.equal(areDeliveryChoicesEquivalent(...drafts), false)
  const grounded = drafts.map(plan => applyCandidateGroundingToPlan(plan, f.candidates))
  assert.deepEqual(grounded[0].stops.map(stop => stop.placeId), f.plan.stops.map(stop => stop.placeId))
  assert.equal(areDeliveryChoicesEquivalent(...grounded), true)
  const result = finalizeDeliveryChoices(grounded, f.input, drafts)
  assert.deepEqual(result.plans.map(plan => plan.type), ['balanced'])
  assert.match(result.warnings.join(' '), /探索方案.*平衡方案.*合併/)
  assert.deepEqual(result.plans[0].stops, grounded[0].stops)
})

test('titles, budget, stop IDs, prose and minor timing jitter cannot manufacture another choice', () => {
  const a = route('balanced'), b = route('explore')
  b.stops = b.stops.map(stop => ({ ...stop, id: `different-${stop.id}`, duration: stop.duration + 1 }))
  assert.equal(areDeliveryChoicesEquivalent(a, b), true)
  assert.equal(finalizeDeliveryChoices([a, b], input).plans.length, 1)
})

test('same venues with materially different valid activity depths remain actual choices', () => {
  const a = route('balanced'), b = route('explore')
  b.stops = b.stops.map((stop, index) => ({ ...stop, duration: index === 0 ? 20 : 70 }))
  assert.equal(areDeliveryChoicesEquivalent(a, b), false)
  assert.equal(finalizeDeliveryChoices([a, b], input).plans.length, 2)
})

test('start-time differences are real choices only beyond minor jitter, including across midnight', () => {
  const a = route('balanced'), b = route('explore')
  a.scheduleStartTime = '23:45'; b.scheduleStartTime = '00:00'
  assert.equal(areDeliveryChoicesEquivalent(a, b), true)
  b.scheduleStartTime = '00:30'
  assert.equal(areDeliveryChoicesEquivalent(a, b), false)
})

test('same cost conditions use the existing explicit estimate, not unexplained style prices', () => {
  const a = route('balanced'), b = route('explore')
  b.stops = b.stops.map((stop, index) => ({ ...stop, duration: index === 0 ? 20 : 70 }))
  const result = finalizeDeliveryChoices([a, b], input)
  assert.deepEqual(result.plans.map(plan => plan.budget), [470, 470])
  assert.ok(result.plans.every(plan => /350.*120.*非票價或店家報價/.test(plan.budgetEstimateNote)))
  assert.deepEqual(finalizeDeliveryChoices([a, b], { ...input, people: 4 }).plans.map(plan => plan.budget), [940, 940])
})

test('changed final venue/purpose re-estimates from the final stops and preserves the route', () => {
  const original = route('balanced'), changed = structuredClone(original)
  changed.stops[1] = stop('另一個公園', 'park-2', 'main_activity', 40)
  const result = finalizeDeliveryChoices([changed], input, [original]).plans[0]
  assert.equal(result.budget, 300)
  assert.match(result.budgetEstimateNote, /粗估/)
  assert.deepEqual(result.stops, changed.stops)
})

test('unsupported landmark in the final title cannot advertise a missing primary stop', () => {
  const result = finalizeDeliveryChoices([route('balanced')], input).plans[0]
  assert.doesNotMatch(result.title, /蓮池潭/)
  assert.match(result.title, /九番埤濕地公園/)
  const retained = route('balanced'); retained.stops[0].name = '蓮池潭風景區'
  assert.equal(finalizeDeliveryChoices([retained], input).plans[0].title, retained.title)
})

test('different actual venue, order, or transport is not suppressed; style priority is preserved', () => {
  const a = route('balanced'), b = route('explore')
  b.stops[0].placeId = 'another-verified-park'
  assert.equal(finalizeDeliveryChoices([a, b], input).plans.length, 2)
  b.stops = [...a.stops].reverse()
  assert.equal(areDeliveryChoicesEquivalent(a, b), false)
  b.stops = structuredClone(a.stops)
  b.transportMode = 'car'
  assert.equal(areDeliveryChoicesEquivalent(a, b), false)
})

test('actual results page announces and renders exactly the delivered number of choices', () => {
  const source = fs.readFileSync('src/pages/ResultsPage.tsx', 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const require = createRequire(new URL('../../src/pages/ResultsPage.tsx', import.meta.url))
  const allPlans = [route('safe'), route('balanced'), route('explore')]
  for (const count of [1, 2, 3]) {
    const mod = { exports: {} }
    const bridge = specifier => {
      if (specifier === 'react-router-dom') return { useNavigate: () => () => {} }
      if (specifier === '../contexts/analysisSession') return { useAnalysisSession: () => ({
        session: { status: 'success', warnings: count < 3 ? ['重複路線已合併顯示'] : [] },
      }) }
      if (specifier === '../utils/tripPlanStorage') return { loadGeneratedPlans: () => allPlans.slice(0, count) }
      if (specifier === '../utils/tripTiming') return timing
      if (specifier === '../services/ai/tripPlanIdentity') return identity
      if (specifier.endsWith('.webp')) return 'fixture-image.webp'
      return require(specifier)
    }
    new Function('require', 'exports', output)(bridge, mod.exports)
    const html = renderToStaticMarkup(createElement(mod.exports.ResultsPage))
    assert.match(html, new RegExp(`${count} 個專屬方案已為你準備好`))
    assert.equal((html.match(/class="plan-card /g) ?? []).length, count)
    if (count < 3) {
      assert.doesNotMatch(html, /3 個專屬方案/)
      assert.match(html, /重複路線已合併顯示/)
    }
  }
})
