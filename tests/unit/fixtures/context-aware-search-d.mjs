import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { searchFixture, candidateFacts, searchSummary } from './context-aware-search.mjs'

export const dFixture = JSON.parse(fs.readFileSync(new URL('./context-aware-search-d.json', import.meta.url), 'utf8'))

function responseFor(row, body, index) {
  const key = `${body.textQuery}|${body.locationBias?.circle.radius ?? 'none'}`
  if (Object.hasOwn(row.bodyOverrides ?? {}, key)) return row.bodyOverrides[key]
  if (Object.hasOwn(row.overrides ?? {}, body.textQuery)) return row.overrides[body.textQuery]
  if (row.places) return row.places
  if (searchFixture.snapshots[row.environment]) {
    const saved = searchFixture.snapshots[row.environment]
    return Array.from({ length: Math.min(20, saved.length) }, (_, offset) => saved[(index * 20 + offset) % saved.length])
  }
  const dict = searchFixture.places[row.environment]
  const recorded = searchFixture.responses[row.environment][body.textQuery]
  if (recorded) return recorded.map(id => dict[id])
  const g = dFixture.groups[row.environment]
  const raw = ids => ids.map(id => dict[id])
  const q = body.textQuery
  if (q.includes('在地美食')) return raw(g.meal)
  if (q.includes('博物館 展覽 藝文')) return raw(g.culture)
  if (q.includes('商場 百貨')) return raw(g.mall)
  if (q.includes('附近景點') || q.includes('nearby attractions')) {
    const first = row.input.category === 'other' ? `fixture attractions${row.input.tags.includes('food_first') ? ' gourmet' : ''}`
      : 'fixture sightseeing attractions museums landmarks'
    return responseFor({ ...row, overrides: {} }, { ...body, textQuery: first }, index)
  }
  if (q.includes('餐廳 咖啡 甜點')) return raw([...g.meal, ...g.cafe]).slice(0, 20)
  if (q.includes('室內景點')) return raw([...g.culture, ...g.mall]).slice(0, 20)
  if (q.includes('有遮蔽景點')) return raw([...g.cafe, ...g.book]).slice(0, 20)
  if (q.includes('營業中 景點') || q.includes('深夜') || q.includes('23:00') || q.includes('24 hours') || q.includes('清晨')) return []
  throw Error(`Unmapped fixed query: ${row.id}/${q}`)
}

export function createDReplay(t, row) {
  let current
  t.mock.timers.enable({ apis: ['Date'], now: new Date(searchFixture.fixedClock).getTime() })
  t.mock.method(console, 'info', (...args) => {
    if (args[0] === '[candidate-search-cost]') current.costs.push(args[1])
  })
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', () => { throw Error('Forbidden external fetch') })
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(String(url), 'https://places.googleapis.com/v1/places:searchText', 'No external endpoint may escape the mock')
    let text = ''
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.write = value => { text += value }
    req.destroy = error => req.emit('error', error)
    req.end = () => queueMicrotask(() => {
      const body = JSON.parse(text)
      const radius = body.locationBias?.circle.radius
      const stage = current.stage === 'supplement' ? 'supplement' : current.stage === 'initial' ? 'initial' : radius === 2000 ? 'first_stop' : 'gap'
      const index = current.requests.length
      current.requests.push({ stage, body, mask: options.headers['x-goog-fieldmask'] })
      if (stage === 'supplement' && row.supplementError) {
        current.requests.at(-1).ids = []
        req.emit('error', Error('Mock timeout; no retry allowed'))
        return
      }
      const places = row.responder ? row.responder(body, stage, index) : responseFor(row, body, index)
      assert.ok(places.length <= 20)
      current.requests.at(-1).ids = places.map(p => p.id)
      const res = new EventEmitter()
      res.statusCode = stage === 'supplement' && row.httpFailure ? 503 : 200
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from(JSON.stringify({ places })))
      res.emit('end')
    })
    return req
  })
  return async (api, profile) => {
    current = { stage: 'initial', requests: [], plans: [], pools: [], costs: [] }
    const pool = await api.getNearbyPlaceCandidates({ input: structuredClone(row.input) }, {
      recordQueryPlan(plan) {
        current.stage = plan.queryLimit === 1 ? 'supplement' : plan.phase
        current.plans.push(plan)
      }, recordQueryResult() {}, recordCandidatePool(snapshot) { current.pools.push(snapshot) },
    }, { preferenceProfile: profile })
    return { pool, facts: candidateFacts(pool), summary: searchSummary(api, pool, row.input), ...current }
  }
}
