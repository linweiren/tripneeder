import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { stripIntentLinks } from './fixtures/intent-candidate-grounding.mjs'
import { assertWorkingTreeHandler } from './fixtures/demand-delivery-contract.mjs'
import { withoutPaymentPersistence, assertDeliveryData } from './fixtures/paid-generation-regression-contract.mjs'
const textless = ({ title, subtitle, summary, ...rest }) => rest
// The later intent projection intentionally adds one prompt-only block. Its full
// request delta is checked against fedd41fc in intent-candidate-grounding.test.mjs.
const withoutIntentPrompt = calls => withoutPaymentPersistence(calls).map(call => {
  if (call.url !== 'https://api.openai.com/v1/chat/completions') return call
  const body = JSON.parse(call.init.body)
  body.messages = body.messages.map(message => ({ ...message, content: stripIntentLinks(message.content) }))
  return { ...call, init: { ...call.init, body: JSON.stringify(body) } }
})

test('HEAD comparison: only proven stale text changes; itinerary data and non-intent request content stay identical', () => {
  const replay = mode => JSON.parse(execFileSync(process.execPath, ['--import', './tests/unit/register-ts-js-extension-loader.mjs',
    './tests/unit/fixtures/final-plan-text-replay.mjs', mode], { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 }))
  const before = replay('before'), after = replay('after')
  assertWorkingTreeHandler(after)
  assert.equal(after.rows.length, 27)
  for (const [i, old] of before.rows.entries()) {
    const row = after.rows[i]
    assert.deepEqual(row.calls, old.calls)
    assert.deepEqual(textless(row.plan), textless(old.plan))
    if (['grounding', 'repair', 'unreferenced'].includes(row.kind)) {
      assert.equal(row.plan.stops[1].name, '草圖咖啡')
      if (row.kind !== 'unreferenced') {
        assert.notEqual(row.plan.summary, old.plan.summary)
        assert.doesNotMatch(row.plan.summary, /眷鳥|喝咖啡|草圖|文化|用餐/)
        assert.equal(row.plan.subtitle, old.plan.subtitle)
      } else assert.deepEqual(row.plan, old.plan)
    } else if (row.kind === 'fallback-removed') {
      assert.equal(row.plan.stops[1].name, '原正餐餐廳')
      assert.notEqual(row.plan.summary, old.plan.summary)
      assert.equal(row.plan.title, old.plan.title)
    } else {
      assert.deepEqual(row.plan, old.plan)
      if (row.kind === 'art-description') assert.equal(row.plan.stops[1].name, '地方文物館')
      if (['region-description', 'short-reference'].includes(row.kind)) assert.equal(row.plan.stops[1].name, '草圖咖啡')
    }
  }
  assert.deepEqual(withoutIntentPrompt(after.generationCalls), withoutIntentPrompt(before.generationCalls))
  const oldPlans = before.generation.response.plans, newPlans = after.generation.response.plans
  assertDeliveryData(after.generation.response, before.generation.response, { ignoreText: true,
    additionalWarnings: [/^未安排可確認符合「文化活動」需求的活動；已保留其他可用活動，目前無法確認是否另有合適地點。$/] })
  assert.notEqual(newPlans[0].summary, oldPlans[0].summary)
  const explore = newPlans.find(plan => plan.type === 'explore')
  if (explore) assert.notEqual(explore.subtitle, oldPlans.find(plan => plan.type === 'explore').subtitle)
  assert.equal(after.input.customCategory, '文化景點＋咖啡廳')
  assert.ok(after.generation.response.warnings.some(warning => /：未安排可確認符合「文化活動」/.test(warning)))
  for (const plan of newPlans) {
    assert.ok(plan.stops.some(stop => stop.googleTypes.includes('cafe')), 'the requested cafe remains an actual visit')
    assert.match(plan.summary, /未安排可確認符合「文化活動」/)
    assert.doesNotMatch(plan.title + plan.subtitle + plan.summary, /眷鳥/)
  }
  // Keep every original exact-text/no-extra-request assertion for the general
  // control; explicit demand disclosure is the only allowed mixed-case text delta.
  const oldGeneral = before.general.generation.response.plans, newGeneral = after.general.generation.response.plans
  assert.deepEqual(withoutIntentPrompt(after.general.generationCalls), withoutIntentPrompt(before.general.generationCalls))
  assertDeliveryData(after.general.generation.response, before.general.generation.response, { ignoreText: true })
  assert.notEqual(newGeneral[0].summary, oldGeneral[0].summary)
  const balancedGeneral = newGeneral.find(plan => plan.type === 'balanced')
  if (balancedGeneral) for (const field of ['title', 'subtitle', 'summary']) assert.equal(balancedGeneral[field], oldGeneral.find(plan => plan.type === 'balanced')[field])
  const exploreGeneral = newGeneral.find(plan => plan.type === 'explore')
  if (exploreGeneral) {
    assert.notEqual(exploreGeneral.subtitle, oldGeneral.find(plan => plan.type === 'explore').subtitle)
    assert.equal(exploreGeneral.summary, oldGeneral.find(plan => plan.type === 'explore').summary)
  }
  for (const event of after.generation.events.filter(e => e.event === 'plan')) {
    assert.doesNotMatch(event.plan.title + event.plan.subtitle + event.plan.summary, /眷鳥/)
  }
  for (const [i, old] of before.detailRows.entries()) {
    const row = after.detailRows[i]
    const authCalls = row.calls.filter(call => call.url === 'https://unit-test.supabase.co/auth/v1/user')
    assert.equal(authCalls.length, 1, 'Details now verify the session once before any paid call')
    assert.equal(authCalls[0].init.method, 'GET')
    assert.deepEqual(row.calls.filter(call => call.url !== 'https://unit-test.supabase.co/auth/v1/user'), old.calls)
    assert.deepEqual(textless(row.plan), textless(old.plan))
    if (row.kind === 'merged-main') assert.deepEqual(row.plan, old.plan)
    else {
      assert.notEqual(row.plan.summary, old.plan.summary)
      assert.doesNotMatch(row.plan.summary, /眷鳥|用餐|咖啡|文化/)
    }
  }
  if (process.env.FINAL_TEXT_REPORT) writeFileSync(process.env.FINAL_TEXT_REPORT, JSON.stringify({ head: '19a538d', before, after }, null, 2) + '\n')
})
