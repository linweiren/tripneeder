import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { buildIntentCandidateGrounding } from '../../api/_lib/trip-intent-candidate-grounding.ts'
import { getPromptCandidateSelection, formatNearbyRecommendations, hasConfirmedCulturalPrimaryPurpose } from '../../api/_lib/google-places.ts'
import { buildTripPrompt } from '../../src/services/ai/tripPlanPrompt.ts'
import { applyCandidateGroundingToPlan } from '../../api/generate-trip.ts'
import { getRequiredMealCoverageIssues } from '../../api/_lib/trip-quality-rules.ts'
import { intentCases, intentGroundingFixture, readIntentLinks, stripIntentLinks, tokenEstimate } from './fixtures/intent-candidate-grounding.mjs'
import { capturedCultureProjectionPool, capturedLinks, capturedPromptLengths } from './fixtures/culture-evidence-projection.mjs'
import { assertWorkingTreeHandler } from './fixtures/demand-delivery-contract.mjs'

const file = new URL('../../api/_lib/trip-intent-candidate-grounding.ts', import.meta.url)
const oldSource = execFileSync('git', ['show', '342847c:api/_lib/trip-intent-candidate-grounding.ts'], { encoding: 'utf8' })
const oldJs = stripTypeScriptTypes(oldSource).replace(/from (['"])([^'"]+)\1/g, (_m, q, s) =>
  `from ${q}${new URL(s.replace(/\.js$/, '.ts'), file).href}${q}`)
const baseline = (await import(`data:text/javascript;base64,${Buffer.from(oldJs).toString('base64')}`)).buildIntentCandidateGrounding
const input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00', endTime: '15:00',
  location: { name: '高雄中央公園' }, people: 2, transportMode: 'scooter', budget: 'small', tags: [] }
const existingGroups = ['culture_primary', 'coffee_venue', 'mixed_or_uncertain']
const poolOf = candidates => ({ allCandidates: candidates, firstStopCandidates: candidates, otherCandidates: candidates })
const candidate = (id, name, types, extra = {}) => ({ ...capturedCultureProjectionPool().allCandidates[2],
  placeId: id, name, types, role: 'main_activity', ...extra })

test('real run 3: all 38 captured IDs/order/scores remain intact; four historical clues fit', t => {
  const pool = capturedCultureProjectionPool(), original = structuredClone(pool)
  const ids = getPromptCandidateSelection(pool).promptCandidates.map(c => c.placeId)
  assert.equal(ids.length, 38)
  assert.deepEqual(ids, pool.allCandidates.map(c => c.placeId))
  const before = baseline(input, pool), after = buildIntentCandidateGrounding(input, pool)
  const oldLinks = readIntentLinks(before), links = readIntentLinks(after)
  assert.deepEqual(oldLinks, capturedLinks)
  for (const group of existingGroups) assert.deepEqual(links[group], oldLinks[group])
  assert.deepEqual(links.culture_primary, [])
  assert.deepEqual(links.culture_related_unverified, [
    'ChIJifn-9_ADbjQRTR2Q9DmlzEo', 'ChIJTc5MKfEDbjQRQ7UUWqpeQhA',
    'ChIJWSxbrYoDbjQRqKW-W4bCuHQ', 'ChIJay59ifEDbjQRld7ipbyyH-4',
  ])
  for (const name of ['光之穹頂', '城市光廊', '駁二塔']) {
    const c = pool.allCandidates.find(c => c.name === name)
    assert.ok(!links.culture_related_unverified.includes(c.placeId))
    assert.equal(hasConfirmedCulturalPrimaryPurpose(c), false)
  }
  assert.deepEqual(pool, original)
  assert.deepEqual(getPromptCandidateSelection(pool).promptCandidates.map(c => c.placeId), ids)
  const nearby = formatNearbyRecommendations(pool)
  assert.equal(stripIntentLinks(buildTripPrompt(input, undefined, `${nearby}\n\n${after}`)),
    stripIntentLinks(buildTripPrompt(input, undefined, `${nearby}\n\n${before}`)))
  assert.ok(Buffer.byteLength(after) <= 1800)
  const deltaBytes = Buffer.byteLength(after) - Buffer.byteLength(before)
  t.diagnostic(JSON.stringify({ capture: 'db8ff9ce-96d3-4b22-8527-4dc081ef548e',
    beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), deltaBytes,
    beforeEstimatedTokens: tokenEstimate(before), afterEstimatedTokens: tokenEstimate(after),
    estimatedDeltaTokens: tokenEstimate(after).map((n, i) => n - tokenEstimate(before)[i]),
    // Full historical Prompt was deliberately not saved: these are length deltas,
    // not a reconstructed or re-sent historical request.
    derivedPromptLengths: capturedPromptLengths.map(p => ({ ...p, afterUtf8Bytes: p.utf8Bytes + deltaBytes })) }))
})

