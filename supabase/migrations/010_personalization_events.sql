create table if not exists public.personalization_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('open_maps', 'start_navigation', 'favorite_plan')),
  place_id text,
  place_name text,
  stop_type text check (
    stop_type is null
    or stop_type in ('main_activity', 'food', 'ending_or_transition')
  ),
  google_types text[],
  candidate_role text check (
    candidate_role is null
    or candidate_role in ('food', 'main_activity', 'open_space', 'shopping', 'short_visit')
  ),
  food_subtype text check (
    food_subtype is null
    or food_subtype in ('cafe', 'dessert', 'restaurant', 'snack')
  ),
  lat double precision,
  lng double precision,
  plan_id text,
  plan_type text check (
    plan_type is null
    or plan_type in ('safe', 'balanced', 'explore')
  ),
  input_category text check (
    input_category is null
    or input_category in ('date', 'relax', 'explore', 'food', 'outdoor', 'indoor', 'solo', 'other')
  ),
  input_tags text[],
  event_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists personalization_events_user_created_idx
  on public.personalization_events (user_id, created_at desc);

alter table public.personalization_events enable row level security;

drop policy if exists "Users can read own personalization events" on public.personalization_events;
create policy "Users can read own personalization events"
  on public.personalization_events
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert own personalization events" on public.personalization_events;
create policy "Users can insert own personalization events"
  on public.personalization_events
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own personalization events" on public.personalization_events;
create policy "Users can delete own personalization events"
  on public.personalization_events
  for delete
  to authenticated
  using (user_id = auth.uid());
