import test from 'node:test'
import assert from 'node:assert/strict'

import { reverseGeocodeLocationName } from '../../src/services/geocoding.js'

test('reverse geocoding returns a trimmed place name when available', async () => {
  const name = await reverseGeocodeLocationName(25, 121, async () => new Response(JSON.stringify({ name: ' 台北市大安區 ' }), { status: 200 }))
  assert.equal(name, '台北市大安區')
})

test('reverse geocoding failure keeps coordinates usable without a stale name', async () => {
  assert.equal(await reverseGeocodeLocationName(25, 121, async () => new Response('unavailable', { status: 503 })), null)
  assert.equal(await reverseGeocodeLocationName(25, 121, async () => { throw new Error('network unavailable') }), null)
  assert.equal(await reverseGeocodeLocationName(25, 121, async () => new Response(JSON.stringify({ name: 7 }), { status: 200 })), null)
  assert.equal(await reverseGeocodeLocationName(25, 121, async () => new Response(JSON.stringify({ name: '  ' }), { status: 200 })), null)
})
