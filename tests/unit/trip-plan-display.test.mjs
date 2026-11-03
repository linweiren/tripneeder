import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as display from '../../src/utils/tripPlanDisplay.ts'
import * as identity from '../../src/services/ai/tripPlanIdentity.ts'
import * as storage from '../../src/utils/tripPlanStorage.ts'
import * as timing from '../../src/utils/tripTiming.ts'
import * as detailIdentity from '../../src/utils/detailIdentity.ts'
import { readGenerationPreview } from '../../src/services/ai/generationPreview.ts'

const shareRenderCalls = []

// Render the actual TSX with only browser/context boundaries replaced. No API,
// database, generation, or payment calls are made by these display regressions.
function loadComponent(path, mocks = {}, privateExports = []) {
  const source = fs.readFileSync(path, 'utf8') + (privateExports.length ? `
export { ${privateExports.join(', ')} }` : '')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const require = createRequire(new URL(`../../${path}`, import.meta.url))
  const exports = {}
  new Function('require', 'exports', output)(specifier => {
    const boundary = specifier === './community/ShareTripButton' ? '../components/community/ShareTripButton' : specifier
    if (Object.hasOwn(mocks, boundary)) return mocks[boundary]
    if (specifier.includes('/assets/')) return 'test-asset'
    return require(specifier)
  }, exports)
  return exports
}

const { GenerationPreviewContent } = loadComponent('src/components/GenerationPreviewContent.tsx', {
  '../services/ai/generationPreview.js': { readGenerationPreview },
})

const oldNames = /保守(?:型)?方案|平衡(?:型)?方案|探索(?:型)?方案|\b(?:Safe|Balanced|Explore)\b/i
const subsets = [
  ['safe', 'balanced', 'explore'], ['safe', 'balanced'], ['safe', 'explore'],
  ['balanced', 'explore'], ['safe'], ['balanced'], ['explore'],
]
const planFor = type => ({
  id: `legacy-${type}`, type, title: identity.getTripPlanStyleLabel(type),
  summary: '原有行程摘要', budget: 700, transportMode: 'scooter', totalTime: 60,
  stops: [], transportSegments: [], isDetailComplete: true,
})

function mocksFor(plans, session = { status: 'success' }, detailSource, search = '') {
  return {
    'react-router-dom': {
      useNavigate: () => () => {}, useParams: () => ({ planId: plans.at(-1)?.id }),
      useLocation: () => ({ state: detailSource ? { from: detailSource } : null, search }),
      Link: ({ children }) => createElement('span', null, children), Navigate: () => null,
    },
    '../contexts/analysisSession': { useAnalysisSession: () => ({ session, planDetailStates: {} }) },
    '../contexts/auth': { useAuth: () => ({ user: null }) },
    '../contexts/dialog': { useDialog: () => ({}) },
    '../utils/tripPlanStorage': {
      ...storage, loadGeneratedPlans: () => [...plans], loadLastTripInput: () => null,
      loadPlanForDetail: () => plans.at(-1), loadInputForDetail: () => null,
    },
    '../utils/tripPlanDisplay': display,
    '../utils/detailIdentity': detailIdentity,
    '../components/CurrentWeatherDashboard': { __esModule: true, default: () => null },
    '../components/WeatherCard': { __esModule: true, default: () => createElement('aside', { 'data-weather': 'retained' }) },
    '../components/community/ShareTripButton': { ShareTripButton: props => {
      shareRenderCalls.push(props)
      return createElement('button', { 'data-share': 'retained' }, '分享行程')
    } },
    '../components/community/SharedTripDiscussion': { SharedTripDiscussion: () => createElement('section', { 'data-discussion': 'retained' }) },
    '../services/community/communityService': {},
    '../utils/tripTiming': timing,
    '../services/ai/tripPlanIdentity': identity,
    '../services/auth/supabaseClient': {},
    '../services/auth/reverseGeocode': {},
    '../services/points/pointsService': { getCachedUserProfile: () => null },
    '../services/tripRecords/tripRecordService': {},
    '../services/personalization/personalizationEventsService': {},
    '../utils/loginPrompt': {},
    '../components/ui/AppSelect': {},
    '../components/GenerationPreviewContent': { GenerationPreviewContent },
  }
}

for (const types of subsets) {
  test(`actual preview and results number visible ${types.join('/')} plans without gaps`, () => {
    const plans = types.map(planFor)
    const original = structuredClone(plans)
    // Simulate out-of-order progress, legacy route IDs, and restored snapshots.
    const previews = types.map((type, i) => ({ type, stopCount: i + 2,
      highlights: ['戶外活動'], sampleVenueNames: [] }))
    const { HomePage } = loadComponent('src/pages/HomePage.tsx', mocksFor(plans, {
      status: 'analyzing', progressStyles: [...types].reverse(), previews: [...previews].reverse(),
    }))
    const previewHtml = renderToStaticMarkup(createElement(HomePage))
    const readyCards = [...previewHtml.matchAll(/<li class="analysis-plan-card is-ready">(.*?)<\/li>/g)].map(match => match[1])
    assert.equal(readyCards.length, types.length)
    const { ResultsPage } = loadComponent('src/pages/ResultsPage.tsx', mocksFor([...plans].reverse(), {
      status: 'success', warnings: ['探索方案與保守方案的實際路線與活動安排沒有足夠差異，本次合併顯示。'],
    }))
    const html = renderToStaticMarkup(createElement(ResultsPage))
    const labels = [...html.matchAll(/<p class="plan-type">(.*?)<\/p>/g)].map(match => match[1])
    assert.deepEqual(labels, ['方案一', '方案二', '方案三'].slice(0, types.length))
    for (const [i, card] of readyCards.entries()) {
      assert.ok(card.includes(`>${labels[i]}</span>`))
      assert.ok(card.includes(`${previews[i].stopCount} 個停留點`), 'preview stays attached to its own strategy')
    }
    assert.doesNotMatch(previewHtml, oldNames)
    assert.doesNotMatch(html, oldNames)
    assert.deepEqual(plans, original, 'display does not rewrite strategy IDs, titles, budgets or stops')
  })
}

