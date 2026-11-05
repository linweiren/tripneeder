-- Build a public-only plan from an explicit allowlist. Unknown fields and all free text
-- except the trip title and public stop names are discarded.
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
    'totalTime', least(10080, greatest(0, coalesce((p_plan->>'totalTime')::integer, 0))),
    'budget', least(100000000, greatest(0, coalesce((p_plan->>'budget')::integer, 0))),
    'transportMode', case when p_plan->>'transportMode' in ('scooter', 'car', 'public_transit') then p_plan->>'transportMode' else 'car' end,
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-main-' || position,
        'name', left(coalesce(stop->>'name', '景點'), 120),
        'type', case when stop->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop->>'type' else 'main_activity' end,
        'description', '', 'address', '',
        'duration', least(1440, greatest(0, coalesce((stop->>'duration')::integer, 0)))
      ) order by position)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'stops') = 'array' then p_plan->'stops' else '[]'::jsonb end)
        with ordinality as rows(stop, position)
      where position <= 30 and jsonb_typeof(stop) = 'object'
    ), '[]'::jsonb),
    'transportSegments', '[]'::jsonb,
    'rainBackup', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', 'shared-rain-' || position,
        'name', left(coalesce(stop->>'name', '雨備景點'), 120),
        'type', case when stop->>'type' in ('main_activity', 'food', 'ending_or_transition') then stop->>'type' else 'main_activity' end,
        'description', '', 'address', '',
        'duration', least(1440, greatest(0, coalesce((stop->>'duration')::integer, 0)))
      ) order by position)
      from jsonb_array_elements(case when jsonb_typeof(p_plan->'rainBackup') = 'array' then p_plan->'rainBackup' else '[]'::jsonb end)
        with ordinality as rows(stop, position)
      where position <= 20 and jsonb_typeof(stop) = 'object'
    ), '[]'::jsonb),
    'rainTransportSegments', '[]'::jsonb,
    'scheduleStartTime', case when coalesce(p_plan->>'scheduleStartTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then p_plan->>'scheduleStartTime' else null end,
    'isDetailComplete', coalesce((p_plan->>'isDetailComplete')::boolean, false)
  );
$$;
revoke all on function public._sanitize_shared_trip_plan(jsonb) from public, anon, authenticated;

-- Normalize historic public plans and remove shares that collapse to the same safe content.
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
  if p_plan is null or jsonb_typeof(p_plan) <> 'object'
    or jsonb_typeof(p_plan->'stops') is distinct from 'array'
    or jsonb_typeof(p_plan->'budget') is distinct from 'number'
    or jsonb_typeof(p_plan->'title') is distinct from 'string'
    or octet_length(p_plan::text) > 200000 then
    raise exception 'Invalid trip plan or plan exceeds 200 KB';
  end if;
  if p_input is not null then raise exception 'Trip input cannot be shared'; end if;
  if coalesce(cardinality(p_tags), 0) > 2 then raise exception 'At most two tags are allowed'; end if;
  if exists (select 1 from unnest(coalesce(p_tags, '{}')) as item(tag) where length(trim(tag)) = 0 or length(trim(tag)) > 20) then
    raise exception 'Tags must contain 1 to 20 characters';
  end if;
  select coalesce(array_agg(distinct left(trim(tag), 20)), '{}') into clean_tags
  from unnest(coalesce(p_tags, '{}')) as item(tag);
  safe_plan := public._sanitize_shared_trip_plan(p_plan);
  perform public.initialize_user_profile();
  insert into public.shared_trips (owner_id, author_display_name, plan, input, tags)
  values (current_user_id, display_name, safe_plan, null, clean_tags)
  on conflict (owner_id, (md5(plan::text))) do update set input = null, plan = excluded.plan, tags = excluded.tags
  returning id into shared_trip_id;
  return shared_trip_id;
end;
$$;
revoke all on function public.share_trip(jsonb, jsonb, text[]) from public;
grant execute on function public.share_trip(jsonb, jsonb, text[]) to authenticated;

