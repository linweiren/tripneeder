-- Remove precise and original input data from existing public shares.
update public.shared_trips
set input = null,
    plan = jsonb_set(
      jsonb_set(
        plan,
        '{stops}',
        coalesce((
          select jsonb_agg(stop - 'lat' - 'lng' order by position)
          from jsonb_array_elements(coalesce(plan->'stops', '[]'::jsonb)) with ordinality as rows(stop, position)
        ), '[]'::jsonb)
      ),
      '{rainBackup}',
      coalesce((
        select jsonb_agg(stop - 'lat' - 'lng' order by position)
        from jsonb_array_elements(coalesce(plan->'rainBackup', '[]'::jsonb)) with ordinality as rows(stop, position)
      ), '[]'::jsonb)
    );

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
  display_name text := coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), 'TripNeeder 旅人');
  shared_trip_id uuid;
  clean_tags text[];
  public_plan jsonb;
begin
  if current_user_id is null then raise exception 'Not authenticated'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object'
    or jsonb_typeof(p_plan->'stops') is distinct from 'array'
    or jsonb_typeof(p_plan->'budget') is distinct from 'number'
    or jsonb_typeof(p_plan->'title') is distinct from 'string'
    or octet_length(p_plan::text) > 200000 then
    raise exception 'Invalid trip plan or plan exceeds 200 KB';
  end if;
  if p_input is not null and (jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text) > 16000) then
    raise exception 'Invalid input format or input exceeds 16 KB';
  end if;
  if coalesce(cardinality(p_tags), 0) > 2 then raise exception 'At most two tags are allowed'; end if;
  if exists (select 1 from unnest(coalesce(p_tags, '{}')) as item(tag) where length(trim(tag)) = 0 or length(trim(tag)) > 20) then
    raise exception 'Tags must contain 1 to 20 characters';
  end if;
  select coalesce(array_agg(distinct left(trim(tag), 20)), '{}') into clean_tags
  from unnest(coalesce(p_tags, '{}')) as item(tag);
  if cardinality(clean_tags) > 2 then raise exception 'At most two tags are allowed'; end if;

  public_plan := p_plan - 'input' - 'origin' - 'startLocation';
  public_plan := jsonb_set(public_plan, '{stops}', coalesce((
    select jsonb_agg(stop - 'lat' - 'lng' order by position)
    from jsonb_array_elements(public_plan->'stops') with ordinality as rows(stop, position)
  ), '[]'::jsonb));
  if jsonb_typeof(public_plan->'rainBackup') = 'array' then
    public_plan := jsonb_set(public_plan, '{rainBackup}', coalesce((
      select jsonb_agg(stop - 'lat' - 'lng' order by position)
      from jsonb_array_elements(public_plan->'rainBackup') with ordinality as rows(stop, position)
    ), '[]'::jsonb));
  end if;

  perform public.initialize_user_profile();
  insert into public.shared_trips (owner_id, author_display_name, plan, input, tags)
  values (current_user_id, display_name, public_plan, null, clean_tags)
  on conflict (owner_id, (md5(plan::text))) do update set input = null, plan = excluded.plan, tags = excluded.tags
  returning id into shared_trip_id;
  return shared_trip_id;
end;
$$;
revoke all on function public.share_trip(jsonb, jsonb, text[]) from public;
grant execute on function public.share_trip(jsonb, jsonb, text[]) to authenticated;

create or replace function public.unshare_trip(p_trip_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.shared_trips where id = p_trip_id and owner_id = auth.uid();
  if not found then raise exception 'Share not found or not owned by current user'; end if;
  return true;
end;
$$;
revoke all on function public.unshare_trip(uuid) from public;
grant execute on function public.unshare_trip(uuid) to authenticated;

-- Keep like toggling and counts without any point reward state.
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
  select owner_id into trip_owner_id from public.shared_trips where id = p_trip_id for update;
  if trip_owner_id is null then raise exception 'Shared trip not found'; end if;
  if trip_owner_id = current_user_id then raise exception 'Cannot like your own shared trip'; end if;
  delete from public.shared_trip_likes where shared_trip_id = p_trip_id and user_id = current_user_id;
  if found then did_like := false;
  else
    insert into public.shared_trip_likes (shared_trip_id, user_id) values (p_trip_id, current_user_id) on conflict do nothing;
    did_like := found;
  end if;
  select count(*)::integer into current_like_count from public.shared_trip_likes where shared_trip_id = p_trip_id;
  update public.shared_trips st set like_count = current_like_count where st.id = p_trip_id;
  return query select did_like, current_like_count;
end;
$$;
revoke all on function public.toggle_shared_trip_like(uuid) from public;
grant execute on function public.toggle_shared_trip_like(uuid) to authenticated;
