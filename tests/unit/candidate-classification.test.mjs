import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classificationInput, classificationPlace, mockClassificationSearch,
  loadClassificationBaseline, compareClassificationSearch, snapshotAvailable,
  savedClassificationPipelines, placesFromSavedCandidates,
} from './fixtures/candidate-classification.mjs'

process.env.GOOGLE_PLACES_API_KEY = 'unit-test-only'
process.env.NODE_ENV = 'production'
const after = await import('../../api/_lib/google-places.ts')
const before = await loadClassificationBaseline()

test('museum classification and score do not depend on mountain/park words in administrative addresses', async t => {
  const places = ['高雄市文化路1號', '高雄市鼓山區文化路1號', '臺北市中山區文化路1號',
    '高雄市公園路1號'].map((address, i) => classificationPlace(`museum-${i}`, '地方博物館',
      ['tourist_attraction', 'museum'], address))
  mockClassificationSearch(t, places)
  const result = await compareClassificationSearch(before, after, places, classificationInput())
  assert.deepEqual(result.before.candidates.map(c => c.role), ['main_activity', 'open_space', 'open_space', 'open_space'])
  assert.ok(result.after.candidates.every(c => c.role === 'main_activity' && c.score === 103 && c.indoor))
})

test('broad attraction classification uses venue name, while real parks and mountains keep their outdoor purpose', async t => {
  const places = [
    classificationPlace('park', '中山公園', ['park', 'tourist_attraction']),
    classificationPlace('mountain', '壽山步道', ['tourist_attraction', 'natural_feature']),
    classificationPlace('attraction', '地方觀光展館', ['tourist_attraction'], '高雄市鼓山區公園路1號'),
    classificationPlace('museum-name', '山城博物館', ['tourist_attraction', 'museum']),
    classificationPlace('museum-park', '博物館公園', ['museum', 'park', 'tourist_attraction']),
    classificationPlace('park-name', '愛河之心', ['tourist_attraction', 'park'], '高雄市鼓山區龍德路2號'),
    classificationPlace('memorial-park', '逸仙公園', ['history_museum', 'museum', 'tourist_attraction']),
  ]
  mockClassificationSearch(t, places)
  const { newPool } = await compareClassificationSearch(before, after, places, classificationInput())
  const roles = Object.fromEntries(newPool.allCandidates.map(c => [c.placeId, c.role]))
  assert.deepEqual(roles, { attraction: 'main_activity', 'museum-name': 'main_activity',
    park: 'open_space', mountain: 'open_space', 'museum-park': 'open_space',
    'park-name': 'open_space', 'memorial-park': 'open_space' })
})

test('specific cultural types and an unambiguous cultural name retain activity role despite ancillary food types', async t => {
  const places = [
    classificationPlace('museum-cafe', '地方博物館', ['tourist_attraction', 'museum', 'cafe', 'food']),
    classificationPlace('alien', '金馬賓館當代美術館 ALIEN Art Centre', ['cultural_center', 'museum', 'art_museum', 'restaurant', 'food']),
    classificationPlace('gallery', 'Local Art Gallery', ['art_gallery', 'cafe', 'food']),
  ]
  mockClassificationSearch(t, places)
  const result = await compareClassificationSearch(before, after, places, classificationInput())
  assert.ok(result.before.candidates.every(c => c.role === 'food'))
  assert.ok(result.after.candidates.every(c => c.role === 'main_activity' && c.score === 103 && c.sent))
  for (const original of result.oldPool.allCandidates) {
    const candidate = result.newPool.allCandidates.find(c => c.placeId === original.placeId)
    assert.deepEqual(candidate.types, original.types)
    assert.equal(candidate.foodSubtype, original.foodSubtype)
  }
  // Keep the secondary food evidence; this change does not claim verified meal capability.
  assert.equal(result.newPool.allCandidates.find(c => c.placeId === 'museum-cafe').foodSubtype, 'cafe')
})

