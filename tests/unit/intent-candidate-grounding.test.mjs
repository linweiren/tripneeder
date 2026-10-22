import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildIntentCandidateGrounding } from '../../api/_lib/trip-intent-candidate-grounding.ts'
import { formatNearbyRecommendations, getPromptCandidateSelection, hasConfirmedCulturalPrimaryPurpose } from '../../api/_lib/google-places.ts'
import { buildTripPrompt, buildRetryTripSkeletonPrompt } from '../../src/services/ai/tripPlanPrompt.ts'
import { intentCases, intentGroundingFixture, stripIntentLinks, readIntentLinks, tokenEstimate } from './fixtures/intent-candidate-grounding.mjs'

const active = kind => !['coffee-only', 'culture-only', 'explore', 'negative', 'conditional', 'unknown', 'three-themes'].includes(kind)
for (const kind of intentCases) test(`intent-to-candidate projection: ${kind}`, () => {
  const f = intentGroundingFixture(kind)
  if (kind === 'illegal-culture') for (const c of f.candidates.allCandidates) if (c.types?.some(t => ['museum', 'art_gallery'].includes(t))) {
    c.openingHours.isNeverOpen = true; c.availabilitySlots = []
  }
  const input = structuredClone(f.input), pool = structuredClone(f.candidates)
  const before = formatNearbyRecommendations(f.candidates)
  const ids = getPromptCandidateSelection(f.candidates).promptCandidates.map(c => c.placeId)
  const section = buildIntentCandidateGrounding(f.input, f.candidates)
  const nearby = [before, section].filter(Boolean).join('\n\n')
  const oldPrompt = buildTripPrompt(f.input, undefined, before), prompt = buildTripPrompt(f.input, undefined, nearby)
  assert.equal(stripIntentLinks(prompt), oldPrompt)
  assert.equal(Boolean(section), active(kind))
  assert.ok(Buffer.byteLength(section) <= 1800)
  assert.deepEqual(f.input, input); assert.deepEqual(f.candidates, pool)
  assert.equal(formatNearbyRecommendations(f.candidates), before)
  assert.deepEqual(getPromptCandidateSelection(f.candidates).promptCandidates.map(c => c.placeId), ids)
  if (!section) return
  const links = readIntentLinks(section)
  if (kind === 'mixed' || kind === 'history-coffee') {
    assert.ok(links.culture_primary.length > 0)
    assert.ok(links.coffee_venue.length > 0)
  }
  const exposed = getPromptCandidateSelection(f.candidates).promptCandidates
  for (const [group, list] of Object.entries(links)) {
    assert.ok(list.length <= (group === 'culture_related_unverified' ? 4 : 3))
    assert.ok(list.every(id => ids.includes(id)))
    assert.deepEqual(list, ids.filter(id => list.includes(id)))
  }
  assert.ok(links.culture_primary.every(id => hasConfirmedCulturalPrimaryPurpose(exposed.find(c => c.placeId === id))))
  assert.ok(links.coffee_venue.every(id => exposed.find(c => c.placeId === id).types.includes('cafe')))
  assert.ok(!Object.values(links).flat().some(id => id.startsWith('intent-book-')), 'indoor book bucket is not cultural proof')
  if (['uncertain', 'illegal-culture'].includes(kind)) assert.equal(links.culture_primary.length, 0)
  if (kind === 'unexposed') {
    assert.equal(links.culture_primary.length, 0)
    assert.ok(f.candidates.allCandidates.some(c => hasConfirmedCulturalPrimaryPurpose(c) && !ids.includes(c.placeId)))
  }
  for (const planTypes of [['safe'], ['balanced'], ['explore'], ['safe', 'balanced', 'explore']]) {
    const retry = buildRetryTripSkeletonPrompt(f.input, planTypes, undefined, nearby, ['既有驗證原因'])
    assert.equal(stripIntentLinks(retry), buildRetryTripSkeletonPrompt(f.input, planTypes, undefined, before, ['既有驗證原因']))
    assert.equal(retry.split('CURRENT_INTENT_CANDIDATE_LINKS:').length - 1, 1)
    assert.ok(retry.includes(`需重產的方案 ID：${planTypes.join(', ')}`))
  }
})

