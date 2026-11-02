-- Public sharing is served through the sanitized SECURITY DEFINER feed only.
revoke all on public.shared_trips from anon, authenticated;

-- Remove precise coordinates and address-level/direct place identifiers from old shares.
-- Drop duplicate shares that become identical after private location data is removed.
with normalized as (
  select id,
         row_number() over (
           partition by owner_id, md5((
             (plan - 'input' - 'origin' - 'startLocation') || jsonb_build_object(
               'stops', coalesce((
                 select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
                 from jsonb_array_elements(coalesce(plan->'stops', '[]'::jsonb)) with ordinality as rows(stop, position)
               ), '[]'::jsonb),
               'rainBackup', coalesce((
                 select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
                 from jsonb_array_elements(coalesce(plan->'rainBackup', '[]'::jsonb)) with ordinality as rows(stop, position)
               ), '[]'::jsonb)
             )
           )::text)
           order by created_at, id
         ) as duplicate_rank
  from public.shared_trips
)
delete from public.shared_trips st
using normalized n
where st.id = n.id and n.duplicate_rank > 1;

update public.shared_trips
set input = null,
    plan = jsonb_set(
      jsonb_set(
        plan - 'input' - 'origin' - 'startLocation',
        '{stops}',
        coalesce((
          select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
          from jsonb_array_elements(coalesce(plan->'stops', '[]'::jsonb)) with ordinality as rows(stop, position)
        ), '[]'::jsonb)
      ),
      '{rainBackup}',
      coalesce((
        select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
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
    select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
    from jsonb_array_elements(public_plan->'stops') with ordinality as rows(stop, position)
  ), '[]'::jsonb));
  if jsonb_typeof(public_plan->'rainBackup') = 'array' then
    public_plan := jsonb_set(public_plan, '{rainBackup}', coalesce((
      select jsonb_agg(stop - 'lat' - 'lng' - 'address' - 'googleMapsUrl' - 'placeId' order by position)
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
