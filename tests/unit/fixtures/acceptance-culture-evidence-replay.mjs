// Actual disk capture at the AI request boundary; every network operation is mocked.
// The captured 38-candidate pool is a Prompt fixture, not a full itinerary replay.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { buildIntentCandidateGrounding } from '../../../api/_lib/trip-intent-candidate-grounding.ts'
import { formatNearbyRecommendations } from '../../../api/_lib/google-places.ts'
import { buildTripPrompt } from '../../../src/services/ai/tripPlanPrompt.ts'
import { withAcceptanceEvidence, evidenceAiFetch, recordAiModelText, bindEvidencePlan,
  captureAcceptanceDiagnostics, recordEvidenceDelivery } from '../../../api/_lib/trip-acceptance-evidence.ts'
import { capturedCultureProjectionPool } from './culture-evidence-projection.mjs'

const mode = process.argv[2] || 'on'
assert.ok(['on', 'off', 'production'].includes(mode))
const root = process.env.ACCEPTANCE_REPLAY_ROOT || mkdtempSync(join(tmpdir(), 'trip-acceptance-culture-'))
Object.assign(process.env, { NODE_ENV: mode === 'production' ? 'production' : 'development',
  TRIP_CANDIDATE_DEBUG: mode === 'off' ? 'false' : 'true', TRIP_ACCEPTANCE_EVIDENCE_DIR: root })
const logs = [], calls = [], events = []
for (const key of ['info', 'warn', 'error', 'log', 'debug']) mock.method(console, key, (...args) => logs.push(args))
const deny = () => { throw Error('Unmocked network forbidden') }
mock.method(https, 'request', deny); mock.method(http, 'request', deny)
mock.method(net, 'connect', deny); mock.method(net, 'createConnection', deny); mock.method(tls, 'connect', deny)
mock.method(globalThis, 'fetch', async (url, init) => {
  assert.equal(url, 'https://unit-test.invalid/ai')
  const prompt = JSON.parse(init.body).messages[0].content
  const block = prompt.match(/CURRENT_INTENT_CANDIDATE_LINKS:\n([^]*?)\nEND_CURRENT_INTENT_CANDIDATE_LINKS/)[1]
  calls.push({ sha256: createHash('sha256').update(prompt).digest('hex'), characters: prompt.length,
    utf8Bytes: Buffer.byteLength(prompt), links: JSON.parse(block.split('\n').at(-1)) })
  return Response.json({ choices: [] })
})
const pool = capturedCultureProjectionPool()
const input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00', endTime: '15:00',
  location: { name: '高雄中央公園' }, people: 2, transportMode: 'scooter', budget: 'small', tags: [] }
const prompt = buildTripPrompt(input, undefined,
  `${formatNearbyRecommendations(pool)}\n\n${buildIntentCandidateGrounding(input, pool)}`)
const finalPlans = []
await withAcceptanceEvidence({ input }, { write() {}, json() {}, status() { return this }, end() {} }, async () => {
  for (const [i, stage] of ['initial', 'retry', 'refill'].entries()) {
    const type = ['safe', 'balanced', 'explore'][i]
    const response = await evidenceAiFetch(stage, [type], 'https://unit-test.invalid/ai', {
      body: JSON.stringify({ messages: [{ content: prompt }] }), headers: { Authorization: 'SECRET_NOT_SAVED' },
    })
    const plan = { id: type, type, stops: [{ id: `stop-${i}`, placeId: pool.allCandidates[i].placeId, duration: 60 }] }
    recordAiModelText(response, JSON.stringify({ plans: [plan] }))
    bindEvidencePlan(response, plan)
    finalPlans.push(plan)
  }
  captureAcceptanceDiagnostics({ version: 1 })
  const done = { event: 'done', response: { plans: finalPlans } }
  recordEvidenceDelivery(done); events.push(done)
})
const bundles = readdirSync(root).map(folder => {
  const directory = join(root, folder), files = readdirSync(directory)
  const data = Object.fromEntries(files.map(file => [file, JSON.parse(readFileSync(join(directory, file), 'utf8'))]))
  assert.equal(data['manifest.json'].requestId, folder)
  for (const [file, sha] of Object.entries(data['manifest.json'].files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'), sha)
    assert.equal(data[file].requestId, folder)
  }
  return { directory, files, data }
})
process.stdout.write(JSON.stringify({ mode, calls, events, logs, bundles }))
mock.restoreAll()