test('bounded intact IDs, empty pool, ambiguous cultural types and ancillary coffee', () => {
  const f = intentGroundingFixture('mixed')
  const museum = f.candidates.allCandidates.find(hasConfirmedCulturalPrimaryPurpose)
  museum.types = ['museum', 'cafe']
  let section = buildIntentCandidateGrounding(f.input, f.candidates), links = readIntentLinks(section)
  assert.ok(links.culture_primary.includes(museum.placeId))
  assert.ok(!links.coffee_venue.includes(museum.placeId))
  assert.ok(links.mixed_or_uncertain.includes('intent-mixed'))
  for (const c of f.candidates.allCandidates) c.placeId = `long-${'測'.repeat(1000)}-${c.placeId}`
  section = buildIntentCandidateGrounding(f.input, f.candidates)
  assert.ok(Buffer.byteLength(section) <= 1800)
  assert.deepEqual(Object.values(readIntentLinks(section)).flat(), [])
  assert.equal(buildIntentCandidateGrounding(f.input, { allCandidates: [], firstStopCandidates: [], otherCandidates: [] }), '')
})

test('complete fedd41fc comparison: only intended prompt block differs; final plans/events and every other request stay identical', t => {
  const replay = mode => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', './tests/unit/register-ts-js-extension-loader.mjs',
    './tests/unit/fixtures/intent-candidate-grounding-replay.mjs', mode], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }))
  const before = replay('before'), after = replay('after'), report = []
  assert.equal(after.length, intentCases.length)
  for (const [i, row] of after.entries()) {
    const old = before[i]
    assert.equal(row.kind, old.kind)
    assert.deepEqual(row.result, old.result, row.kind)
    assert.equal(row.calls.length, old.calls.length, row.kind)
    const prompts = []
    for (const [j, call] of row.calls.entries()) {
      const previous = old.calls[j]
      if (call.url !== 'https://api.openai.com/v1/chat/completions') { assert.deepEqual(call, previous); continue }
      const body = JSON.parse(call.init.body), oldBody = JSON.parse(previous.init.body)
      const prompt = body.messages[0].content, oldPrompt = oldBody.messages[0].content
      assert.equal(stripIntentLinks(prompt), oldPrompt, row.kind)
      assert.equal(Boolean(readIntentLinks(prompt)), active(row.kind), row.kind)
      const ids = text => [...text.matchAll(/^- name=.*?placeId="([^"]+)"/gm)].map(m => m[1])
      assert.deepEqual(ids(prompt), ids(oldPrompt))
      const links = readIntentLinks(prompt), added = prompt.length - oldPrompt.length
      if (links) {
        assert.ok(Object.values(links).flat().every(id => ids(prompt).includes(id)))
        if (['uncertain', 'illegal-culture', 'unexposed'].includes(row.kind)) assert.equal(links.culture_primary.length, 0)
        const block = prompt.match(/CURRENT_INTENT_CANDIDATE_LINKS:\n[^]*?\nEND_CURRENT_INTENT_CANDIDATE_LINKS/)[0]
        assert.ok(Buffer.byteLength(block) <= 1800)
        prompts.push({ exposedIds: ids(prompt), links, addedCharacters: added,
          addedBytes: Buffer.byteLength(prompt) - Buffer.byteLength(oldPrompt), estimatedTokens: tokenEstimate(`\n\n${block}`) })
      } else prompts.push({ exposedIds: ids(prompt), addedCharacters: added, estimatedTokens: [0, 0] })
      body.messages[0].content = oldPrompt
      assert.deepEqual({ ...call, init: { ...call.init, body: JSON.stringify(body) } }, { ...previous, init: { ...previous.init, body: JSON.stringify(oldBody) } })
    }
    const aiCalls = row.calls.filter(c => c.url === 'https://api.openai.com/v1/chat/completions').length
    if (row.kind.startsWith('retry-')) assert.ok(aiCalls >= 2)
    report.push({ kind: row.kind, aiCalls, externalCalls: row.calls.length, prompts, plansIdentical: true, nonPromptRequestsIdentical: true })
  }
  if (process.env.INTENT_GROUNDING_REPORT) writeFileSync(process.env.INTENT_GROUNDING_REPORT, JSON.stringify({ baseline: 'fedd41fc', before, after, report }, null, 2) + '\n')
  t.diagnostic(JSON.stringify(report.map(r => ({ kind: r.kind, ai: r.aiCalls, calls: r.externalCalls,
    deltas: r.prompts.map(p => ({ chars: p.addedCharacters, bytes: p.addedBytes, tokens: p.estimatedTokens })) }))))
})
