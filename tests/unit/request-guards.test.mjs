import test from 'node:test'
import assert from 'node:assert/strict'

import { consumeApiRateLimit, consumeRateLimit, getRequestClientKey, hasValidCoordinatePair, isFiniteCoordinate, isJsonWithinLimit, isRecord, isValidTripLocation } from '../../api/_lib/request-guards.js'

test('request guards validate bounded JSON and coordinates', () => {
  assert.equal(isRecord({ input: {} }), true)
  assert.equal(isRecord([]), false)
  assert.equal(isFiniteCoordinate(0, -90, 90), true)
  assert.equal(isFiniteCoordinate(Number.NaN, -90, 90), false)
  assert.equal(isFiniteCoordinate(181, -90, 90), false)
  assert.equal(isJsonWithinLimit({ value: 'ok' }, 32), true)
  assert.equal(isJsonWithinLimit({ value: 'x'.repeat(100) }, 32), false)
})

test('valid GPS coordinates allow a blank place name while lookup is pending', () => {
  assert.equal(isValidTripLocation({ name: '', lat: 25.03, lng: 121.56 }), true)
  assert.equal(isValidTripLocation({ name: '   ', lat: 0, lng: 0 }), true)
  assert.equal(hasValidCoordinatePair(0, 0), true)
  assert.equal(isValidTripLocation({ name: '', lat: 25.03 }), false)
  assert.equal(isValidTripLocation({ name: '', lat: Number.NaN, lng: 121.56 }), false)
  assert.equal(isValidTripLocation({ name: '' }), false)
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

test('production rate limiting uses a bounded local fallback when the durable store is unavailable', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousUrl = process.env.SUPABASE_URL
  const previousViteUrl = process.env.VITE_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const previousFetch = globalThis.fetch
  try {
    process.env.NODE_ENV = 'production'
    delete process.env.SUPABASE_URL
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    assert.equal(await consumeApiRateLimit('test:production-store-missing', 1, 1000), 'allowed')
    assert.equal(await consumeApiRateLimit('test:production-store-missing', 1, 1000), 'limited')

    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    assert.equal(await consumeApiRateLimit('test:production-store-error', 1, 1000), 'allowed')
    assert.equal(await consumeApiRateLimit('test:production-store-error', 1, 1000), 'limited')

    globalThis.fetch = async () => new Response('null', { status: 200 })
    assert.equal(await consumeApiRateLimit('test:production-store-malformed', 1, 1000), 'allowed')
    assert.equal(await consumeApiRateLimit('test:production-store-malformed', 1, 1000), 'limited')
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = previousUrl
    if (previousViteUrl === undefined) delete process.env.VITE_SUPABASE_URL
    else process.env.VITE_SUPABASE_URL = previousViteUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
    globalThis.fetch = previousFetch
  }
})
