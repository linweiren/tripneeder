import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { withAcceptanceEvidence, evidenceAiFetch, recordAiModelText, bindEvidencePlan,
  recordEvidenceDelivery, captureAcceptanceDiagnostics, observeEvidenceCall } from '../../api/_lib/trip-acceptance-evidence.ts'
import { createSupplementRouteContext, createRepairRouteResolver } from '../../api/_lib/trip-supplement-quality.ts'
import { capturedLinks } from './fixtures/culture-evidence-projection.mjs'
import { assertWorkingTreeHandler } from './fixtures/demand-delivery-contract.mjs'

const checkoutRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const replay = (mode, kind = 'normal') => JSON.parse(execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--import', './tests/unit/register-ts-js-extension-loader.mjs',
    './tests/unit/fixtures/acceptance-evidence-replay.mjs', mode, kind],
  { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 60000 }))
const service = call => {
  const url = new URL(call.url)
  return url.hostname === 'api.openai.com' ? 'ai' : url.hostname === 'maps.googleapis.com' ? 'geocoding'
    : url.hostname === 'routes.googleapis.com' ? 'routes' : url.hostname === 'unit-test.supabase.co' ? 'supabase'
      : url.pathname.endsWith(':searchText') ? 'places_search' : 'places_details'
}
for (const kind of ['normal', 'history-coffee', 'raw-identity', 'retry', 'retry-envelope', 'refill', 'reject-refill', 'parse-failure', 'stream-fallback',
  'fallback', 'geocoding-details', 'usage', 'points-failure', 'route-failure', 'ai-http-failure', 'ai-network-failure',
  'related-history', 'related-retry', 'related-refill']) {
  test(`actual handler and disk: ${kind}, evidence off/on preserve every event and external request`, () => {
    const baseline = replay('baseline', kind), off = replay('off', kind), on = replay('on', kind)
    for (const row of [baseline, off, on]) assertWorkingTreeHandler(row)
    assert.deepEqual(off.result, baseline.result)
    assert.deepEqual(off.calls, baseline.calls)
    assert.deepEqual(on.result, off.result)
    assert.deepEqual(on.calls, off.calls)
    assert.deepEqual(off.bundles, [])
    assert.equal(on.bundles.length, 1)
    const bundle = on.bundles[0], files = bundle.data, manifest = files['manifest.json']
    assert.equal(manifest.checkoutRevision, checkoutRevision)
    assert.ok(Object.values(manifest.sourceSha256).every(sha => /^[a-f0-9]{64}$/.test(sha)))
    assert.equal(bundle.files.length, 6)
    const final = files['final-response.json'].data, attempts = files['ai-attempts.json'].data
    const ledger = files['calls-and-points.json'].data
    const expected = Object.fromEntries([...new Set(on.calls.map(service))].map(kind => [kind, on.calls.filter(c => service(c) === kind).length]))
    assert.deepEqual(Object.fromEntries(Object.entries(ledger.totals).map(([key, row]) => [key, row.sent])), expected)
    assert.equal(ledger.calls.length, on.calls.length)
    assert.ok(ledger.calls.filter(c => c.service !== 'ai').every(c => c.aiAttemptId === null))
    assert.ok(Object.values(ledger.totals).every(row => row.sent === row.succeeded + row.failed))
    assert.doesNotMatch(JSON.stringify(files), /SECRET_|Authorization|Bearer |api_key|access_token|NOT_JSON/)
    assert.ok(!JSON.stringify(files).includes('https://api.openai.com'))
    assert.equal(ledger.points.balanceDelta, 'unknown')
    assert.ok(attempts.attempts.every(a => a.usage === 'unknown' || Object.values(a.usage).every(n => typeof n === 'number')))
    if (on.result.response) {
      assert.equal(manifest.status, kind === 'raw-identity' ? 'incomplete' : 'complete', JSON.stringify(manifest.reasons))
      assert.equal(final.sha256, createHash('sha256').update(JSON.stringify(on.result.response)).digest('hex'))
      assert.deepEqual(final.plans.map(p => p.stops.map(s => [s.id, s.placeId, s.duration])),
        on.result.response.plans.map(p => p.stops.map(s => [s.id, s.placeId, s.duration])))
      assert.equal(attempts.finalVersions.length, on.result.response.plans.length)
      assert.equal(attempts.attempts.flatMap(a => a.plans).filter(p => p.disposition === 'final_selected').length, on.result.response.plans.length)
      assert.equal(ledger.points.outcome, kind === 'points-failure' ? 'rpc_failed' : 'rpc_confirmed')
      assert.equal(ledger.points.requestedCost, 20)
      assert.equal(files['diagnostics.json'].data.qualityDiagnostics.final.length, final.plans.length)
      assert.ok(files['diagnostics.json'].data.qualityDiagnostics.stages.some(s => s.aiVersion?.attempt === (kind === 'parse-failure' ? 2 : 1)))
    } else {
      assert.equal(manifest.status, 'incomplete')
      assert.ok(manifest.reasons.includes('no_done_response'))
      assert.equal(ledger.points.outcome, kind === 'points-failure' ? 'rpc_failed' : 'not_attempted')
    }
    const prompts = files['prompt-evidence.json'].data
    if (kind.startsWith('related-')) {
      const actualCalls = on.calls.filter(c => service(c) === 'ai')
      assert.deepEqual(prompts.map(p => p.stage), kind === 'related-retry' ? ['initial', 'retry']
        : kind === 'related-refill' ? ['initial', 'refill'] : ['initial'])
      assert.equal(prompts.length, actualCalls.length)
      for (const [i, prompt] of prompts.entries()) {
        const actual = JSON.parse(actualCalls[i].init.body).messages[0].content
        const raw = JSON.parse(actual.match(/CURRENT_INTENT_CANDIDATE_LINKS:\n([^]*?)\nEND_CURRENT_INTENT_CANDIDATE_LINKS/)[1].split('\n').at(-1))
        assert.deepEqual(prompt.links, raw)
        assert.equal(prompt.links.culture_related_unverified.length, 4)
        assert.equal(prompt.sha256, createHash('sha256').update(actual).digest('hex'))
        assert.equal(prompt.linkedIdsExposed, true)
      }
    }
    if (kind === 'normal') {
      assert.ok(prompts[0].linksPresent)
      assert.equal(prompts[0].blockCount, 1)
      assert.ok(prompts[0].linkedIdsExposed)
      assert.ok(prompts[0].links.culture_primary.length)
      const actual = JSON.parse(on.calls.find(c => service(c) === 'ai').init.body).messages[0].content
      assert.equal(prompts[0].sha256, createHash('sha256').update(actual).digest('hex'))
      assert.ok(ledger.cacheHits.places_details > 0)
      assert.ok(ledger.cacheHits.routes >= 0)
    }
    if (kind === 'raw-identity') {
      assert.ok(manifest.reasons.includes('identity_projection_omitted'))
      const raw = attempts.attempts[0].plans
      assert.equal(raw[0].id, 'original-safe-alias')
      assert.equal(final.plans[0].id, 'safe')
      assert.ok(raw.some(p => p.reasons.includes('duplicate_style') && p.disposition !== 'final_selected'))
      assert.ok(raw.some(p => p.reasons.includes('invalid_identity') && p.reasons.includes('invalid_stop') && p.disposition !== 'final_selected'))
    }
    if (kind === 'history-coffee') {
      assert.equal(manifest.history.sampleCount, 15)
      assert.equal(manifest.history.coffeeSignal, true)
      assert.doesNotMatch(JSON.stringify(files), /history-\d|歷史咖啡廳|start_navigation|created_at/)
    }
    if (kind === 'retry') {
      assert.deepEqual(attempts.attempts.map(a => a.stage), ['initial', 'retry'])
      assert.equal(attempts.finalVersions.find(p => p.type === 'safe').attempt, 2)
      assert.ok(attempts.decisions.some(d => d.attemptId === 1 && d.decision === 'validation_rejected'))
    }
    if (kind === 'retry-envelope') {
      const retry = attempts.attempts.find(a => a.stage === 'retry')
      assert.equal(retry.parseStatus, 'failed')
      assert.ok(retry.reasons.includes('invalid_model_envelope'))
      assert.deepEqual(retry.usage, { total_tokens: 123 })
      assert.equal(retry.outcome, 'not_final_selected')
    }
    if (['refill', 'reject-refill'].includes(kind)) {
      assert.deepEqual(attempts.attempts.map(a => a.stage), ['initial', 'refill'])
      if (kind === 'refill') assert.equal(attempts.finalVersions.find(p => p.type === 'balanced').attempt, 2)
      else assert.ok(attempts.attempts[1].plans.every(p => p.disposition !== 'final_selected'))
    }
    if (kind === 'parse-failure') {
      assert.equal(attempts.attempts[0].parseStatus, 'failed')
      assert.ok(attempts.attempts[0].reasons.includes('invalid_json'))
      assert.equal(attempts.attempts[1].stage, 'initial_json_repair')
      assert.ok(attempts.finalVersions.every(p => p.attempt === 2))
    }
    if (kind === 'stream-fallback') {
      assert.equal(attempts.attempts.length, 1)
      assert.equal(attempts.attempts[0].parseStatus, 'failed')
      assert.ok(attempts.attempts[0].reasons.includes('invalid_json'))
      assert.ok(attempts.finalVersions.every(p => p.attempt === 1))
      assert.equal(attempts.attempts[0].plans.filter(p => p.disposition === 'final_selected').length, 3)
    }
    if (kind === 'fallback') {
      assert.ok(files['diagnostics.json'].data.qualityDiagnostics.transitions.some(t => t.phase.startsWith('fallback:')))
      // This comparison computes distinct replacement/original edges; no memo hit.
      assert.equal(ledger.cacheHits.routes, 0)
    }
    if (kind === 'geocoding-details') {
      assert.ok(ledger.totals.geocoding.sent > 0)
      assert.ok(ledger.totals.places_details.sent > 0)
    }
    if (kind === 'usage') assert.deepEqual(attempts.attempts[0].usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
    if (kind.startsWith('ai-')) assert.equal(ledger.totals.ai.failed, 1)
    if (kind === 'route-failure') assert.ok(ledger.totals.routes.failed > 0)
  })
}

test('production hard-off even with flag, and write failure explicitly incomplete without response changes', () => {
  const off = replay('off'), production = replay('production'), failed = replay('writefail')
  assert.deepEqual(production.result, off.result); assert.deepEqual(production.calls, off.calls)
  assert.deepEqual(production.bundles, []); assert.deepEqual(production.logs, [])
  assert.deepEqual(failed.result, off.result); assert.deepEqual(failed.calls, off.calls)
  assert.ok(failed.logs.some(([label, event]) => label === '[acceptance-evidence-incomplete]' && event.status === 'incomplete'))
  assert.ok(failed.bundles.every(bundle => bundle.files.length === 0))
  for (const mode of ['partial-writefail', 'directoryfail']) {
    const other = replay(mode)
    assert.deepEqual(other.result, off.result); assert.deepEqual(other.calls, off.calls)
    assert.ok(other.logs.some(([label]) => label === '[acceptance-evidence-incomplete]'))
    if (mode === 'partial-writefail') {
      assert.equal(other.bundles[0].data['manifest.json'].status, 'incomplete')
      assert.ok(other.bundles[0].data['manifest.json'].reasons.includes('prompt-evidence.json:write_failed'))
    }
  }
})

async function memoryCapture(t, work) {
  const previous = { NODE_ENV: process.env.NODE_ENV, TRIP_CANDIDATE_DEBUG: process.env.TRIP_CANDIDATE_DEBUG }
  Object.assign(process.env, { NODE_ENV: 'development', TRIP_CANDIDATE_DEBUG: 'true' })
  const saved = new Map()
  t.mock.method(fs, 'mkdirSync', () => {})
  t.mock.method(fs, 'writeFileSync', (file, data) => saved.set(file, JSON.parse(data)))
  t.mock.method(console, 'info', () => {}); t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [] }))
  syncBuiltinESMExports()
  const run = fn => withAcceptanceEvidence({ input: { category: 'other', token: 'SECRET_INPUT' } },
    { write() {}, json() {}, end() {}, status() { return this } }, fn)
  try { await work(run); return [...saved.entries()] }
  finally {
    t.mock.restoreAll(); syncBuiltinESMExports()
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
}

