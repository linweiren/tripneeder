import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { capturedCultureProjectionPool } from './fixtures/culture-evidence-projection.mjs'
import { tokenEstimate, intentCases } from './fixtures/intent-candidate-grounding.mjs'
import { durationQualityFixture, mockDurationQuality } from './fixtures/stop-duration-quality.mjs'

process.env.NODE_ENV = 'production'
process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
const { buildTripPrompt, buildRetryTripSkeletonPrompt, buildTripDetailsPrompt } = await import('../../src/services/ai/tripPlanPrompt.ts')
const { formatNearbyRecommendations, getPromptCandidateSelection } = await import('../../api/_lib/google-places.ts')
const { buildIntentCandidateGrounding } = await import('../../api/_lib/trip-intent-candidate-grounding.ts')
const { applyCandidateGroundingToPlan, repairAndValidatePlanForDelivery, getDeliveryPlanIssues } = await import('../../api/generate-trip.ts')
const { getPlanActualDuration, getMaximumStopDuration } = await import('../../api/_lib/trip-plan-metrics.ts')
const { getMinimumRequiredActualMinutes } = await import('../../api/_lib/trip-planning-rules.ts')
const { getRequiredMealCoverageIssues } = await import('../../api/_lib/trip-quality-rules.ts')
const input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00', endTime: '15:00',
  location: { name: '高雄中央公園' }, people: 2, budget: 'standard', transportMode: 'scooter', tags: [] }
