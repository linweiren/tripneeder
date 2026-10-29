import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createGenerationPreviewProjector, projectGenerationPreview, readGenerationPreview, upsertGenerationPreview } from '../../src/services/ai/generationPreview.ts'
import { ProxyTripPlanner } from '../../src/services/ai/proxyTripPlanner.ts'

const input = { location: { name: '固定起點' }, startTime: '10:00', endTime: '15:00', tags: [] }
const draft = { type: 'balanced', title: 'SECRET_FULL_TITLE', stops: [
  { name: '九番埤濕地公園', placeId: 'SECRET_ID', address: 'SECRET_ADDRESS', lat: 22, lng: 120, duration: 50, type: 'main_activity', googleTypes: ['park'] },
  { name: '城裡的小月光', type: 'food', duration: 40, foodSubtype: 'cafe' },
] }

test('safe progress derives activity hints and a bounded venue sample without route or timing data', () => {
  const preview = projectGenerationPreview(draft)
  assert.deepEqual(preview, { type: 'balanced', stopCount: 2, highlights: ['戶外活動', '咖啡停留'], sampleVenueNames: [] })
  assert.doesNotMatch(JSON.stringify(preview), /SECRET|stops|placeId|address|duration|title|lat|lng/)
  const one = projectGenerationPreview({ ...draft, stops: draft.stops.slice(0, 1) })
  assert.doesNotMatch(JSON.stringify(one), /SECRET/)
  assert.deepEqual(createGenerationPreviewProjector()(draft).sampleVenueNames, ['九番埤濕地公園'])
  assert.deepEqual(createGenerationPreviewProjector()({ ...draft, stops: draft.stops.slice(0, 1) }).sampleVenueNames, [])
})

test('proxy emits partial previews before done and never passes full draft fields through the preview callback', async t => {
  let finish; const gate = new Promise(resolve => { finish = resolve })
  let observed; const firstPreview = new Promise(resolve => { observed = resolve })
  const paid = { plans: [{ id: 'balanced', type: 'balanced', stops: [] }] }
  const safePreview = createGenerationPreviewProjector()(draft)
  const stream = new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ event: 'progress', style: 'balanced', stage: 'validating',
      preview: { ...safePreview, stops: draft.stops, title: draft.title } }) + '\n'))
    await gate
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ event: 'done', response: paid }) + '\n')); controller.close()
  } })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }))
  let fullDelivered = false
  const result = new ProxyTripPlanner().generateTripPlans({ generationId: '11111111-1111-4111-8111-111111111111', input,
    onPreview: value => observed(value), onPlan: () => { fullDelivered = true } })
  const preview = await firstPreview
  assert.equal(fullDelivered, false)
  assert.deepEqual(preview, safePreview)
  assert.doesNotMatch(JSON.stringify(preview), /SECRET/)
  finish(); assert.deepEqual(await result, paid)
})

test('style-bound updates do not share preview data or expose arbitrary provider text', () => {
  const a = projectGenerationPreview(draft), b = { type: 'explore', stopCount: 3, highlights: ['文化場館'], sampleVenueNames: [] }
  const values = upsertGenerationPreview(upsertGenerationPreview([], a), b)
  assert.deepEqual(values.find(value => value.type === 'balanced'), a)
  assert.deepEqual(values.find(value => value.type === 'explore'), b)
  assert.deepEqual(readGenerationPreview({ ...a, highlights: ['SECRET_FULL_ROUTE', '咖啡停留'], response: draft }), { ...a, highlights: ['咖啡停留'] })
})

test('actual preview component renders progressive facts and point-based state, with no payment-unlock copy', () => {
  const source = fs.readFileSync('src/components/GenerationPreviewContent.tsx', 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mod = { exports: {} }, require = createRequire(new URL('../../src/components/GenerationPreviewContent.tsx', import.meta.url))
  // The suite's .js -> .ts hook is ESM-only; bridge this actual ESM export into
  // the isolated TSX CommonJS render without mocking its projection behavior.
  const requireComponent = specifier => specifier === '../services/ai/generationPreview.js' ? { readGenerationPreview } : require(specifier)
  new Function('require', 'exports', output)(requireComponent, mod.exports)
  const html = renderToStaticMarkup(createElement(mod.exports.GenerationPreviewContent, { preview: createGenerationPreviewProjector()(draft) }))
  assert.match(html, /2 個停留點/); assert.match(html, /戶外活動.*咖啡停留/); assert.match(html, /20 點/)
  assert.match(html, /已找到的部分景點：九番埤濕地公園/)
  assert.doesNotMatch(html, /城裡的小月光/)
  assert.doesNotMatch(html, /付款|解鎖|SECRET/)
})

test('all styles and revisions together reveal only one stable sample; separate requests are isolated', () => {
  const project = createGenerationPreviewProjector()
  const previews = [project(draft)]
  for (const type of ['safe', 'balanced', 'explore']) {
    previews.push(project({ ...draft, type, stops: [...draft.stops].reverse() }))
    previews.push(project({ ...draft, type, stops: draft.stops.map((stop, i) => ({ ...stop, name: `新版景點${i}` })) }))
  }
  assert.deepEqual([...new Set(previews.flatMap(p => p.sampleVenueNames))], ['九番埤濕地公園'])
  assert.deepEqual(previews.at(-1).sampleVenueNames, [], 'a removed sample must not appear in another style/revision')
  assert.deepEqual(createGenerationPreviewProjector()({ ...draft, stops: draft.stops.map((stop, i) => ({ ...stop, name: `新版景點${i}` })) }).sampleVenueNames, ['新版景點0'])
})

test('preview reader rejects malformed names and strips route fields, while supporting old progress events', () => {
  const safe = projectGenerationPreview(draft)
  assert.deepEqual(readGenerationPreview({ ...safe, sampleVenueNames: ['<script>', '\nroute', 'x'.repeat(81), '已確認景點', '第二景點'], stops: draft.stops }),
    { ...safe, sampleVenueNames: ['已確認景點'] })
  assert.deepEqual(readGenerationPreview({ type: 'safe', stopCount: 1, highlights: [], sampleVenueNames: ['唯一地點'] }).sampleVenueNames, [])
  assert.deepEqual(readGenerationPreview({ type: 'safe', stopCount: 2, highlights: [] }).sampleVenueNames, [])
})