test('concurrent request contexts isolate attempt IDs, raw versions, hashes and private fields', async t => {
  const rows = await memoryCapture(t, async run => {
    await Promise.all(['first', 'second'].map(label => run(async () => {
      const response = await evidenceAiFetch('initial', ['safe'], 'https://api.openai.com/v1/chat/completions',
        { body: JSON.stringify({ messages: [{ content: `SECRET_PROMPT_${label}` }] }), headers: { Authorization: 'SECRET_AUTH' } })
      const raw = { id: `alias-${label}`, type: 'safe', stops: [{ id: label, placeId: label, duration: 60 }], token: 'SECRET_MODEL' }
      recordAiModelText(response, JSON.stringify({ plans: [raw], history: 'SECRET_HISTORY' }))
      const plan = { ...raw, id: 'safe' }
      bindEvidencePlan(response, plan)
      await new Promise(resolve => setImmediate(resolve))
      captureAcceptanceDiagnostics({ source: label })
      recordEvidenceDelivery({ event: 'done', response: { plans: [plan], token: 'SECRET_RESPONSE' } })
    })))
  })
  const manifests = rows.filter(([file]) => file.endsWith('manifest.json')).map(([, data]) => data)
  assert.equal(manifests.length, 2)
  assert.equal(new Set(manifests.map(m => m.requestId)).size, 2)
  for (const manifest of manifests) {
    assert.equal(manifest.status, 'complete')
    const files = Object.fromEntries(rows.filter(([, data]) => data.requestId === manifest.requestId).map(([file, data]) => [file.replaceAll('\\', '/').split('/').at(-1), data]))
    assert.equal(files['ai-attempts.json'].data.attempts.length, 1)
    assert.equal(files['calls-and-points.json'].data.totals.ai.sent, 1)
    const label = files['ai-attempts.json'].data.attempts[0].plans[0].id.slice('alias-'.length)
    assert.equal(files['ai-attempts.json'].data.attempts[0].plans[0].id, `alias-${label}`)
    assert.equal(files['final-response.json'].data.plans[0].stops[0].id, label)
  }
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_/)
})

