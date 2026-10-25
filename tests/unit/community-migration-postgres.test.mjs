import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const migrationPath = fileURLToPath(new URL('../../supabase/migrations/018_preserve_shared_interactions_and_transport.sql', import.meta.url))
const validationPath = fileURLToPath(new URL('../../supabase/migrations/017_shared_trip_validation_and_completion.sql', import.meta.url))
const interactionsPath = fileURLToPath(new URL('../../supabase/migrations/013_community_privacy_controls.sql', import.meta.url))
const paginationPath = fileURLToPath(new URL('../../supabase/migrations/016_community_hardening_and_pagination.sql', import.meta.url))

test('PostgreSQL migration 018 preserves legacy share IDs and interactions while normalizing data', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $$;
      create table public.profiles (id uuid primary key);
      create function public.initialize_user_profile() returns void language sql as $$ select $$;
      create table public.shared_trips (
        id uuid primary key,
        owner_id uuid not null references public.profiles(id),
        author_display_name text not null,
        plan jsonb not null,
        input jsonb,
        tags text[] not null default '{}',
        like_count integer not null default 0,
        created_at timestamptz not null default now()
      );
      create unique index shared_trips_unique_owner_plan_idx
        on public.shared_trips (owner_id, md5(plan::text));
      create table public.shared_trip_likes (
        shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
        user_id uuid not null,
        primary key(shared_trip_id, user_id)
      );
      create table public.shared_trip_comments (
        id uuid primary key default gen_random_uuid(),
        shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
        user_id uuid not null,
        author_display_name text not null,
        body text not null,
        created_at timestamptz not null default now()
      );
      create table public.shared_trip_views (
        shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
        user_id uuid not null,
        primary key(shared_trip_id, user_id)
      );
    `)

    const validatorSql = readFileSync(validationPath, 'utf8')
    const validator = validatorSql.match(/create or replace function public\._is_valid_shared_trip_plan\(p_plan jsonb\)[\s\S]*?\$\$;\s*revoke all on function public\._is_valid_shared_trip_plan\(jsonb\)[^;]*;/i)?.[0]
    assert.ok(validator, 'migration 017 validation function should be available to the 018 upgrade fixture')
    await db.exec(validator)

    const ownerId = '11111111-1111-4111-8111-111111111111'
    await db.query('insert into public.profiles (id) values ($1)', [ownerId])
    const legacyPlan = (variant) => ({
      id: 'same-plan-id', type: 'balanced', title: 'Legacy trip', totalTime: 'bad-number', budget: 500,
      transportMode: 'car', isDetailComplete: true, privatePreference: variant,
      stops: [
        { id: 'old-stop-1', name: 'First stop', type: 'food', duration: 35, lat: 25, lng: 121, googleTypes: { broken: true } },
        { id: 'old-stop-2', name: 'Second stop', type: 'main_activity', duration: 45 },
      ],
      transportSegments: [{ fromStopId: 'old-stop-1', toStopId: 'old-stop-2', mode: 'car', duration: 17.4 }],
      rainBackup: [], rainTransportSegments: [],
    })
    const commenterId = '44444444-4444-4444-8444-444444444444'
    await db.query('insert into public.profiles (id) values ($1)', [commenterId])
    const firstShareId = '22222222-2222-4222-8222-222222222222'
    const secondShareId = '33333333-3333-4333-8333-333333333333'
    await db.query(
      `insert into public.shared_trips (id, owner_id, author_display_name, plan, input, tags, like_count)
       values ($1, $3, 'Traveler', $4::jsonb, '{"private":"input"}', '{}', 1),
              ($2, $3, 'Traveler', $5::jsonb, '{"private":"input"}', '{}', 1)`,
      [firstShareId, secondShareId, ownerId, JSON.stringify(legacyPlan('private-a')), JSON.stringify(legacyPlan('private-b'))],
    )
    await db.query('insert into public.shared_trip_likes (shared_trip_id, user_id) values ($1, $2), ($3, $2)', [firstShareId, commenterId, secondShareId])
    await db.query('insert into public.shared_trip_comments (id, shared_trip_id, user_id, author_display_name, body) values ($1, $2, $3, $4, $5), ($6, $7, $3, $4, $5)', [
      '55555555-5555-4555-8555-555555555555', firstShareId, commenterId, 'Commenter', 'Kept comment',
      '66666666-6666-4666-8666-666666666666', secondShareId,
    ])
    const migrationSql = readFileSync(migrationPath, 'utf8')
    await db.exec(migrationSql)

    const preserved = await db.query(`
      select st.id, st.input, st.plan->>'privatePreference' as private_preference,
        st.plan->'transportSegments'->0->>'duration' as segment_duration,
        (select count(*) from public.shared_trip_likes l where l.shared_trip_id = st.id) as likes,
        (select count(*) from public.shared_trip_comments c where c.shared_trip_id = st.id) as comments
      from public.shared_trips st order by st.id
    `)
    assert.equal(preserved.rows.length, 2)
    assert.deepEqual(preserved.rows.map((row) => row.id).sort(), [firstShareId, secondShareId].sort())
    assert.ok(preserved.rows.every((row) => row.input === null && row.private_preference === null))
    assert.ok(preserved.rows.every((row) => row.segment_duration === '17'))
    assert.ok(preserved.rows.every((row) => Number(row.likes) === 1 && Number(row.comments) === 1))
    assert.equal((await db.query(`select count(*)::int as total from public.shared_trips`)).rows[0].total, 2)

    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ownerId])
    const publicRows = await db.query(`select id, like_count, comment_count from public.shared_trip_feed(null, false, 30, 0, 'newest')`)
    assert.equal(publicRows.rows.length, 2)
    assert.ok(publicRows.rows.every((row) => row.like_count === 1 && row.comment_count === 1))
    const secondPage = await db.query(`select id from public.shared_trip_feed(null, false, 1, 1, 'newest')`)
    assert.equal(secondPage.rows.length, 1)

    const normalizedPlan = await db.query('select plan from public.shared_trips where id = $1', [firstShareId])
    const repeatedShare = await db.query(
      'select public.share_trip($1::jsonb, null, $2::text[]) as id',
      [JSON.stringify(normalizedPlan.rows[0].plan), ['updated-tag']],
    )
    assert.equal(repeatedShare.rows[0].id, firstShareId)
    assert.equal((await db.query('select count(*)::int as total from public.shared_trips')).rows[0].total, 2)

    const interactionSql = readFileSync(interactionsPath, 'utf8')
    const unshare = interactionSql.match(/create or replace function public\.unshare_trip\([\s\S]*?grant execute on function public\.unshare_trip\(uuid\) to authenticated;/i)?.[0]
    const toggleLike = interactionSql.match(/create or replace function public\.toggle_shared_trip_like\([\s\S]*?grant execute on function public\.toggle_shared_trip_like\(uuid\) to authenticated;/i)?.[0]
    const commentSql = readFileSync(paginationPath, 'utf8')
    const addComment = commentSql.match(/create or replace function public\.add_shared_trip_comment\([\s\S]*?grant execute on function public\.add_shared_trip_comment\(uuid, text\) to authenticated;/i)?.[0]
    assert.ok(unshare && toggleLike && addComment, 'existing community interaction RPCs should be present for execution checks')
    await db.exec(`${unshare}\n${toggleLike}\n${addComment}`)
    const likerId = '77777777-7777-4777-8777-777777777777'
    await db.query('insert into public.profiles (id) values ($1)', [likerId])
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [likerId])
    const likeResult = await db.query('select * from public.toggle_shared_trip_like($1)', [firstShareId])
    assert.equal(likeResult.rows[0].liked, true)
    assert.equal(likeResult.rows[0].like_count, 2)
    const newCommenterId = '88888888-8888-4888-8888-888888888888'
    await db.query('insert into public.profiles (id) values ($1)', [newCommenterId])
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [newCommenterId])
    const addedComment = await db.query('select public.add_shared_trip_comment($1, $2) as id', [secondShareId, 'New comment'])
    assert.ok(addedComment.rows[0].id)
    assert.equal((await db.query('select count(*)::int as total from public.shared_trip_comments where shared_trip_id = $1', [secondShareId])).rows[0].total, 2)
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ownerId])
    const unshareResult = await db.query('select public.unshare_trip($1) as removed', [secondShareId])
    assert.equal(unshareResult.rows[0].removed, true)
    assert.equal((await db.query('select count(*)::int as total from public.shared_trips')).rows[0].total, 1)
    assert.equal((await db.query('select count(*)::int as total from public.shared_trip_comments')).rows[0].total, 1)
    assert.equal((await db.query('select count(*)::int as total from public.shared_trip_likes')).rows[0].total, 2)

    const invalidRepeat = await db.query(
      `select public._sanitize_shared_trip_plan($1::jsonb) as plan`,
      [JSON.stringify({ ...legacyPlan('x'), totalTime: 'not numeric', budget: null, stops: null })],
    )
    assert.equal(invalidRepeat.rows[0].plan.totalTime, 0)
    assert.deepEqual(invalidRepeat.rows[0].plan.stops, [])
  } finally {
    await db.close()
  }
})
