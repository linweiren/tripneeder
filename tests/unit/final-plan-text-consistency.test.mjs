import test from 'node:test'
import assert from 'node:assert/strict'
import { assessRemovedPlaceReference, finalizePlanText, rememberPlanTextTransition } from '../../api/_lib/trip-plan-text-consistency.ts'

const stop = (name, placeId = name) => ({ id: 'cafe', name, placeId, type: 'food',
  duration: 60, description: '', address: '固定地址' })
const plan = (name = '眷鳥咖啡商行', text = {}) => ({ id: 'safe', type: 'safe', title: '眷鳥咖啡商行小旅行',
  subtitle: '按自己的步調出遊', summary: '在眷鳥咖啡商行喝咖啡，再沿途散步。', budget: 300, totalTime: 60,
  transportMode: 'scooter', stops: [stop(name)], transportSegments: [], rainBackup: [], rainTransportSegments: [], ...text })
const withoutText = ({ title, subtitle, summary, ...rest }) => rest

test('眷鳥咖啡商行 → 草圖咖啡：只替換確認錯誤的欄位，不把咖啡敘述套給新站', () => {
  const source = plan(), final = rememberPlanTextTransition(source, { ...source, stops: [stop('草圖咖啡')] })
  const frozen = structuredClone(final), result = finalizePlanText(final)
  assert.equal(result.title, '保守方案')
  assert.equal(result.subtitle, source.subtitle)
  assert.equal(result.summary, '依下方地點與順序展開行程，各站安排可查看詳細資訊。')
  assert.doesNotMatch(result.summary, /眷鳥|草圖|喝咖啡|文化|供餐|午餐/)
  assert.deepEqual(withoutText(result), withoutText(final))
  assert.strictEqual(result.stops, final.stops)
  assert.deepEqual(final, frozen)
  assert.strictEqual(finalizePlanText(result), result)
})

for (const field of ['title', 'subtitle', 'summary']) test(`only the stale ${field} changes`, () => {
  const source = plan('眷鳥咖啡商行', { title: '安排行程', subtitle: '沿途走走', summary: '查看各站安排', [field]: '先到眷鳥咖啡商行。' })
  const final = rememberPlanTextTransition(source, { ...source, stops: [stop('地方文物館')] })
  const result = finalizePlanText(final)
  for (const other of ['title', 'subtitle', 'summary'].filter(k => k !== field)) assert.equal(result[other], source[other])
  assert.notEqual(result[field], source[field])
  assert.doesNotMatch(result[field], /咖啡|文物館|文化|用餐/)
})

test('fallback restores original venue: keep all original correct prose', () => {
  const original = plan(), changed = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] })
  const restored = rememberPlanTextTransition(changed, { ...original })
  assert.strictEqual(finalizePlanText(restored), restored)
})

test('duration/order/route changes without removed names preserve prose', () => {
  const original = plan(), changed = rememberPlanTextTransition(original, { ...original, totalTime: 75,
    stops: original.stops.map(s => ({ ...s, duration: 75 })) })
  assert.strictEqual(finalizePlanText(changed), changed)
})

test('unreferenced retired names and unrecorded candidates do not trigger', () => {
  const original = plan('眷鳥咖啡商行', { title: '城市走走', summary: '這次想去看海。' })
  const changed = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] })
  assert.strictEqual(finalizePlanText(changed), changed)
  const unrecorded = plan('草圖咖啡')
  assert.strictEqual(finalizePlanText(unrecorded), unrecorded)
})

for (const [old, current, text] of [
  ['鳥咖啡', '眷鳥咖啡商行', '在眷鳥咖啡商行休息。'],
  ['眷鳥咖啡', '眷鳥咖啡二店', '在眷鳥咖啡二店休息。'],
  ['Art', 'Party', 'Party time'],
  ['眷鳥咖啡商行', '草圖咖啡', '眷鳥類自然觀察'],
  ['原咖啡', '其他地點', '自然咖啡色的街景'],
  ['文化', '河畔公園', '欣賞沿途文化體驗'],
]) test(`partial names are not proof: ${old}/${current}/${text}`, () => {
  const original = plan(old, { title: '城市走走', summary: text })
  const changed = rememberPlanTextTransition(original, { ...original, stops: [stop(current)] })
  assert.strictEqual(finalizePlanText(changed), changed)
})

test('a shorter retained venue does not hide the explicitly removed longer name', () => {
  const original = plan(), changed = rememberPlanTextTransition(original, { ...original, stops: [stop('眷鳥咖啡')] })
  assert.equal(finalizePlanText(changed).title, '保守方案')
})

test('full quoted Latin name, case normalization and regex characters are literal', () => {
  const original = plan('A+B Cafe', { title: '在「A+B CAFE」休息', summary: '城市走走' })
  const changed = rememberPlanTextTransition(original, { ...original, stops: [stop('Other Cafe')] })
  assert.equal(finalizePlanText(changed).title, '保守方案')
})

test('each style and its same-ID history are independent', () => {
  for (const [type, title] of [['safe', '保守方案'], ['balanced', '平衡方案'], ['explore', '探索方案']]) {
    const source = plan('眷鳥咖啡商行', { id: type, type })
    const final = rememberPlanTextTransition(source, { ...source, stops: [stop('草圖咖啡')] })
    assert.equal(finalizePlanText(final).title, title)
  }
  const separate = plan('草圖咖啡')
  assert.strictEqual(finalizePlanText(separate), separate)
})