test('capture limits and thrown transport are explicit, do not retry operations or retain oversized data', async t => {
  let invocations = 0
  const rows = await memoryCapture(t, async run => run(async () => {
    const response = await evidenceAiFetch('initial', ['safe'], 'https://api.openai.com/v1/chat/completions', { body: '{"messages":[{"content":"SECRET_PROMPT"}]}' })
    recordAiModelText(response, 'x'.repeat(262145))
    await Promise.all(Array.from({ length: 514 }, () => observeEvidenceCall('routes', async () => { invocations++; return Response.json({}) })))
    await assert.rejects(observeEvidenceCall('routes', async () => { invocations++; throw Error('SECRET_FAILURE') }), /SECRET_FAILURE/)
    captureAcceptanceDiagnostics({ qualityDiagnostics: { limitations: ['x'.repeat(2 * 1024 * 1024)] } })
    recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
  }))
  const manifest = rows.find(([file]) => file.endsWith('manifest.json'))[1]
  const ledger = rows.find(([file]) => file.endsWith('calls-and-points.json'))[1].data
  assert.equal(invocations, 515)
  assert.equal(ledger.totals.routes.sent, 515)
  assert.equal(ledger.totals.routes.failed, 1)
  assert.equal(ledger.calls.length, 512)
  assert.equal(manifest.status, 'incomplete')
  for (const reason of ['call_records_truncated', 'model_content_limit', 'diagnostics.json:size_limit']) assert.ok(manifest.reasons.includes(reason))
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_/)
  assert.ok(rows.every(([, data]) => Buffer.byteLength(JSON.stringify(data)) < 2 * 1024 * 1024))
})