test('ambiguous mixed venues and expressly named food businesses do not become cultural activities', async t => {
  const cases = [
    ['museum-cafe', '博物館咖啡廳', ['museum', 'cafe', 'food']],
    ['gallery-restaurant', '美術館餐廳', ['art_gallery', 'restaurant', 'food']],
    ['english-cafe', 'Museum Café', ['museum', 'cafe', 'food']],
    ['ambiguous', '複合生活空間', ['museum', 'restaurant', 'food']],
    ['culture-center', '地方文化中心', ['cultural_center', 'restaurant', 'food']],
    ['restaurant', '在地餐廳', ['restaurant', 'food']],
    ['cafe', '普通咖啡', ['cafe', 'restaurant', 'food']],
    ['dessert', '手作甜點', ['dessert_shop', 'bakery', 'food']],
  ]
  const places = cases.map(([id, name, types]) => classificationPlace(id, name, types))
  mockClassificationSearch(t, places)
  for (const tags of [[], ['food_first']]) {
    const result = await compareClassificationSearch(before, after, places, classificationInput({ tags }))
    assert.deepEqual(result.after, result.before)
    assert.ok(result.after.candidates.every(c => c.role === 'food'))
  }
})

test('explore and food_first reuse the existing score formula without changing ordinary food or outdoor scores', async t => {
  const places = [
    classificationPlace('museum', '地方博物館', ['tourist_attraction', 'museum'], '高雄市鼓山區文化路1號'),
    classificationPlace('mixed', '地方美術館', ['museum', 'restaurant', 'food']),
    classificationPlace('restaurant', '在地餐廳', ['restaurant', 'food']),
    classificationPlace('cafe', '普通咖啡', ['cafe', 'food']),
    classificationPlace('park', '河濱公園', ['park']),
  ]
  mockClassificationSearch(t, places)
  for (const [tags, expected] of [[[], { museum: 103, mixed: 103, restaurant: 103, cafe: 111, park: 95 }],
    [['food_first'], { museum: 103, mixed: 103, restaurant: 119, cafe: 115, park: 95 }],
    [['indoor_first'], { museum: 115, mixed: 115, restaurant: 111, cafe: 119, park: 95 }],
    [['photo_first'], { museum: 103, mixed: 103, restaurant: 103, cafe: 111, park: 101 }]]) {
    const result = await compareClassificationSearch(before, after, places, classificationInput({ tags }))
    assert.deepEqual(Object.fromEntries(result.after.candidates.map(c => [c.placeId, c.score])), expected)
    for (const id of ['restaurant', 'cafe', 'park']) {
      const oldCandidate = result.before.candidates.find(c => c.placeId === id)
      const newCandidate = result.after.candidates.find(c => c.placeId === id)
      assert.equal(newCandidate.role, oldCandidate.role)
      assert.equal(newCandidate.score, oldCandidate.score)
    }
  }
})

test('sparse and late-night food/outdoor pools retain candidates, scores and prompt membership', async t => {
  const places = [classificationPlace('park', '仁武公園', ['park']),
    classificationPlace('cafe', '深夜咖啡', ['cafe', 'food'])]
  mockClassificationSearch(t, places)
  for (const input of [classificationInput(), classificationInput({ startTime: '23:00', endTime: '01:00' })]) {
    const result = await compareClassificationSearch(before, after, places, input)
    assert.deepEqual(result.after, result.before)
    assert.equal(result.after.usable, 2)
    assert.equal(result.after.first, 2)
    // The existing slot filter omits 45-minute food visits from a two-hour
    // window's 40-minute thirds. Classification must not change that policy.
    assert.equal(result.after.prompt, input.startTime === '23:00' ? 1 : 2)
  }
})

test('classification does not relax unknown hours, closing buffer or first-stop distance', async t => {
  const places = [
    classificationPlace('far', '地方博物館', ['tourist_attraction', 'museum'], '高雄市鼓山區文化路1號',
      { location: { latitude: 22.63, longitude: 120.3 } }),
    classificationPlace('unknown', '地方博物館', ['museum'], undefined, { currentOpeningHours: undefined }),
    classificationPlace('closing', '地方博物館', ['museum'], undefined, {
      currentOpeningHours: { periods: [{ open: { day: 0, hour: 10, minute: 0,
        date: { year: 2026, month: 10, day: 4 } }, close: { day: 0, hour: 11, minute: 5,
        date: { year: 2026, month: 10, day: 4 } } }] },
    }),
  ]
  mockClassificationSearch(t, places)
  const { newPool } = await compareClassificationSearch(before, after, places, classificationInput())
  assert.deepEqual(newPool.allCandidates.map(c => c.placeId), ['far'])
  assert.equal(newPool.firstStopCandidates.length, 0)
})