test('names selected in intermediate stages remain traceable after removal', () => {
  const original = plan('起站', { title: '逐站走走', summary: '到眷鳥咖啡商行休息。' })
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] }, [stop('眷鳥咖啡商行')])
  assert.notEqual(finalizePlanText(final).summary, original.summary)
})

test('a stage retains the name history of its earlier selected transitions', () => {
  const original = plan('起站', { title: '逐站走走', summary: '到眷鳥咖啡商行休息。' })
  const middle = rememberPlanTextTransition(original, { ...original, stops: [stop('眷鳥咖啡商行')] })
  const later = rememberPlanTextTransition(middle, { ...middle, stops: [stop('草圖咖啡')] })
  const final = rememberPlanTextTransition(structuredClone(original), { ...later }, later)
  assert.notEqual(finalizePlanText(final).summary, original.summary)
})

test('retained venues at another index or in rain backup are not removed identities', () => {
  const original = plan(), final = rememberPlanTextTransition(original, { ...original,
    stops: [stop('草圖咖啡')], rainBackup: original.stops })
  assert.strictEqual(finalizePlanText(final), final)
})

test('rain backup removed at detail validation has its own final text check', () => {
  const original = plan('草圖咖啡', { title: '逐站走走', summary: '雨天到眷鳥咖啡商行休息。', rainBackup: [stop('眷鳥咖啡商行')] })
  const final = rememberPlanTextTransition(original, { ...original, rainBackup: [] })
  assert.notEqual(finalizePlanText(final).summary, original.summary)
})

for (const [oldName, text] of [
  ['藝術館', '欣賞藝術館藏。'],
  ['新港咖啡館', '在新港喝咖啡，再沿途散步。'],
  ['新港', '到新港休息。'],
  ['眷鳥咖啡商行', '在眷鳥喝咖啡，再沿途散步。'],
  ['眷鳥咖啡商行', '眷鳥咖啡商行業者的經營故事。'],
  ['眷鳥咖啡商行', '不去眷鳥咖啡商行，改去草圖咖啡。'],
  ['眷鳥咖啡商行', '以前在眷鳥咖啡商行喝咖啡。'],
  ['眷鳥咖啡商行', '在眷鳥咖啡商行喝咖啡，是原本的安排。'],
  ['眷鳥咖啡商行', '如果在眷鳥咖啡商行喝咖啡，就延後出發。'],
  ['眷鳥咖啡商行', '在眷鳥咖啡商行附近休息。'],
  ['眷鳥咖啡商行', '「眷鳥咖啡商行」是一段歷史。'],
  ['地方藝術館', '到地方藝術館參觀。'],
  ['地方藝術館', '欣賞地方藝術館藏。'],
  ['咖啡館', '到咖啡館休息。'],
  ['美術館', '美術館'],
  ['明亮咖啡館', '明亮咖啡館'],
  ['明亮咖啡館', '在明亮咖啡館休息。'],
  ['新港咖啡館', '在新港咖啡館休息。'],
]) test(`unresolved entity reference preserves all prose: ${oldName}/${text}`, () => {
  const original = plan(oldName, { title: '城市走走', summary: text })
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] })
  assert.equal(assessRemovedPlaceReference(text, original.stops[0], final.stops), 'unresolved')
  assert.strictEqual(finalizePlanText(final), final)
})

test('even a complete name without historical identity evidence is unresolved', () => {
  const original = plan()
  delete original.stops[0].placeId
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] })
  assert.equal(assessRemovedPlaceReference(original.summary, original.stops[0], final.stops), 'unresolved')
  assert.strictEqual(finalizePlanText(final), final)
})

test('same placeId with a different official name is still retained, not proof of removal', () => {
  const original = plan()
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('新的正式店名', original.stops[0].placeId)] })
  assert.equal(assessRemovedPlaceReference(original.summary, original.stops[0], final.stops), 'retained')
  assert.strictEqual(finalizePlanText(final), final)
})

test('incomplete final identity evidence cannot confirm removal of the old venue', () => {
  const original = plan(), replacement = stop('草圖咖啡')
  delete replacement.placeId
  const final = rememberPlanTextTransition(original, { ...original, stops: [replacement] })
  assert.equal(assessRemovedPlaceReference(original.summary, original.stops[0], final.stops), 'unresolved')
  assert.strictEqual(finalizePlanText(final), final)
})

test('same-name venue at another placeId cannot prove a stale reference', () => {
  const original = plan()
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('眷鳥咖啡商行', 'another-branch')] })
  assert.equal(assessRemovedPlaceReference(original.summary, original.stops[0], final.stops), 'retained')
  assert.strictEqual(finalizePlanText(final), final)
})

test('full quoted venue name in a closed affirmative destination statement is confirmed', () => {
  const original = plan('眷鳥咖啡商行', { summary: '先到「眷鳥咖啡商行」休息。' })
  const final = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡')] })
  assert.equal(assessRemovedPlaceReference(original.summary, original.stops[0], final.stops), 'confirmed')
  assert.notEqual(finalizePlanText(final).summary, original.summary)
})

test('multiple replacements preserve the final restored identity and repair only a removed identity', () => {
  const original = plan('眷鳥咖啡商行', { title: '眷鳥咖啡商行小旅行', summary: '到「草圖咖啡館」休息。' })
  const middle = rememberPlanTextTransition(original, { ...original, stops: [stop('草圖咖啡館')] })
  const restored = rememberPlanTextTransition(middle, { ...original })
  const result = finalizePlanText(restored)
  assert.equal(result.title, original.title)
  assert.notEqual(result.summary, original.summary)
  assert.deepEqual(withoutText(result), withoutText(restored))
})
