import test from 'node:test'
import assert from 'node:assert/strict'

import { consumeRateLimit, getRequestClientKey, isFiniteCoordinate, isJsonWithinLimit, isRecord } from '../../api/_lib/request-guards.js'

test('request guards validate bounded JSON and coordinates', () => {
  assert.equal(isRecord({ input: {} }), true)
  assert.equal(isRecord([]), false)
  assert.equal(isFiniteCoordinate(0, -90, 90), true)
  assert.equal(isFiniteCoordinate(Number.NaN, -90, 90), false)
  assert.equal(isFiniteCoordinate(181, -90, 90), false)
  assert.equal(isJsonWithinLimit({ value: 'ok' }, 32), true)
  assert.equal(isJsonWithinLimit({ value: 'x'.repeat(100) }, 32), false)
})

test('rate limits requests for the same key during a window and resets later', () => {
  const key = 'test:rate-limit-window-boundary'
  assert.equal(consumeRateLimit(key, 2, 1000, 10_000), true)
  assert.equal(consumeRateLimit(key, 2, 1000, 10_001), true)
  assert.equal(consumeRateLimit(key, 2, 1000, 10_002), false)
  assert.equal(consumeRateLimit(key, 2, 1000, 11_000), true)
})

test('client key prefers platform-provided real IP', () => {
  assert.equal(getRequestClientKey({ headers: { 'x-real-ip': '192.0.2.1' } }), 'ip:192.0.2.1')
})