test('only explicit historical types supply related clues; names and generic venue types do not', () => {
  const controls = [
    candidate('park', '歷史藝術公園', ['park']),
    candidate('bay', '文化愛河灣', ['tourist_attraction']),
    candidate('mall', '藝術百貨', ['shopping_mall'], { role: 'shopping' }),
    candidate('view', '藝術觀景台', ['observation_deck', 'scenic_spot']),
    candidate('book', '藝術書店', ['book_store']),
    candidate('space', '藝術廣場', ['point_of_interest']),
    candidate('restaurant', '藝術餐廳', ['restaurant', 'food'], { role: 'food', foodSubtype: 'restaurant' }),
    candidate('cafe', '歷史咖啡', ['cafe', 'food'], { role: 'food', foodSubtype: 'cafe' }),
    candidate('center', '文化中心', ['cultural_center']),
    candidate('landmark', '地點甲', ['historical_landmark']),
    candidate('historic', '地點乙', ['historical_place']),
  ]
  const pool = poolOf(controls), snapshot = structuredClone(pool)
  const links = readIntentLinks(buildIntentCandidateGrounding(input, pool))
  assert.deepEqual(links.culture_related_unverified, ['landmark', 'historic'])
  assert.deepEqual(links.culture_primary, [])
  assert.deepEqual(pool, snapshot)
})

test('museum/gallery priority and ancillary coffee remain unchanged; museums are not meal stops', () => {
  const museums = [candidate('museum', '地方博物館', ['museum', 'historical_landmark']),
    candidate('gallery', '地方美術館', ['art_gallery']),
    candidate('museum-cafe', '城市藝術博物館', ['museum', 'cafe', 'restaurant', 'food'], { foodSubtype: 'cafe' })]
  const pool = poolOf(museums), links = readIntentLinks(buildIntentCandidateGrounding(input, pool))
  assert.deepEqual(links.culture_primary, museums.map(c => c.placeId))
  assert.deepEqual(links.culture_related_unverified, [])
  assert.deepEqual(links.coffee_venue, [])
  const plan = { id: 'safe', type: 'safe', scheduleStartTime: '11:00', transportSegments: [], rainBackup: [],
    stops: [{ ...museums[2], id: 'stop', type: 'food', duration: 60 }] }
  const grounded = applyCandidateGroundingToPlan(plan, pool)
  assert.equal(grounded.stops[0].type, 'main_activity')
  assert.ok(getRequiredMealCoverageIssues(grounded, input).length > 0)
})

test('historical context can coexist with coffee evidence without becoming primary or a meal claim', () => {
  const pool = poolOf([candidate('historic-cafe', '歷史咖啡館', ['historical_place', 'cafe'],
    { role: 'food', foodSubtype: 'cafe' })])
  const old = readIntentLinks(baseline(input, pool)), links = readIntentLinks(buildIntentCandidateGrounding(input, pool))
  assert.deepEqual(links.coffee_venue, old.coffee_venue)
  assert.deepEqual(links.culture_primary, [])
  assert.deepEqual(links.culture_related_unverified, ['historic-cafe'])
  const block = buildIntentCandidateGrounding(input, pool)
  assert.match(block, /非已確認展覽、導覽或文化活動/)
  assert.match(block, /未列不代表沒有文化價值/)
  assert.match(block, /不強制選用/)
  assert.match(block, /咖啡非可靠正餐/)
})