drop function if exists public.shared_trip_feed(uuid, boolean);
create function public.shared_trip_feed(
  p_trip_id uuid default null,
  p_owner_only boolean default false,
  p_limit integer default 30,
  p_offset integer default 0,
  p_sort text default 'newest'
)
returns table (
  id uuid, plan jsonb, input jsonb, tags text[], author_display_name text, created_at timestamptz,
  like_count integer, comment_count integer, view_count integer, liked_by_me boolean,
  reward_awarded boolean, is_owner boolean
)
language sql stable security definer set search_path = public
as $$
  select st.id, st.plan, null::jsonb, st.tags, st.author_display_name, st.created_at,
    st.like_count,
    (select count(*)::integer from public.shared_trip_comments c where c.shared_trip_id = st.id),
    (select count(*)::integer from public.shared_trip_views v where v.shared_trip_id = st.id),
    exists (select 1 from public.shared_trip_likes l where l.shared_trip_id = st.id and l.user_id = auth.uid()),
    false, st.owner_id = auth.uid()
  from public.shared_trips st
  where (p_trip_id is null or st.id = p_trip_id) and (not p_owner_only or st.owner_id = auth.uid())
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

drop function if exists public.shared_trip_comments_feed(uuid);
create function public.shared_trip_comments_feed(p_trip_id uuid, p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, author_display_name text, body text, created_at timestamptz, is_mine boolean)
language sql stable security definer set search_path = public
as $$
  select page.id, page.author_display_name, page.body, page.created_at, page.is_mine
  from (
    select c.id, c.author_display_name, c.body, c.created_at, c.user_id = auth.uid() as is_mine
    from public.shared_trip_comments c where c.shared_trip_id = p_trip_id
    order by c.created_at desc, c.id desc
    limit least(101, greatest(1, coalesce(p_limit, 50))) offset greatest(0, coalesce(p_offset, 0))
  ) page
  order by page.created_at asc, page.id asc;
$$;
revoke all on function public.shared_trip_comments_feed(uuid, integer, integer) from public;
grant execute on function public.shared_trip_comments_feed(uuid, integer, integer) to anon, authenticated;

-- A serialized per-user check prevents simultaneous requests bypassing comment frequency limits.
create or replace function public.add_shared_trip_comment(p_trip_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  display_name text := coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), 'TripNeeder 旅人');
  clean_body text := trim(coalesce(p_body, ''));
  comment_id uuid;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if length(clean_body) = 0 or length(clean_body) > 500 then raise exception 'Comment must contain 1 to 500 characters'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text || ':comments', 0));
  if (select count(*) from public.shared_trip_comments where user_id = current_user_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception '留言太頻繁，請稍後再試。';
  end if;
  perform public.initialize_user_profile();
  insert into public.shared_trip_comments (shared_trip_id, user_id, author_display_name, body)
  select p_trip_id, current_user_id, display_name, clean_body
  where exists (select 1 from public.shared_trips where id = p_trip_id)
  returning id into comment_id;
  if comment_id is null then raise exception 'Shared trip not found'; end if;
  return comment_id;
end;
$$;
revoke all on function public.add_shared_trip_comment(uuid, text) from public;
grant execute on function public.add_shared_trip_comment(uuid, text) to authenticated;

create table if not exists public.shared_trip_comment_reports (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.shared_trip_comments(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('spam', 'harassment', 'private_info', 'other')),
  created_at timestamptz not null default now(),
  unique (comment_id, reporter_id)
);
create index if not exists shared_trip_comment_reports_created_idx on public.shared_trip_comment_reports (created_at desc);
alter table public.shared_trip_comment_reports enable row level security;
revoke all on public.shared_trip_comment_reports from anon, authenticated;

create or replace function public.report_shared_trip_comment(p_comment_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if p_reason not in ('spam', 'harassment', 'private_info', 'other') then raise exception 'Invalid report reason'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text || ':reports', 0));
  if (select count(*) from public.shared_trip_comment_reports where reporter_id = current_user_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception '檢舉太頻繁，請稍後再試。';
  end if;
  insert into public.shared_trip_comment_reports (comment_id, reporter_id, reason)
  select c.id, current_user_id, p_reason from public.shared_trip_comments c
  where c.id = p_comment_id and c.user_id <> current_user_id
  on conflict (comment_id, reporter_id) do nothing;
  if not found then raise exception '留言不存在或無法檢舉自己的留言'; end if;
  return true;
end;
$$;
revoke all on function public.report_shared_trip_comment(uuid, text) from public;
grant execute on function public.report_shared_trip_comment(uuid, text) to authenticated;
