-- Preserve every existing share and its likes/comments while making public plans safe.
-- This replaces the content-level unique index with a lookup index: legacy duplicate
-- rows may already have interactions tied to their IDs and must not be deleted.
drop index if exists public.shared_trips_unique_owner_plan_idx;
create index if not exists shared_trips_owner_plan_hash_idx
  on public.shared_trips (owner_id, md5(plan::text));

create or replace function public._sanitize_shared_trip_segments(
  p_segments jsonb,
  p_stops jsonb,
  p_prefix text
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'fromStopId', 'shared-' || p_prefix || '-' || from_stop.ordinality,
    'toStopId', 'shared-' || p_prefix || '-' || to_stop.ordinality,
    'mode', segment.value->>'mode',
    'publicTransitType', case
      when segment.value->>'publicTransitType' in ('bus', 'metro', 'train', 'walk', 'mixed')
        then segment.value->>'publicTransitType'
      else null
    end,
    'duration', case
      when jsonb_typeof(segment.value->'duration') = 'number'
        then least(1440::numeric, greatest(0::numeric, (segment.value->>'duration')::numeric))::integer
      else 0
    end,
    'label', case segment.value->>'mode'
      when 'public_transit' then '大眾運輸'
      when 'car' then '開車'
      else '騎乘機車'
    end
  ) order by segment.ordinality), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_segments) = 'array' then p_segments else '[]'::jsonb end)
       with ordinality as segment(value, ordinality)
  join jsonb_array_elements(case when jsonb_typeof(p_stops) = 'array' then p_stops else '[]'::jsonb end)
       with ordinality as from_stop(value, ordinality)
    on from_stop.value->>'id' = segment.value->>'fromStopId'
  join jsonb_array_elements(case when jsonb_typeof(p_stops) = 'array' then p_stops else '[]'::jsonb end)
       with ordinality as to_stop(value, ordinality)
    on to_stop.value->>'id' = segment.value->>'toStopId'
  where segment.ordinality <= 30
    and jsonb_typeof(segment.value) = 'object'
    and segment.value->>'mode' in ('scooter', 'car', 'public_transit')
    and jsonb_typeof(segment.value->'duration') = 'number'
$$;
revoke all on function public._sanitize_shared_trip_segments(jsonb, jsonb, text) from public, anon, authenticated;

-- Keep the frontend and database public allowlist aligned, including transit times.
create or replace function public._sanitize_shared_trip_plan(p_plan jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', left(coalesce(p_plan->>'id', 'shared-trip'), 80),
    'type', case when p_plan->>'type' in ('safe', 'balanced', 'explore') then p_plan->>'type' else 'balanced' end,
    'title', left(coalesce(nullif(trim(p_plan->>'title'), ''), '旅人行程'), 120),
    'subtitle', '',
    'summary', '',
    'totalTime', case when jsonb_typeof(p_plan->'totalTime') = 'number' then least(10080::numeric, greatest(0::numeric, (p_plan->>'totalTime')::numeric))::integer else 0 end,
    'budget', case when jsonb_typeof(p_plan->'budget') = 'number' then least(100000000::numeric, greatest(0::numeric, (p_plan->>'budget')::numeric))::integer else 0 end,
    'transportMode', case when p_plan->>'transportMode' in ('scooter', 'car', 'public_transit') then p_plan->>'transportMode' else 'car' end,
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-main-' || stop.ordinality,
        'name', left(coalesce(nullif(trim(stop.value->>'name'), ''), '景點'), 120),
        'type', case when stop.value->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop.value->>'type' else 'main_activity' end,
        'description', '',
        'address', '',
        'duration', case when jsonb_typeof(stop.value->'duration') = 'number' then least(1440::numeric, greatest(0::numeric, (stop.value->>'duration')::numeric))::integer else 0 end,
        'googleTypes', coalesce((
          select jsonb_agg(to_jsonb(google_type.value) order by google_type.ordinality)
          from jsonb_array_elements_text(case when jsonb_typeof(stop.value->'googleTypes') = 'array' then stop.value->'googleTypes' else '[]'::jsonb end)
               with ordinality as google_type(value, ordinality)
          where google_type.ordinality <= 12 and google_type.value ~ '^[a-zA-Z0-9_]{1,50}$'
        ), '[]'::jsonb),
        'candidateRole', case when stop.value->>'candidateRole' in ('food', 'main_activity', 'open_space', 'shopping', 'short_visit') then stop.value->>'candidateRole' else null end,
        'foodSubtype', case when stop.value->>'foodSubtype' in ('cafe', 'dessert', 'restaurant', 'snack') then stop.value->>'foodSubtype' else null end
      ) order by stop.ordinality)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'stops') = 'array' then p_plan->'stops' else '[]'::jsonb end)
           with ordinality as stop(value, ordinality)
      where stop.ordinality <= 30 and jsonb_typeof(stop.value) = 'object'
    ), '[]'::jsonb),
    'transportSegments', public._sanitize_shared_trip_segments(p_plan->'transportSegments', p_plan->'stops', 'main'),
    'rainBackup', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-rain-' || stop.ordinality,
        'name', left(coalesce(nullif(trim(stop.value->>'name'), ''), '雨備景點'), 120),
        'type', case when stop.value->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop.value->>'type' else 'main_activity' end,
        'description', '',
        'address', '',
        'duration', case when jsonb_typeof(stop.value->'duration') = 'number' then least(1440::numeric, greatest(0::numeric, (stop.value->>'duration')::numeric))::integer else 0 end,
        'googleTypes', coalesce((
          select jsonb_agg(to_jsonb(google_type.value) order by google_type.ordinality)
          from jsonb_array_elements_text(case when jsonb_typeof(stop.value->'googleTypes') = 'array' then stop.value->'googleTypes' else '[]'::jsonb end)
               with ordinality as google_type(value, ordinality)
          where google_type.ordinality <= 12 and google_type.value ~ '^[a-zA-Z0-9_]{1,50}$'
        ), '[]'::jsonb),
        'candidateRole', case when stop.value->>'candidateRole' in ('food', 'main_activity', 'open_space', 'shopping', 'short_visit') then stop.value->>'candidateRole' else null end,
        'foodSubtype', case when stop.value->>'foodSubtype' in ('cafe', 'dessert', 'restaurant', 'snack') then stop.value->>'foodSubtype' else null end
      ) order by stop.ordinality)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'rainBackup') = 'array' then p_plan->'rainBackup' else '[]'::jsonb end)
           with ordinality as stop(value, ordinality)
      where stop.ordinality <= 20 and jsonb_typeof(stop.value) = 'object'
    ), '[]'::jsonb),
    'rainTransportSegments', public._sanitize_shared_trip_segments(p_plan->'rainTransportSegments', p_plan->'rainBackup', 'rain'),
    'scheduleStartTime', case when jsonb_typeof(p_plan->'scheduleStartTime') = 'string' and p_plan->>'scheduleStartTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then p_plan->>'scheduleStartTime' else null end,
    'isDetailComplete', jsonb_typeof(p_plan->'isDetailComplete') = 'boolean' and p_plan->'isDetailComplete' = 'true'::jsonb
  );