const persona = { stamina: '弱', people: 2 }
const sectionPattern = /停留時間分配原則：\n[^]*?\n\n(?=使用者輸入：)/g
const section = prompt => [...prompt.matchAll(sectionPattern)].map(match => match[0])
const withoutSection = prompt => prompt.replace(sectionPattern, '')
const source = execFileSync('git', ['show', '8f47c776:src/services/ai/tripPlanPrompt.ts'], { encoding: 'utf8' })
const file = new URL('../../src/services/ai/tripPlanPrompt.ts', import.meta.url)
const js = stripTypeScriptTypes(source).replace(/from (['"])([^'"]+)\1/g,
  (_m, q, s) => `from ${q}${new URL(s.replace(/\.js$/, '.ts'), file).href}${q}`)
const baseline = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('shared duration guidance balances evidence, long activities, pacing and existing legality without new numeric caps', () => {
  const text = section(buildTripPrompt(input, persona)).join('')
  assert.match(text, /依可合理支持的活動用途、使用者需求與整體行程/)
  assert.match(text, /main_activity、評分高或填補 Coverage 都不是長停留的充分理由/)
  assert.match(text, /缺少具體活動內容證據時，不得虛構展覽、導覽或其他活動/)
  assert.match(text, /有依據的多項活動、預訂活動或合理休息需求仍可安排長停留，不一律縮短/)
  assert.match(text, /交通、餐期、營業時間、體力與風格/)
  assert.match(text, /避免單站長停留排擠其他重要體驗/)
  assert.match(text, /不要為取代長停留而強制補站或繞路/)
  assert.match(text, /Safe 以低移動負擔、低切換與合理休息呈現慢遊，不任意拉長單站/)
  assert.match(text, /Balanced 兼顧體驗平衡/)
  assert.match(text, /Explore 可增加探索差異，但不強制增加站數/)
  assert.match(text, /不必填滿全部可用時間，仍須遵守下方最低 Coverage、最低停留、餐期、營業及其他合法性規則/)
  assert.doesNotMatch(text, /\d|soft|reference|上限|一律縮短至|必須增加站數/)
})

test('initial and every retry subset add exactly one block; all former contracts and details prompt remain byte-identical', t => {
  const pool = capturedCultureProjectionPool(), originalPool = structuredClone(pool)
  const nearby = `${formatNearbyRecommendations(pool)}\n\n${buildIntentCandidateGrounding(input, pool)}`
  const rows = []
  for (const types of [null, ['safe'], ['balanced'], ['explore'], ['balanced', 'explore']]) {
    const args = types ? [input, types, persona, nearby, ['餐期未對齊']] : [input, persona, nearby]
    const method = types ? 'buildRetryTripSkeletonPrompt' : 'buildTripPrompt'
    const after = (types ? buildRetryTripSkeletonPrompt : buildTripPrompt)(...args)
    const before = baseline[method](...args)
    assert.equal(section(after).length, 1)
    assert.equal(withoutSection(after), before)
    assert.match(after, /體力狀況：弱/)
    assert.match(after, /最低實際行程長度：225 分鐘/)
    assert.match(after, /可安排真實 stop 時長上限：300 分鐘/)
    assert.match(after, /午餐開始時間窗為 11:00-13:00（不含 13:00）/)
    assert.match(after, /候選須符合完整停留的營業時間及 closing buffer/)
    assert.match(after, /非餐飲景點停留通常需至少 40 分鐘，餐飲至少 45 分鐘/)
    assert.match(after, /不同合理停留深度也可以有體驗價值/)
    const delta = Buffer.byteLength(after) - Buffer.byteLength(before)
    assert.equal(after.length - before.length, 330, 'exact shared-text delta used by frozen Search v2 length assertions')
    assert.equal(delta, Buffer.byteLength(section(after)[0]))
    assert.ok(delta < 1400, 'keep this textual guidance bounded')
    rows.push({ stage: types ? `retry:${types.join(',')}` : 'initial', beforeBytes: Buffer.byteLength(before),
      afterBytes: Buffer.byteLength(after), deltaBytes: delta, beforeTokenEstimate: tokenEstimate(before),
      afterTokenEstimate: tokenEstimate(after), addedTextTokenEstimate: tokenEstimate(section(after)[0]) })
  }
  assert.deepEqual(pool, originalPool)
  assert.equal(getPromptCandidateSelection(pool).promptCandidates.length, 38)
  const plan = durationQualityFixture('slow').plan
  assert.equal(buildTripDetailsPrompt(input, plan, persona), baseline.buildTripDetailsPrompt(input, plan, persona))
  t.diagnostic(JSON.stringify({ basis: '38 captured candidates; missing addresses/hours not reconstructed; heuristic tokens, not provider usage', rows }))
})

test('run 3 raw duration projection remains fixture data, without treating the new prompt as a prediction of model output', () => {
  const pool = capturedCultureProjectionPool(), before = structuredClone(pool)
  // Frozen raw attempt 1 projection from db8ff9ce-96d3-4b22-8527-4dc081ef548e.
  // Join to the existing 38-ID capture; addresses/windows were not saved there.
  // This tests grounding only, not reconstruction of the full real itinerary.
  const raw = [
    ['safe', [['高雄中央公園', 120], ['草圖自家烘焙咖啡館 Sketch cafe & Roastery.', 60], ['城市光廊', 60]]],
    ['balanced', [['草圖自家烘焙咖啡館 Sketch cafe & Roastery.', 60], ['光之穹頂', 90], ['城市光廊', 60]]],
    ['explore', [['Delicatesse 洲際烘焙坊', 60], ['駁二塔', 90], ['愛河灣', 60], ['晴。晨甜點咖啡', 30]]],
  ]
  for (const [type, stops] of raw) {
    const plan = { id: type, type, stops: stops.map(([name, duration], i) => {
      const c = pool.allCandidates.find(c => c.name === name)
      assert.ok(c)
      return { id: `stop${i + 1}`, placeId: c.placeId, name, address: c.address,
        type: c.role === 'food' ? 'food' : 'main_activity', duration }
    }), transportSegments: [], rainBackup: [] }
    const original = structuredClone(plan)
    const grounded = applyCandidateGroundingToPlan(plan, pool)
    assert.deepEqual(grounded.stops.map(s => s.duration), stops.map(([name, duration]) =>
      name === '晴。晨甜點咖啡' ? 45 : duration))
    assert.deepEqual(plan, original)
  }
  assert.deepEqual(pool, before)
})

test('booked 180-minute synthetic activity remains legal above its soft reference, with no extra stop', async t => {
  const f = durationQualityFixture('slow', 'safe')
  f.input = { ...f.input, startTime: '09:30', endTime: '14:30',
    customCategory: '文化景點＋咖啡廳；第一站已預訂180分鐘活動（合成測試前提）' }
  f.plan.scheduleStartTime = '09:30'
  f.plan.stops = [f.plan.stops[0], f.plan.stops[1], f.plan.stops[3]]
  f.plan.stops.forEach((s, i) => { s.duration = [180, 45, 45][i] })
  f.candidates.allCandidates = f.candidates.allCandidates.filter(c => f.plan.stops.some(s => s.placeId === c.placeId))
  f.candidates.firstStopCandidates = f.candidates.otherCandidates = f.candidates.allCandidates
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({ fromStopId: f.plan.stops[i].id,
    toStopId: s.id, mode: 'scooter', duration: 4, label: 'fixture' }))
  f.plan.totalTime = 278
  assert.match(buildTripPrompt(f.input, persona), /已預訂180分鐘活動（合成測試前提）/)
  const original = structuredClone(f.plan)
  const { counts } = mockDurationQuality(t, f)
  const result = await repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'duration-prompt-long')
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, f.input, 'duration-prompt-long-final', { candidates: f.candidates }), [])
  assert.deepEqual(result.plan.stops.map(s => s.duration), [180, 45, 45])
  assert.ok(result.plan.stops[0].duration > getMaximumStopDuration(result.plan.stops[0]))
  assert.equal(getPlanActualDuration(result.plan), 278)
  assert.deepEqual(getRequiredMealCoverageIssues(result.plan, f.input), [])
  assert.equal(result.plan.stops.length, 3)
  assert.deepEqual(f.plan, original)
  assert.deepEqual(counts, { places: 3, routes: 2, ai: 0 })
})

