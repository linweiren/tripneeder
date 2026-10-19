import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { stripIntentLinks } from './fixtures/intent-candidate-grounding.mjs'
const textless = ({ title, subtitle, summary, ...rest }) => rest
// The later intent projection intentionally adds one prompt-only block. Its full
// request delta is checked against fedd41fc in intent-candidate-grounding.test.mjs.
const withoutIntentPrompt = calls => calls.map(call => {
  if (call.url !== 'https://api.openai.com/v1/chat/completions') return call
  const body = JSON.parse(call.init.body)
  body.messages = body.messages.map(message => ({ ...message, content: stripIntentLinks(message.content) }))
  return { ...call, init: { ...call.init, body: JSON.stringify(body) } }
})

test('HEAD comparison: only proven stale text changes; itinerary data and non-intent request content stay identical', () => {
  const replay = mode => JSON.parse(execFileSync(process.execPath, ['--import', './tests/unit/register-ts-js-extension-loader.mjs',
    './tests/unit/fixtures/final-plan-text-replay.mjs', mode], { encoding: 'utf8', maxBuffer: 15 * 1024 * 1024 }))
  const before = replay('before'), after = replay('after')
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
  assert.deepEqual(newPlans.map(textless), oldPlans.map(textless))
  assert.notEqual(newPlans[0].summary, oldPlans[0].summary)
  assert.deepEqual(newPlans[1], oldPlans[1])
  assert.notEqual(newPlans[2].subtitle, oldPlans[2].subtitle)
  assert.equal(newPlans[2].summary, oldPlans[2].summary)
  for (const event of after.generation.events.filter(e => e.event === 'plan')) {
    assert.doesNotMatch(event.plan.title + event.plan.subtitle + event.plan.summary, /眷鳥/)
  }
  for (const [i, old] of before.detailRows.entries()) {
    const row = after.detailRows[i]
    assert.deepEqual(row.calls, old.calls)
    assert.deepEqual(textless(row.plan), textless(old.plan))
    if (row.kind === 'merged-main') assert.deepEqual(row.plan, old.plan)
    else {
      assert.notEqual(row.plan.summary, old.plan.summary)
      assert.doesNotMatch(row.plan.summary, /眷鳥|用餐|咖啡|文化/)
    }
  }
  if (process.env.FINAL_TEXT_REPORT) writeFileSync(process.env.FINAL_TEXT_REPORT, JSON.stringify({ head: '19a538d', before, after }, null, 2) + '\n')
})