$$;
revoke all on function public._sanitize_shared_trip_plan(jsonb) from public, anon, authenticated;

-- Normalize private/unknown fields in place. No shared-trip row is deleted, so
-- existing share IDs and their likes, comments, views, and reports remain intact.
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
  if p_plan is null or octet_length(p_plan::text) > 200000 or not public._is_valid_shared_trip_plan(p_plan) then
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

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text || ':shared-trips', 0));
  perform public.initialize_user_profile();
  select id into shared_trip_id
  from public.shared_trips
  where owner_id = current_user_id and plan = safe_plan
  order by created_at, id
  limit 1
  for update;

  if shared_trip_id is not null then
    update public.shared_trips set tags = clean_tags where id = shared_trip_id;
    return shared_trip_id;
  end if;

  insert into public.shared_trips (owner_id, author_display_name, plan, input, tags)
  values (current_user_id, display_name, safe_plan, null, clean_tags)
  returning id into shared_trip_id;
  return shared_trip_id;
end;
$$;
revoke all on function public.share_trip(jsonb, jsonb, text[]) from public;
grant execute on function public.share_trip(jsonb, jsonb, text[]) to authenticated;

-- Keep incomplete legacy rows private/inaccessible without deleting their history.
create or replace function public.shared_trip_feed(
  p_trip_id uuid default null,
  p_owner_only boolean default false,
  p_limit integer default 30,
  p_offset integer default 0,
  p_sort text default 'newest'
)
returns table (
  id uuid, plan jsonb, input jsonb, tags text[], author_display_name text, created_at timestamptz,
  like_count integer, comment_count integer, view_count integer, liked_by_me boolean,
  is_owner boolean
)
language sql stable security definer set search_path = public
as $$
  select st.id, st.plan, null::jsonb, st.tags, st.author_display_name, st.created_at,
    st.like_count,
    (select count(*)::integer from public.shared_trip_comments c where c.shared_trip_id = st.id),
    (select count(*)::integer from public.shared_trip_views v where v.shared_trip_id = st.id),
    exists (select 1 from public.shared_trip_likes l where l.shared_trip_id = st.id and l.user_id = auth.uid()),
    st.owner_id = auth.uid()
  from public.shared_trips st
  where (p_trip_id is null or st.id = p_trip_id)
    and (not p_owner_only or st.owner_id = auth.uid())
    and public._is_valid_shared_trip_plan(st.plan)
  order by
    case when p_sort = 'likes' then st.like_count end desc nulls last,
    case when p_sort = 'discussion' then
      (select count(*) from public.shared_trip_comments c where c.shared_trip_id = st.id) * 2 + st.like_count
    end desc nulls last,
    st.created_at desc, st.id desc
  limit least(100, greatest(1, coalesce(p_limit, 30))) offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.shared_trip_feed(uuid, boolean, integer, integer, text) from public;
grant execute on function public.shared_trip_feed(uuid, boolean, integer, integer, text) to anon, authenticated;