for (const kind of ['two-stop', 'meal']) test(`${kind}: required coverage and meal alignment remain legal without adding stops`, async t => {
  const f = durationQualityFixture(kind, 'safe')
  const { counts } = mockDurationQuality(t, f)
  const result = await repairAndValidatePlanForDelivery(f.plan, f.input, f.candidates, new Set(), 'duration-prompt-boundary')
  assert.deepEqual(await getDeliveryPlanIssues(result.plan, f.input, 'duration-prompt-boundary-final', { candidates: f.candidates }), [])
  assert.ok(getPlanActualDuration(result.plan) >= getMinimumRequiredActualMinutes(f.input))
  assert.deepEqual(getRequiredMealCoverageIssues(result.plan, f.input), [])
  assert.equal(result.plan.stops.length, f.plan.stops.length)
  if (kind === 'two-stop') {
    assert.equal(f.candidates.allCandidates.length, 2, 'no unused supplemental candidate exists')
    assert.deepEqual(result.plan.stops.map(s => s.duration), [66, 150])
    assert.deepEqual(counts, { places: 2, routes: 1, ai: 0 })
  } else assert.deepEqual(result.plan.stops.map(s => s.duration), [55, 60, 70, 45])
})

test('8f47c776 fixed full-handler comparison preserves candidates, plans, events and every call outside one prompt block', t => {
  const replay = mode => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    '--import', './tests/unit/register-ts-js-extension-loader.mjs', './tests/unit/fixtures/intent-candidate-grounding-replay.mjs', mode],
  { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }))
  const before = replay('duration-before'), after = replay('duration-after'), sizes = []
  assert.equal(after.length, intentCases.length + 3)
  for (const [i, row] of after.entries()) {
    const old = before[i]
    assert.equal(row.kind, old.kind)
    assert.deepEqual(row.result, old.result, row.kind)
    assert.equal(row.calls.length, old.calls.length, row.kind)
    let ai = 0
    for (const [j, call] of row.calls.entries()) {
      const previous = old.calls[j]
      if (call.url !== 'https://api.openai.com/v1/chat/completions') { assert.deepEqual(call, previous); continue }
      ai++
      const body = JSON.parse(call.init.body), oldBody = JSON.parse(previous.init.body)
      const prompt = body.messages[0].content, oldPrompt = oldBody.messages[0].content
      assert.equal(section(prompt).length, 1, `${row.kind}: actual AI call ${ai}`)
      assert.equal(withoutSection(prompt), oldPrompt, `${row.kind}: candidate list, styles and all other instructions`)
      body.messages[0].content = oldPrompt
      assert.deepEqual({ ...call, init: { ...call.init, body: JSON.stringify(body) } }, previous)
      sizes.push({ kind: row.kind, call: ai, beforeBytes: Buffer.byteLength(oldPrompt), afterBytes: Buffer.byteLength(prompt),
        deltaBytes: Buffer.byteLength(prompt) - Buffer.byteLength(oldPrompt), addedTextTokenEstimate: tokenEstimate(section(prompt)[0]) })
    }
    if (['related-retry', 'related-refill', 'duration-json-recovery'].includes(row.kind)) assert.equal(ai, 2)
    if (['related-retry', 'related-refill', 'duration-json-recovery', 'duration-weak-safe'].includes(row.kind)) {
      const calls = row.calls.filter(c => c.url === 'https://api.openai.com/v1/chat/completions').map(c => JSON.parse(c.init.body))
      assert.equal(calls[0].stream, true)
      if (row.kind === 'duration-json-recovery') {
        assert.notEqual(calls[1].stream, true)
        assert.equal(calls[1].messages[0].content, calls[0].messages[0].content, 'JSON recovery reuses the initial prompt')
      } else if (row.kind === 'duration-weak-safe') assert.match(calls[0].messages[0].content, /體力狀況：弱/)
      else {
        assert.equal(calls[1].temperature, row.kind === 'related-retry' ? 0.2 : 0.15, 'actual retry/refill request path')
        assert.match(calls[1].messages[0].content, /需重產的方案 ID：/)
      }
    }
    if (row.kind === 'duration-sparse') assert.equal(row.result.response.plans.find(p => p.type === 'explore').stops.length, 3)
  }
  t.diagnostic(JSON.stringify({ fixedResponseOnly: true, scenarios: after.length, sizes }))
})