test('actual resolver memo reuse counts one sent route and one cache hit without inventing another HTTP call', async t => {
  const previousKey = process.env.GOOGLE_PLACES_API_KEY
  process.env.GOOGLE_PLACES_API_KEY = 'SECRET_UNIT_KEY'
  let sent = 0
  let rows
  try {
    rows = await memoryCapture(t, async run => run(async () => {
      t.mock.method(https, 'request', (_url, _init, callback) => {
        sent++
        const req = new EventEmitter()
        req.write = () => {}; req.setTimeout = () => req
        req.end = () => queueMicrotask(() => {
          const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; callback(res)
          res.emit('data', Buffer.from(JSON.stringify({ routes: [{ duration: '240s', distanceMeters: 1000 }] })))
          res.emit('end')
        })
        return req
      })
      const context = createSupplementRouteContext(), resolver = createRepairRouteResolver(context)
      const stops = [{ id: 'first', lat: 22.6, lng: 120.3 }, { id: 'second', lat: 22.61, lng: 120.3 }]
      await resolver([], stops, 'scooter')
      await resolver([], stops, 'scooter')
      captureAcceptanceDiagnostics({ version: 1 })
      recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
    }))
  } finally {
    if (previousKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = previousKey
  }
  const ledger = rows.find(([file]) => file.endsWith('calls-and-points.json'))[1].data
  assert.equal(sent, 1)
  assert.equal(ledger.totals.routes.sent, 1)
  assert.equal(ledger.cacheHits.routes, 1)
})

test('diagnostic query text and unrelated root properties are not persisted', async t => {
  const rows = await memoryCapture(t, async run => run(async () => {
    captureAcceptanceDiagnostics({ version: 1, token: 'SECRET_ROOT', history: ['SECRET_HISTORY'],
      input: { startTime: '10:00', endTime: '15:00', customCategory: 'SECRET_CUSTOM',
        location: { name: 'public park', lat: 22.6, lng: 120.3, token: 'SECRET_LOCATION', url: 'https://example.com/?key=SECRET_KEY' } },
      queryLayer: { batches: [{ phase: 'initial', queries: ['SECRET_QUERY'],
        requestedQueryCount: 1, results: [{ query: 'SECRET_QUERY', rawPlaceCount: 3 }] }] },
      qualityDiagnostics: { version: 1, prompt: 'SECRET_PROMPT' } })
    recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
  }))
  const diagnostics = rows.find(([file]) => file.endsWith('diagnostics.json'))[1].data
  assert.deepEqual(diagnostics.queryLayer.batches[0].rawPlaceCounts, [3])
  assert.deepEqual(diagnostics.input.location, { name: 'public park', lat: 22.6, lng: 120.3 })
  assert.equal(diagnostics.queryLayer.batches[0].requestedQueryCount, 1)
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_/)
})

