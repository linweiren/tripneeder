import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const migration = (name) => readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)), 'utf8')

test('community migrations retain the established 011 to 017 sequence and RPC evolution', () => {
  const m011 = migration('011_community_trip_sharing.sql')
  const m012 = migration('012_community_discussions_and_filters.sql')
  const m013 = migration('013_community_privacy_controls.sql')
  const m014 = migration('014_shared_trip_access_and_privacy.sql')
  const m015 = migration('015_api_rate_limits.sql')
  const m016 = migration('016_community_hardening_and_pagination.sql')
  const m017 = migration('017_shared_trip_validation_and_completion.sql')
  assert.match(m011, /shared_trips_unique_owner_plan_idx/)
  assert.match(m012, /drop function if exists public\.share_trip\(jsonb, jsonb\)/)
  assert.match(m012, /drop function if exists public\.shared_trip_feed\(uuid\)/)
  assert.match(m013, /create or replace function public\.unshare_trip/)
  assert.match(m014, /duplicate_rank > 1[\s\S]*?update public\.shared_trips/)
  assert.match(m015, /create or replace function public\.consume_api_rate_limit/)
  assert.match(m015, /grant execute on function public\.consume_api_rate_limit[\s\S]*to service_role/)
  assert.match(m016, /duplicate_rank > 1[\s\S]*?update public\.shared_trips/)
  assert.match(m017, /_is_valid_shared_trip_plan/)
  assert.match(m017, /where not public\._is_valid_shared_trip_plan/)
  assert.match(m017, /p_input is not null then raise exception/)
  assert.match(m017, /p_plan::text\) > 200000/)
  assert.ok(m017.indexOf('where not public._is_valid_shared_trip_plan') < m017.indexOf('update public.shared_trips'))
  assert.ok(m017.indexOf('duplicate_rank > 1') < m017.indexOf('update public.shared_trips'))
})