test('result-to-detail and saved-record views hide exact legacy fallback names, retaining authored titles', () => {
  const plans = ['balanced', 'explore'].map(planFor)
  const { DetailPage } = loadComponent('src/pages/DetailPage.tsx', mocksFor(plans))
  const detail = renderToStaticMarkup(createElement(DetailPage))
  assert.match(detail, /<h1 class="page-title">方案二<\/h1>/)
  assert.doesNotMatch(detail, oldNames)
  const { DetailPage: StoredDetail } = loadComponent('src/pages/DetailPage.tsx', mocksFor(plans, {}, 'recent'))
  const savedDetail = renderToStaticMarkup(createElement(StoredDetail))
  assert.match(savedDetail, /<h1 class="page-title">方案一<\/h1>/)
  assert.doesNotMatch(savedDetail, oldNames)
  const { TripRecordList } = loadComponent('src/components/TripRecordList.tsx', mocksFor(plans))
  const records = [{ id: 'record', plan: plans[1], input: null, createdAt: '2026-10-30T00:00:00Z' }]
  const history = renderToStaticMarkup(createElement(TripRecordList, { records, source: 'recent' }))
  assert.match(history, /<h2>方案一<\/h2>/)
  assert.doesNotMatch(history, oldNames)
  for (const title of ['公園與咖啡小旅行', 'Explore 高雄', '平衡方案的日常散步']) {
    assert.equal(display.getTripPlanDisplayTitle(title, '方案二'), title)
  }
})

test('warning display uses surviving positions without assigning numbers to missing strategies', () => {
  const plans = ['balanced', 'explore'].map(planFor)
  assert.equal(display.getTripPlanDisplayWarning('平衡方案、Explore：原有提醒。', plans), '方案一、方案二：原有提醒。')
  assert.equal(display.getTripPlanDisplayWarning('Safe 與平衡型方案合併顯示。', plans), '其他方案 與方案一合併顯示。')
  assert.equal(display.getTripPlanDisplayWarning('目前僅 2 個風格方案通過驗收；未能提供的風格：保守方案。', plans), '目前僅 2 個方案通過驗收。')
  assert.equal(display.getTripPlanDisplayWarning('部分交通仍為估算。', plans), '部分交通仍為估算。')
  assert.deepEqual(identity.TRIP_PLAN_TYPES, ['safe', 'balanced', 'explore'])
  assert.deepEqual(identity.normalizeTripPlanIdentities([...plans].reverse()).map(plan => plan.type), ['balanced', 'explore'])
})


test('result rendering retains share inputs and budget estimates while preserving original trip data', () => {
  const plans = ['balanced', 'explore'].map(planFor)
  plans[0].budgetEstimateNote = '預算估算說明仍保留'
  const before = structuredClone(plans)
  const input = { startTime: '10:00', endTime: '15:00', tags: [], location: { name: '臺北市' } }
  const mocks = mocksFor(plans)
  mocks['../utils/tripPlanStorage'].loadLastTripInput = () => input
  shareRenderCalls.length = 0
  const { ResultsPage } = loadComponent('src/pages/ResultsPage.tsx', mocks)
  const html = renderToStaticMarkup(createElement(ResultsPage))
  assert.match(html, /預算估算說明仍保留/)
  assert.equal(shareRenderCalls.length, 2)
  assert.deepEqual(shareRenderCalls.map(call => call.plan), before)
  assert.ok(shareRenderCalls.every(call => call.input === input))
  assert.deepEqual(plans, before)
})

test('shared detail uses the confirmed single-trip label despite an unrelated generated-list position', () => {
  const plans = ['balanced', 'explore'].map(planFor)
  const before = structuredClone(plans)
  const { DetailPage } = loadComponent('src/pages/DetailPage.tsx', mocksFor(plans, {}, 'community', '?source=community&shareId=share-isolated'))
  const html = renderToStaticMarkup(createElement(DetailPage))
  assert.match(html, /<h1 class="page-title">方案一<\/h1>/)
  assert.match(html, /data-weather="retained"/)
  assert.match(html, /data-discussion="retained"/)
  assert.deepEqual(plans, before)
})

test('public and own sharing cards normalize only pure legacy titles and retain authored titles', () => {
  const mocks = mocksFor([])
  const { SharedTripCard, MySharedTripCard } = loadComponent('src/pages/CommunityPage.tsx', mocks, ['SharedTripCard', 'MySharedTripCard'])
  for (const Component of [SharedTripCard, MySharedTripCard]) {
    for (const [title, expected] of [['Balanced', '方案一'], ['平衡型方案', '方案一'], ['Explore 高雄', 'Explore 高雄'], ['公園與咖啡小旅行', '公園與咖啡小旅行']]) {
      const trip = { id: 'share', plan: planFor('balanced'), tags: [], created_at: '2026-11-03', author_display_name: '旅人', like_count: 2, comment_count: 3, view_count: 4 }
      trip.plan.title = title
      const before = structuredClone(trip)
      const html = renderToStaticMarkup(createElement(Component, { trip, onOpen() {}, onUnshare() {}, onLike() {}, pending: false }))
      assert.ok(html.includes('<h2>' + expected + '</h2>'))
      assert.deepEqual(trip, before)
    }
  }
})