test('an identity outside the capture allowlist is incomplete evidence, not an invented validation rejection', async t => {
  const rows = await memoryCapture(t, async run => run(async () => {
    const response = await evidenceAiFetch('initial', ['safe'], 'https://api.openai.com/v1/chat/completions',
      { body: '{"messages":[{"content":"bounded identity projection"}]}' })
    const plan = { id: 'safe', type: 'safe', stops: [{ id: '原始站點', placeId: 'place', duration: 60 }] }
    recordAiModelText(response, JSON.stringify({ plans: [plan] }))
    bindEvidencePlan(response, plan)
    captureAcceptanceDiagnostics({ version: 1 })
    recordEvidenceDelivery({ event: 'done', response: { plans: [plan] } })
  }))
  const manifest = rows.find(([file]) => file.endsWith('manifest.json'))[1]
  const raw = rows.find(([file]) => file.endsWith('ai-attempts.json'))[1].data.attempts[0].plans[0]
  assert.equal(manifest.status, 'incomplete')
  assert.ok(manifest.reasons.includes('identity_projection_omitted'))
  assert.equal(raw.stops[0].id, null)
  assert.ok(!raw.reasons.includes('invalid_stop'))
  assert.equal(raw.disposition, 'final_selected')
})

test('culture evidence v1.1: real 38-candidate Prompt writes all four groups for initial/retry/refill', () => {
  const run = mode => JSON.parse(execFileSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', './tests/unit/register-ts-js-extension-loader.mjs',
      './tests/unit/fixtures/acceptance-culture-evidence-replay.mjs', mode],
    { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 60000 }))
  const off = run('off'), on = run('on'), production = run('production')
  assert.deepEqual(on.calls, off.calls); assert.deepEqual(on.events, off.events)
  assert.deepEqual(production.calls, off.calls); assert.deepEqual(production.events, off.events)
  assert.deepEqual(off.bundles, []); assert.deepEqual(off.logs, [])
  assert.deepEqual(production.bundles, []); assert.deepEqual(production.logs, [])
  assert.equal(on.bundles.length, 1)
  const bundle = on.bundles[0], files = bundle.data
  assert.equal(bundle.files.length, 6)
  assert.equal(files['manifest.json'].schemaVersion, 1)
  assert.equal(files['manifest.json'].status, 'complete')
  const prompts = files['prompt-evidence.json'].data
  assert.deepEqual(prompts.map(p => p.stage), ['initial', 'retry', 'refill'])
  assert.deepEqual(prompts.map(p => p.attemptId), [1, 2, 3])
  for (const [i, prompt] of prompts.entries()) {
    assert.equal(prompt.exposedIds.length, 38)
    assert.deepEqual(prompt.links, on.calls[i].links)
    for (const key of Object.keys(capturedLinks)) assert.deepEqual(prompt.links[key], capturedLinks[key])
    assert.deepEqual(prompt.links.culture_primary, [])
    assert.deepEqual(prompt.links.culture_related_unverified, [
      'ChIJifn-9_ADbjQRTR2Q9DmlzEo', 'ChIJTc5MKfEDbjQRQ7UUWqpeQhA',
      'ChIJWSxbrYoDbjQRqKW-W4bCuHQ', 'ChIJay59ifEDbjQRld7ipbyyH-4',
    ])
    for (const id of ['ChIJKTktNo4EbjQRoRKMt38KIUY', 'ChIJ6RxSfH0EbjQRFGeK2utk8Q4', 'ChIJly3pNogDbjQR2wMsjRKBQFA']) {
      assert.ok(!prompt.links.culture_related_unverified.includes(id))
    }
    assert.equal(prompt.sha256, on.calls[i].sha256)
    assert.equal(prompt.utf8Bytes, on.calls[i].utf8Bytes)
    assert.equal(prompt.characters, on.calls[i].characters)
    assert.equal(prompt.linkedIdsExposed, true)
    assert.equal(prompt.blockCount, 1)
  }
  assert.deepEqual(files['ai-attempts.json'].data.attempts.map(a => a.stage), ['initial', 'retry', 'refill'])
  assert.equal(files['calls-and-points.json'].data.totals.ai.sent, 3)
  assert.equal(files['calls-and-points.json'].data.points.outcome, 'not_attempted')
  const serialized = JSON.stringify(files)
  assert.doesNotMatch(serialized, /SECRET_|Authorization|CURRENT_INTENT_CANDIDATE_LINKS|https:\/\/unit-test/)
  assert.equal(files['final-response.json'].data.sha256,
    createHash('sha256').update(JSON.stringify(on.events[0].response)).digest('hex'))
})

