import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFavoriteDeleteFilters } from '../../src/services/tripRecords/favoriteDeleteFilters.js'

test('favorite delete skips non-UUID local ids and deletes by fingerprint', () => {
  const recordId = '2026-04-18T10:15:00.000Z-balanced-a1b2c3'
  const userId = 'user-123'
  const fingerprint = JSON.stringify({
    title: 'Old favorite',
    stops: [
      { name: 'Cafe, with comma', address: 'Taipei, Taiwan' },
    ],
  })

  assert.deepEqual(buildFavoriteDeleteFilters(recordId, userId, fingerprint), [
    [
      ['user_id', userId],
      ['kind', 'favorite'],
      ['plan_fingerprint', fingerprint],
    ],
  ])
})

test('favorite delete uses both UUID id and fingerprint when both are available', () => {
  const recordId = '6e827a72-a777-4ad4-854e-4c2aa08c994b'
  const userId = 'user-123'
  const fingerprint = '{"title":"Remote favorite"}'

  assert.deepEqual(buildFavoriteDeleteFilters(recordId, userId, fingerprint), [
    [
      ['user_id', userId],
      ['kind', 'favorite'],
      ['id', recordId],
    ],
    [
      ['user_id', userId],
      ['kind', 'favorite'],
      ['plan_fingerprint', fingerprint],
    ],
  ])
})

test('favorite delete can remove by UUID id when no plan fingerprint is available', () => {
  const recordId = '6e827a72-a777-4ad4-854e-4c2aa08c994b'

  assert.deepEqual(buildFavoriteDeleteFilters(recordId, 'user-123', ''), [
    [
      ['user_id', 'user-123'],
      ['kind', 'favorite'],
      ['id', recordId],
    ],
  ])
})
