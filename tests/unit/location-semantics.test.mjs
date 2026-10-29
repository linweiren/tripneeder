import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { getMaximumStopDuration, getStopStretchWeight, getReasonableStopDuration } from '../../api/_lib/trip-plan-metrics.ts'
import { inferStopRhythmRole, getPlanRhythmIssues } from '../../api/_lib/trip-quality-rules.ts'
import { getActivityPurpose } from '../../api/_lib/trip-activity-purpose.ts'

const stop = (name, address = '', googleTypes = [], type = 'main_activity') =>
  ({ id: 'test', name, address, googleTypes, type, duration: 90, description: '' })
const facts = s => [getMaximumStopDuration(s), getStopStretchWeight(s), inferStopRhythmRole(s)]

test('Dome on Zhongshan Road has no outdoor evidence, reference 90 and weight 2 across addresses', () => {
  const dome = stop('光之穹頂', '800高雄市新興區明莊里中山一路115號B1', ['tourist_attraction', 'scenic_spot'])
  for (const address of [dome.address, '公園路1號', '森林路1號', '中正路1號', '文化路1號', '市場路1號', '銀行路1號', '咖啡路1號', '']) {
    assert.deepEqual(facts({ ...dome, address }), [90, 2, 'main_activity'])
  }
  assert.equal(getReasonableStopDuration(dome), 75)
  assert.equal(getActivityPurpose(dome), 'activity', 'does not change purpose classification')
})

test('clear park, mountain trail and riverbank names retain outdoor evidence without needing an address', () => {
  for (const name of ['高雄中央公園', '登山步道', '壽山', '河濱草地', '森林步道', '澄清湖風景區', 'Riverside Park']) {
    assert.deepEqual(facts(stop(name, '中正路1號')), [120, 3, 'open_space'], name)
  }
  for (const type of ['park', 'city_park', 'national_park', 'hiking_area']) {
    assert.deepEqual(facts(stop('甲地', '中正路1號', [type])), [90, 2, 'open_space'], `${type}: recognize rhythm without inflating duration`)
  }
})

test('food stays on park/mountain roads retain food priority; rest and shopping names ignore road keywords', () => {
  for (const address of ['公園路1號', '山路1號', '森林路1號']) {
    for (const [name, type] of [['街角咖啡', 'cafe'], ['家常餐廳', 'restaurant']]) {
      assert.deepEqual(facts(stop(name, address, [type], 'food')), [90, 1, 'food'])
    }
    assert.deepEqual(facts(stop('街角咖啡', address, ['cafe'])), [100, 2, 'rest'])
    assert.deepEqual(facts(stop('百貨商場', address, ['shopping_mall'])), [150, 4, 'shopping'])
  }
})

test('unknown types preserve previous name hints and generic fallback; broad scenic types do not grant 120 minutes', () => {
  assert.deepEqual(facts(stop('湖畔步道', '', [])), [120, 3, 'open_space'])
  assert.deepEqual(facts(stop('山城印象', '', ['point_of_interest'])), [120, 3, 'open_space'], 'existing name hint, not verified activity depth')
  for (const type of ['tourist_attraction', 'scenic_spot', 'natural_feature']) {
    assert.deepEqual(facts(stop('甲地', '山路1號', [type])), [90, 2, 'main_activity'])
  }
  assert.deepEqual(facts(stop('愛河灣', '', ['natural_feature'])), [90, 2, 'main_activity'], 'do not turn broad outdoor metadata into a longer duration reference')
  assert.equal(getActivityPurpose(stop('愛河灣', '', ['natural_feature'])), 'open_space', 'purpose helper remains unchanged')
})

test('rhythm warnings require venue evidence, not three addresses on mountain roads', () => {
  const input = { startTime: '10:00', endTime: '15:00', tags: ['no_full_meals'] }
  const plan = { stops: ['甲地', '乙地', '丙地'].map(name => stop(name, '中山一路1號')), transportSegments: [] }
  assert.deepEqual(getPlanRhythmIssues(plan, input), [])
  const outdoor = { ...plan, stops: ['登山步道', '河濱草地', '森林公園'].map(name => stop(name)) }
  assert.ok(getPlanRhythmIssues(outdoor, input).some(issue => issue.includes('開放空間/公園類景點過多')))
})

const replay = (mode, kind) => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
  '--import', './tests/unit/register-ts-js-extension-loader.mjs', './tests/unit/fixtures/location-semantics-replay.mjs', mode, kind],
{ encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }))

test('captured repair stage transfers only the nine coverage minutes; safety, long stays and Routes remain valid', t => {
  const before = replay('before', 'repair'), after = replay('after', 'repair')
  const rows = []
  for (const [i, row] of after.entries()) {
    const old = before[i]
    assert.equal(row.name, old.name)
    assert.deepEqual(row.counts, old.counts, row.name)
    assert.deepEqual(row.routeRequests, old.routeRequests, row.name)
    assert.equal(row.actual, old.actual, row.name)
    assert.ok(row.actual >= row.minimum, row.name)
    assert.deepEqual(row.issues, [])
    const durations = p => p.result.plan.stops.map(s => s.duration)
    if (row.name === 'capture-balanced') {
      assert.deepEqual(old.semantics[0], { name: '光之穹頂', reference: 120, weight: 3, role: 'open_space' })
      assert.deepEqual(row.semantics[0], { name: '光之穹頂', reference: 90, weight: 2, role: 'main_activity' })
      assert.deepEqual(durations(old), [99, 60, 60])
      assert.deepEqual(durations(row), [90, 60, 69])
      assert.equal(row.actual, 225)
      const change = row.quality.transitions.find(t => t.phase === 'repair:coverage-existing-activities' && t.coverageAddedMinutes === 9)
      assert.equal(change.changes[0].stopId, 'stop3', 'same repair policy now uses remaining legal room at the next activity')
      const withoutDurations = p => ({ ...p.result, plan: { ...p.result.plan, stops: p.result.plan.stops.map(({ duration, ...s }) => s) } })
      assert.deepEqual(withoutDurations(row), withoutDurations(old))
    } else assert.deepEqual(row.result, old.result, row.name)
    rows.push({ name: row.name, before: durations(old), after: durations(row), actual: row.actual,
      coverage: row.coverage, counts: row.counts, routesIdentical: true })
  }
  t.diagnostic(JSON.stringify({ mockedOpeningHours: true, capturedStageNotFullHistoricalGeneration: true, rows }))
})

test('fixed complete AI flows retain Prompt, candidate selection, events and all external requests', t => {
  const before = replay('before', 'handler'), after = replay('after', 'handler')
  assert.equal(after.length, 21)
  for (const [i, row] of after.entries()) {
    assert.equal(row.kind, before[i].kind)
    assert.deepEqual(row.result, before[i].result, row.kind)
    assert.deepEqual(row.calls, before[i].calls, `${row.kind}: no AI/Places/Routes changes`)
  }
  t.diagnostic(JSON.stringify({ scenarios: after.length, completeResultAndCallsIdentical: true }))
})