test('same-name identities, hidden candidates and illegal candidates never leak into related IDs', () => {
  const generic = candidate('generic', '同名地點', ['tourist_attraction'])
  const historic = candidate('historic', '同名地點', ['historical_place'])
  const invalid = [candidate('unknown-hours', '同名地點', ['historical_place'], { openingHours: undefined }),
    candidate('closed', '同名地點', ['historical_place'], { openingHours: { isKnown: true, isNeverOpen: true } }),
    candidate('no-slots', '同名地點', ['historical_place'], { availabilitySlots: [] })]
  const fillers = Array.from({ length: 24 }, (_, i) => candidate(`other-${i}`, `一般地點${i}`, ['point_of_interest']))
  const hidden = candidate('hidden', '同名地點', ['historical_landmark'])
  const pool = { firstStopCandidates: [generic, historic, ...invalid],
    otherCandidates: [...fillers, hidden], allCandidates: [generic, historic, ...invalid, ...fillers, hidden] }
  const ids = getPromptCandidateSelection(pool).promptCandidates.map(c => c.placeId)
  assert.ok(!ids.includes(hidden.placeId))
  const links = readIntentLinks(buildIntentCandidateGrounding(input, pool))
  assert.deepEqual(links.culture_related_unverified, ['historic'])
  assert.ok(Object.values(links).flat().every(id => ids.includes(id)))
})

test('bounded clues never displace baseline culture/coffee/mixed IDs, including long complete identities', () => {
  const emptyGroups = poolOf([candidate('generic', '地點', ['point_of_interest'])])
  assert.ok(Buffer.byteLength(buildIntentCandidateGrounding(input, emptyGroups)) <= Buffer.byteLength(baseline(input, emptyGroups)),
    'shorter guidance must pay for the new empty key before allocating any existing IDs')
  for (const width of [1, 28, 80, 160, 300, 800, 2000]) {
    const f = intentGroundingFixture('related-history')
    for (const [i, c] of f.candidates.allCandidates.entries()) c.placeId = `id-${i}-${'x'.repeat(width)}`
    const old = readIntentLinks(baseline(input, f.candidates))
    const block = buildIntentCandidateGrounding(input, f.candidates), links = readIntentLinks(block)
    assert.ok(Buffer.byteLength(block) <= 1800)
    for (const key of existingGroups) {
      assert.deepEqual(links[key], old[key], `${width}: ${key}`)
      assert.ok(links[key].length <= 3)
    }
    assert.ok(links.culture_related_unverified.length <= 4)
    const ids = getPromptCandidateSelection(f.candidates).promptCandidates.map(c => c.placeId)
    assert.ok(Object.values(links).flat().every(id => ids.includes(id)))
  }
})

test('current handler with 342847c projection control: all fixed plans/events/calls remain equal', t => {
  const replay = mode => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    '--import', './tests/unit/register-ts-js-extension-loader.mjs', './tests/unit/fixtures/intent-candidate-grounding-replay.mjs', mode],
  { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }))
  const before = replay('projection-before'), after = replay('after'), report = []
  assert.equal(after.length, intentCases.length)
  for (const [i, row] of after.entries()) {
    const old = before[i]
    assertWorkingTreeHandler(row); assertWorkingTreeHandler(old)
    assert.deepEqual(row.result, old.result, row.kind)
    assert.equal(row.calls.length, old.calls.length)
    let aiCalls = 0
    for (const [j, call] of row.calls.entries()) {
      const previous = old.calls[j]
      if (call.url !== 'https://api.openai.com/v1/chat/completions') { assert.deepEqual(call, previous); continue }
      aiCalls++
      const body = JSON.parse(call.init.body), oldBody = JSON.parse(previous.init.body)
      const prompt = body.messages[0].content, originalPrompt = oldBody.messages[0].content
      assert.equal(stripIntentLinks(prompt), stripIntentLinks(originalPrompt))
      const oldLinks = readIntentLinks(originalPrompt), links = readIntentLinks(prompt)
      if (!oldLinks) assert.equal(prompt, originalPrompt)
      else {
        assert.equal(prompt.split('CURRENT_INTENT_CANDIDATE_LINKS:').length - 1, 1)
        for (const key of existingGroups) assert.deepEqual(links[key], oldLinks[key])
        const block = prompt.match(/CURRENT_INTENT_CANDIDATE_LINKS:\n[^]*?\nEND_CURRENT_INTENT_CANDIDATE_LINKS/)[0]
        assert.ok(Buffer.byteLength(block) <= 1800)
        if (row.kind.startsWith('related-')) assert.equal(links.culture_related_unverified.length, 4)
        report.push({ kind: row.kind, beforeBytes: Buffer.byteLength(originalPrompt), afterBytes: Buffer.byteLength(prompt),
          related: links.culture_related_unverified.length })
      }
      body.messages[0].content = originalPrompt
      assert.deepEqual({ ...call, init: { ...call.init, body: JSON.stringify(body) } }, previous)
    }
    if (['related-retry', 'related-refill'].includes(row.kind)) assert.equal(aiCalls, 2)
  }
  t.diagnostic(JSON.stringify(report))
})
