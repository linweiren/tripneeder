-- Make sanitization safe even when old rows contain unexpected JSON types.
create or replace function public._sanitize_shared_trip_plan(p_plan jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', left(coalesce(p_plan->>'id', 'shared-trip'), 80),
    'type', case when p_plan->>'type' in ('safe', 'balanced', 'explore') then p_plan->>'type' else 'balanced' end,
    'title', left(coalesce(p_plan->>'title', '旅人行程'), 120),
    'subtitle', '', 'summary', '',
    'totalTime', case when jsonb_typeof(p_plan->'totalTime') = 'number' then least(10080::numeric, greatest(0::numeric, (p_plan->>'totalTime')::numeric))::integer else 0 end,
    'budget', case when jsonb_typeof(p_plan->'budget') = 'number' then least(100000000::numeric, greatest(0::numeric, (p_plan->>'budget')::numeric))::integer else 0 end,
    'transportMode', case when p_plan->>'transportMode' in ('scooter', 'car', 'public_transit') then p_plan->>'transportMode' else 'car' end,
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-main-' || position,
        'name', left(coalesce(nullif(trim(stop->>'name'), ''), '景點'), 120),
        'type', case when stop->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop->>'type' else 'main_activity' end,
        'description', '', 'address', '',
        'duration', case when jsonb_typeof(stop->'duration') = 'number' then least(1440::numeric, greatest(0::numeric, (stop->>'duration')::numeric))::integer else 0 end
      ) order by position)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'stops') = 'array' then p_plan->'stops' else '[]'::jsonb end) with ordinality as rows(stop, position)
      where position <= 30 and jsonb_typeof(stop) = 'object'
    ), '[]'::jsonb),
    'transportSegments', '[]'::jsonb,
    'rainBackup', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-rain-' || position,
        'name', left(coalesce(nullif(trim(stop->>'name'), ''), '雨備景點'), 120),
        'type', case when stop->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop->>'type' else 'main_activity' end,
        'description', '', 'address', '',
        'duration', case when jsonb_typeof(stop->'duration') = 'number' then least(1440::numeric, greatest(0::numeric, (stop->>'duration')::numeric))::integer else 0 end
      ) order by position)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'rainBackup') = 'array' then p_plan->'rainBackup' else '[]'::jsonb end) with ordinality as rows(stop, position)
      where position <= 20 and jsonb_typeof(stop) = 'object'
    ), '[]'::jsonb),
    'rainTransportSegments', '[]'::jsonb,
    'scheduleStartTime', case when coalesce(p_plan->>'scheduleStartTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then p_plan->>'scheduleStartTime' else null end,
    'isDetailComplete', p_plan->'isDetailComplete' = 'true'::jsonb
  );
$$;

