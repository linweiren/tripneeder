create table if not exists public.trip_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('favorite', 'recent')),
  plan jsonb not null,
  input jsonb,
  plan_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists trip_records_user_kind_created_idx
  on public.trip_records (user_id, kind, created_at desc);

create unique index if not exists trip_records_unique_favorite_plan_idx
  on public.trip_records (user_id, plan_fingerprint)
  where kind = 'favorite';

alter table public.trip_records enable row level security;

drop policy if exists "Users can read own trip records" on public.trip_records;
create policy "Users can read own trip records"
  on public.trip_records
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert own trip records" on public.trip_records;
create policy "Users can insert own trip records"
  on public.trip_records
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update own trip records" on public.trip_records;
create policy "Users can update own trip records"
  on public.trip_records
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own trip records" on public.trip_records;
create policy "Users can delete own trip records"
  on public.trip_records
  for delete
  to authenticated
  using (user_id = auth.uid());