test('saved Central Park usable-candidate replay measures role, score, rank and prompt changes', {
  skip: !snapshotAvailable() && 'Optional preserved local investigation snapshot is unavailable',
}, async t => {
  const pipeline = savedClassificationPipelines().find(p => p.city === '高雄')
  const places = placesFromSavedCandidates(pipeline.candidates)
  const calls = mockClassificationSearch(t, places)
  for (const tags of [[], ['food_first']]) {
    const callStart = calls.length
    const result = await compareClassificationSearch(before, after, places, { ...pipeline.input, tags })
    assert.equal(result.before.usable, 93)
    assert.equal(result.after.usable, 93)
    assert.equal(result.before.first, 19)
    assert.equal(result.after.first, 19)
    assert.equal(result.before.prompt, 42)
    assert.equal(result.after.prompt, 42)
    assert.deepEqual(result.after.groups, result.before.groups)
    assert.equal(calls.length - callStart, 12, 'same six mocked search queries per implementation')
    assert.deepEqual(calls.slice(callStart, callStart + 6), calls.slice(callStart + 6),
      'query bodies and field masks stay unchanged')
    for (const name of ['高雄市立美術館', '舊打狗驛故事館', '金馬賓館當代美術館 ALIEN Art Centre']) {
      const oldCandidate = result.before.candidates.find(c => c.name === name)
      const newCandidate = result.after.candidates.find(c => c.name === name)
      assert.equal(newCandidate.role, 'main_activity')
      assert.ok(newCandidate.eligible)
      assert.equal(newCandidate.score - oldCandidate.score,
        name.startsWith('金馬') ? (tags.length ? -16 : 0) : 8)
    }
    const alien = result.after.candidates.find(c => c.name.startsWith('金馬'))
    assert.ok(alien.sent)
    assert.equal(alien.group, 'mainStops')
    const roleOnly = Object.fromEntries(Object.entries(result.oldPool).map(([key, list]) => [key,
      list.map(c => ({ ...c, role: result.newPool.allCandidates.find(n => n.placeId === c.placeId).role }))]))
    const scoreAndOrderOnly = Object.fromEntries(Object.entries(result.oldPool).map(([key, list]) => [key,
      list.map(c => ({ ...c, score: result.newPool.allCandidates.find(n => n.placeId === c.placeId).score }))
        .sort((a, b) => result.newPool.allCandidates.findIndex(c => c.placeId === a.placeId) -
          result.newPool.allCandidates.findIndex(c => c.placeId === b.placeId))]))
    const roleIds = new Set(before.getPromptCandidateSelection(roleOnly).promptCandidates.map(c => c.placeId))
    const scoreIds = new Set(before.getPromptCandidateSelection(scoreAndOrderOnly).promptCandidates.map(c => c.placeId))
    assert.ok(roleIds.has(alien.placeId), 'ALIEN changes pools without needing a higher score')
    assert.ok(!scoreIds.has(alien.placeId), 'ranking alone does not fix the original food-pool exclusion')
    for (const name of ['高雄市立美術館', '舊打狗驛故事館']) {
      const candidate = result.after.candidates.find(c => c.name === name)
      assert.ok(!roleIds.has(candidate.placeId), 'role-only change still leaves the old low ranking')
      assert.ok(scoreIds.has(candidate.placeId), 'existing formula and ranking explain the improved admission')
    }
    for (const name of ['愛河之心', '內惟埤文化園區']) {
      const oldCandidate = result.before.candidates.find(c => c.name === name)
      const newCandidate = result.after.candidates.find(c => c.name === name)
      assert.equal(newCandidate.role, 'open_space')
      assert.equal(newCandidate.score, oldCandidate.score)
    }
    for (const oldCandidate of result.oldPool.allCandidates.filter(c => c.role === 'food' && !c.name.startsWith('金馬'))) {
      const newCandidate = result.newPool.allCandidates.find(c => c.placeId === oldCandidate.placeId)
      assert.equal(newCandidate.role, oldCandidate.role)
      assert.equal(newCandidate.score, oldCandidate.score)
      assert.equal(newCandidate.foodSubtype, oldCandidate.foodSubtype)
    }
    const brief = summary => ({ ...summary, candidates: summary.candidates.filter(c =>
      ['高雄市立美術館', '舊打狗驛故事館', '金馬賓館當代美術館 ALIEN Art Centre', '哈瑪星台灣鐵道館'].includes(c.name)) })
    t.diagnostic(JSON.stringify({ tags, before: brief(result.before), after: brief(result.after) }))
  }
})