-- Validate the exact contract emitted by _sanitize_shared_trip_plan before a row is public.
create or replace function public._is_valid_shared_trip_plan(p_plan jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_plan is not null
    and jsonb_typeof(p_plan) = 'object'
    and jsonb_typeof(p_plan->'id') is not distinct from 'string'
    and coalesce(length(trim(p_plan->>'id')), 0) between 1 and 80
    and jsonb_typeof(p_plan->'title') is not distinct from 'string'
    and coalesce(length(trim(p_plan->>'title')), 0) between 1 and 120
    and p_plan->>'type' in ('safe', 'balanced', 'explore')
    and p_plan->>'transportMode' in ('scooter', 'car', 'public_transit')
    and jsonb_typeof(p_plan->'isDetailComplete') = 'boolean'
    and p_plan->'isDetailComplete' = 'true'::jsonb
    and jsonb_typeof(p_plan->'budget') = 'number'
    and case when jsonb_typeof(p_plan->'budget') = 'number' then (p_plan->>'budget')::numeric between 0 and 100000000 else false end
    and jsonb_typeof(p_plan->'totalTime') = 'number'
    and case when jsonb_typeof(p_plan->'totalTime') = 'number' then (p_plan->>'totalTime')::numeric between 0 and 10080 else false end
    and case when jsonb_typeof(p_plan->'stops') = 'array' then jsonb_array_length(p_plan->'stops') between 1 and 30 else false end
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_plan->'stops') = 'array' then p_plan->'stops' else '[]'::jsonb end) as rows(stop)
      where jsonb_typeof(stop) is distinct from 'object'
        or jsonb_typeof(stop->'id') is distinct from 'string'
        or coalesce(length(trim(stop->>'id')), 0) not between 1 and 100
        or jsonb_typeof(stop->'name') is distinct from 'string'
        or coalesce(length(trim(stop->>'name')), 0) not between 1 and 120
        or coalesce(stop->>'type', '') not in ('main_activity', 'food', 'ending_or_transition')
        or jsonb_typeof(stop->'duration') is distinct from 'number'
        or case when jsonb_typeof(stop->'duration') = 'number' then (stop->>'duration')::numeric not between 0 and 1440 else true end
    )
    and (not (p_plan ? 'rainBackup') or jsonb_typeof(p_plan->'rainBackup') = 'array')
    and case when jsonb_typeof(p_plan->'rainBackup') = 'array' then jsonb_array_length(p_plan->'rainBackup') <= 20 else not (p_plan ? 'rainBackup') end
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_plan->'rainBackup') = 'array' then p_plan->'rainBackup' else '[]'::jsonb end) as rows(stop)
      where jsonb_typeof(stop) is distinct from 'object'
        or jsonb_typeof(stop->'id') is distinct from 'string'
        or coalesce(length(trim(stop->>'id')), 0) not between 1 and 100
        or jsonb_typeof(stop->'name') is distinct from 'string'
        or coalesce(length(trim(stop->>'name')), 0) not between 1 and 120
        or coalesce(stop->>'type', '') not in ('main_activity', 'food', 'ending_or_transition')
        or jsonb_typeof(stop->'duration') is distinct from 'number'
        or case when jsonb_typeof(stop->'duration') = 'number' then (stop->>'duration')::numeric not between 0 and 1440 else true end
    )
    and case when jsonb_typeof(p_plan->'transportSegments') = 'array' then jsonb_array_length(p_plan->'transportSegments') <= 30 else false end
    and case when jsonb_typeof(p_plan->'rainTransportSegments') = 'array' then jsonb_array_length(p_plan->'rainTransportSegments') <= 30 else false end,
    false);
$$;
revoke all on function public._is_valid_shared_trip_plan(jsonb) from public, anon, authenticated;

-- Remove incomplete or malformed legacy shares. Cascade removes their likes/comments/views.
delete from public.shared_trips
where not public._is_valid_shared_trip_plan(public._sanitize_shared_trip_plan(plan));

-- Resolve any collisions before rewriting plans under the unique owner/content index.
with normalized as (
  select id, row_number() over (
    partition by owner_id, md5(public._sanitize_shared_trip_plan(plan)::text)
    order by created_at, id
  ) as duplicate_rank
  from public.shared_trips
)
delete from public.shared_trips st using normalized n
where st.id = n.id and n.duplicate_rank > 1;

update public.shared_trips
set plan = public._sanitize_shared_trip_plan(plan), input = null;

create or replace function public.share_trip(p_plan jsonb, p_input jsonb default null, p_tags text[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  display_name text := coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), 'TripNeeder 旅人');
  shared_trip_id uuid;
  clean_tags text[];
  safe_plan jsonb;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if p_input is not null then raise exception 'Trip input cannot be shared'; end if;
  if p_plan is null or octet_length(p_plan::text) > 200000
    or not public._is_valid_shared_trip_plan(p_plan) then
    raise exception 'Invalid, incomplete, or oversized public trip plan';
  end if;
  if coalesce(cardinality(p_tags), 0) > 2 or exists (
    select 1 from unnest(coalesce(p_tags, '{}')) as item(tag)
    where tag is null or length(trim(tag)) not between 1 and 20
  ) then raise exception 'Invalid share tags'; end if;
  select coalesce(array_agg(distinct left(trim(tag), 20)), '{}') into clean_tags
  from unnest(coalesce(p_tags, '{}')) as item(tag);
  safe_plan := public._sanitize_shared_trip_plan(p_plan);
  if not public._is_valid_shared_trip_plan(safe_plan) then raise exception 'Invalid sanitized public trip plan'; end if;
  perform public.initialize_user_profile();
  insert into public.shared_trips (owner_id, author_display_name, plan, input, tags)
  values (current_user_id, display_name, safe_plan, null, clean_tags)
  on conflict (owner_id, (md5(plan::text))) do update set plan = excluded.plan, input = null, tags = excluded.tags
  returning id into shared_trip_id;
  return shared_trip_id;
end;
$$;
revoke all on function public.share_trip(jsonb, jsonb, text[]) from public;
grant execute on function public.share_trip(jsonb, jsonb, text[]) to authenticated;
