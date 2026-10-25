create table if not exists public.shared_trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  author_display_name text not null,
  plan jsonb not null,
  input jsonb,
  like_count integer not null default 0 check (like_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists shared_trips_created_idx
  on public.shared_trips (created_at desc);

create unique index if not exists shared_trips_unique_owner_plan_idx
  on public.shared_trips (owner_id, md5(plan::text));

create table if not exists public.shared_trip_likes (
  shared_trip_id uuid not null references public.shared_trips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (shared_trip_id, user_id)
);

alter table public.shared_trips enable row level security;
alter table public.shared_trip_likes enable row level security;

drop policy if exists "Anyone can read shared trips" on public.shared_trips;
create policy "Anyone can read shared trips"
  on public.shared_trips for select to anon, authenticated using (true);

create or replace function public.share_trip(p_plan jsonb, p_input jsonb default null)
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
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then raise exception 'Invalid trip plan'; end if;
  perform public.initialize_user_profile();
  insert into public.shared_trips (owner_id, author_display_name, plan, input)
  values (current_user_id, display_name, p_plan, p_input)
  on conflict (owner_id, (md5(plan::text))) do nothing
  returning id into shared_trip_id;
  if shared_trip_id is null then
    select id into shared_trip_id from public.shared_trips
      where owner_id = current_user_id and md5(plan::text) = md5(p_plan::text);
  end if;
  return shared_trip_id;
end;
$$;

revoke all on function public.share_trip(jsonb, jsonb) from public;
grant execute on function public.share_trip(jsonb, jsonb) to authenticated;

create or replace function public.shared_trip_feed(p_trip_id uuid default null)
returns table (
  id uuid,
  plan jsonb,
  input jsonb,
  author_display_name text,
  created_at timestamptz,
  like_count integer,
  liked_by_me boolean,
  is_owner boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select st.id, st.plan, st.input, st.author_display_name, st.created_at,
         st.like_count,
         exists (
           select 1 from public.shared_trip_likes l
           where l.shared_trip_id = st.id and l.user_id = auth.uid()
         ),
         st.owner_id = auth.uid()
  from public.shared_trips st
  where p_trip_id is null or st.id = p_trip_id
  order by st.created_at desc;
$$;

revoke all on function public.shared_trip_feed(uuid) from public;
grant execute on function public.shared_trip_feed(uuid) to anon, authenticated;

create or replace function public.toggle_shared_trip_like(p_trip_id uuid)
returns table (liked boolean, like_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  trip_owner_id uuid;
  did_like boolean;
  current_like_count integer;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  perform public.initialize_user_profile();
  select owner_id into trip_owner_id
    from public.shared_trips where id = p_trip_id for update;
  if trip_owner_id is null then raise exception 'Shared trip not found'; end if;
  if trip_owner_id = current_user_id then raise exception 'Cannot like your own shared trip'; end if;

  delete from public.shared_trip_likes
    where shared_trip_id = p_trip_id and user_id = current_user_id;
  if found then
    did_like := false;
  else
    insert into public.shared_trip_likes (shared_trip_id, user_id)
    values (p_trip_id, current_user_id)
    on conflict do nothing;
    did_like := found;
  end if;

  select count(*)::integer into current_like_count
    from public.shared_trip_likes where shared_trip_id = p_trip_id;
  update public.shared_trips st set like_count = current_like_count
    where st.id = p_trip_id;

  return query select did_like, current_like_count;
end;
$$;

revoke all on function public.toggle_shared_trip_like(uuid) from public;
grant execute on function public.toggle_shared_trip_like(uuid) to authenticated;