test('legacy, absent, empty and populated related groups stay distinct without recomputing classifications', async t => {
  const original = { culture_primary: [], coffee_venue: ['coffee'], mixed_or_uncertain: ['mixed'] }
  const cases = [null, original, { ...original, culture_related_unverified: [] },
    { ...original, culture_related_unverified: ['related-second', 'related-first'] }]
  const rows = await memoryCapture(t, async run => {
    for (const links of cases) await run(async () => {
      const exposed = ['coffee', 'mixed', 'related-first', 'related-second']
        .map(id => `- name=ordinary placeId="${id}"`).join('\n')
      const prompt = exposed + (links ? `\nCURRENT_INTENT_CANDIDATE_LINKS:\n${JSON.stringify(links)}\nEND_CURRENT_INTENT_CANDIDATE_LINKS` : '')
      const response = await evidenceAiFetch('initial', ['safe'], 'https://unit-test.invalid/ai',
        { body: JSON.stringify({ messages: [{ content: prompt }] }) })
      recordAiModelText(response, '{"plans":[]}')
      captureAcceptanceDiagnostics({ version: 1 })
      recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
    })
  })
  const prompts = rows.filter(([file]) => file.endsWith('prompt-evidence.json')).map(([, report]) => report.data[0])
  assert.deepEqual(prompts.map(p => p.links), cases)
  assert.deepEqual(prompts.map(p => p.linksPresent), [false, true, true, true])
  assert.ok(!Object.hasOwn(prompts[1].links, 'culture_related_unverified'))
  assert.ok(Object.hasOwn(prompts[2].links, 'culture_related_unverified'))
  assert.ok(rows.filter(([file]) => file.endsWith('manifest.json')).every(([, manifest]) => manifest.status === 'complete'))
})

test('related capture cannot silently present invalid or bounded-out identities as complete evidence', async t => {
  const cases = [null, ['bad identity', 'valid'], ['x'.repeat(201)], Array.from({ length: 43 }, (_, i) => `id-${i}`)]
  const rows = await memoryCapture(t, async run => {
    for (const related of cases) await run(async () => {
      const prompt = `CURRENT_INTENT_CANDIDATE_LINKS:\n${JSON.stringify({ culture_primary: [], coffee_venue: [],
        mixed_or_uncertain: [], culture_related_unverified: related })}\nEND_CURRENT_INTENT_CANDIDATE_LINKS`
      const response = await evidenceAiFetch('initial', ['safe'], 'https://unit-test.invalid/ai',
        { body: JSON.stringify({ messages: [{ content: prompt }] }) })
      recordAiModelText(response, '{"plans":[]}')
      captureAcceptanceDiagnostics({ version: 1 })
      recordEvidenceDelivery({ event: 'done', response: { plans: [] } })
    })
  })
  for (const [, manifest] of rows.filter(([file]) => file.endsWith('manifest.json'))) {
    assert.equal(manifest.status, 'incomplete')
    assert.ok(manifest.reasons.includes('culture_related_unverified_projection_omitted'))
  }
  const invalid = rows.find(([file]) => file.endsWith('prompt-evidence.json'))[1].data[0]
  assert.ok(!Object.hasOwn(invalid.links, 'culture_related_unverified'))
})
