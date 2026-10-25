alter table public.shared_trips
  add column if not exists tags text[] not null default '{}';

alter table public.shared_trips
  drop constraint if exists shared_trips_tags_limit_check;
alter table public.shared_trips
  add constraint shared_trips_tags_limit_check
  check (cardinality(tags) <= 2);

create table if not exists public.shared_trip_comments (
  id uuid primary key default gen_random_uuid(),
  shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_display_name text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists shared_trip_comments_trip_created_idx
  on public.shared_trip_comments (shared_trip_id, created_at asc);

create table if not exists public.shared_trip_views (
  shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (shared_trip_id, user_id)
);

alter table public.shared_trip_comments enable row level security;
alter table public.shared_trip_views enable row level security;

drop policy if exists "Anyone can read shared trip comments" on public.shared_trip_comments;
revoke all on public.shared_trip_comments from anon, authenticated;

drop function if exists public.share_trip(jsonb, jsonb);
create or replace function public.share_trip(
  p_plan jsonb,
  p_input jsonb default null,
  p_tags text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  display_name text := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    'TripNeeder 旅人'
  );
  shared_trip_id uuid;
  clean_tags text[];
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then raise exception 'Invalid trip plan'; end if;
  if coalesce(cardinality(p_tags), 0) > 2 then raise exception 'At most two tags are allowed'; end if;
  if exists (
    select 1 from unnest(coalesce(p_tags, '{}')) as item(tag)
    where length(trim(tag)) = 0 or length(trim(tag)) > 20
  ) then raise exception 'Tags must contain 1 to 20 characters'; end if;

  select coalesce(array_agg(distinct left(trim(tag), 20)), '{}')
    into clean_tags
    from unnest(coalesce(p_tags, '{}')) as item(tag);
  if cardinality(clean_tags) > 2 then raise exception 'At most two tags are allowed'; end if;

  perform public.initialize_user_profile();
  insert into public.shared_trips (owner_id, author_display_name, plan, input, tags)
  values (current_user_id, display_name, p_plan, p_input, clean_tags)
  on conflict (owner_id, (md5(plan::text))) do update
    set input = excluded.input, tags = excluded.tags
  returning id into shared_trip_id;
  return shared_trip_id;
end;
$$;
revoke all on function public.share_trip(jsonb, jsonb, text[]) from public;
grant execute on function public.share_trip(jsonb, jsonb, text[]) to authenticated;

drop function if exists public.shared_trip_feed(uuid);
create or replace function public.shared_trip_feed(
  p_trip_id uuid default null,
  p_owner_only boolean default false
)
returns table (
  id uuid,
  plan jsonb,
  input jsonb,
  tags text[],
  author_display_name text,
  created_at timestamptz,
  like_count integer,
  comment_count integer,
  view_count integer,
  liked_by_me boolean,
  is_owner boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select st.id, st.plan, st.input, st.tags, st.author_display_name, st.created_at,
         st.like_count,
         (select count(*)::integer from public.shared_trip_comments c where c.shared_trip_id = st.id),
         (select count(*)::integer from public.shared_trip_views v where v.shared_trip_id = st.id),
         exists (
           select 1 from public.shared_trip_likes l
           where l.shared_trip_id = st.id and l.user_id = auth.uid()
         ),
         st.owner_id = auth.uid()
  from public.shared_trips st
  where (p_trip_id is null or st.id = p_trip_id)
    and (not p_owner_only or st.owner_id = auth.uid())
  order by st.created_at desc;
$$;
revoke all on function public.shared_trip_feed(uuid, boolean) from public;
grant execute on function public.shared_trip_feed(uuid, boolean) to anon, authenticated;

create or replace function public.shared_trip_comments_feed(p_trip_id uuid)
returns table (
  id uuid,
  author_display_name text,
  body text,
  created_at timestamptz,
  is_mine boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.author_display_name, c.body, c.created_at, c.user_id = auth.uid()
  from public.shared_trip_comments c
  where c.shared_trip_id = p_trip_id
  order by c.created_at asc;
$$;
revoke all on function public.shared_trip_comments_feed(uuid) from public;
grant execute on function public.shared_trip_comments_feed(uuid) to anon, authenticated;

create or replace function public.add_shared_trip_comment(p_trip_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  display_name text := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    'TripNeeder 旅人'
  );
  clean_body text := trim(coalesce(p_body, ''));
  comment_id uuid;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if length(clean_body) = 0 or length(clean_body) > 500 then
    raise exception 'Comment must contain 1 to 500 characters';
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

create or replace function public.delete_shared_trip_comment(p_comment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.shared_trip_comments
    where id = p_comment_id and user_id = auth.uid();
  if not found then raise exception 'Comment not found or not owned by current user'; end if;
  return true;
end;
$$;
revoke all on function public.delete_shared_trip_comment(uuid) from public;
grant execute on function public.delete_shared_trip_comment(uuid) to authenticated;

create or replace function public.record_shared_trip_view(p_trip_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  total_views integer;
  trip_owner_id uuid;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  perform public.initialize_user_profile();
  select owner_id into trip_owner_id from public.shared_trips where id = p_trip_id;
  if trip_owner_id is null then raise exception 'Shared trip not found'; end if;
  if trip_owner_id <> current_user_id then
    insert into public.shared_trip_views (shared_trip_id, user_id)
    values (p_trip_id, current_user_id)
    on conflict do nothing;
  end if;
  select count(*)::integer into total_views
    from public.shared_trip_views where shared_trip_id = p_trip_id;
  return total_views;
end;
$$;
revoke all on function public.record_shared_trip_view(uuid) from public;
grant execute on function public.record_shared_trip_view(uuid) to authenticated;
