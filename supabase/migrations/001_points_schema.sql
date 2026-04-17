create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  points_balance integer not null default 0 check (points_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (
    type in ('initial', 'consume', 'admin_adjust', 'refund')
  ),
  amount integer not null,
  balance_after integer not null check (balance_after >= 0),
  reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists point_transactions_user_created_idx
  on public.point_transactions (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.point_transactions enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "Users can read own point transactions" on public.point_transactions;
create policy "Users can read own point transactions"
  on public.point_transactions
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.initialize_user_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text := coalesce(auth.jwt() ->> 'email', '');
  current_name text := coalesce(
    auth.jwt() -> 'user_metadata' ->> 'full_name',
    auth.jwt() -> 'user_metadata' ->> 'name',
    auth.jwt() ->> 'email',
    ''
  );
  profile_row public.profiles;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.profiles (
    id,
    email,
    display_name,
    points_balance
  )
  values (
    current_user_id,
    current_email,
    current_name,
    100
  )
  on conflict (id) do update
    set
      email = excluded.email,
      display_name = coalesce(excluded.display_name, public.profiles.display_name),
      updated_at = now()
  returning * into profile_row;

  insert into public.point_transactions (
    user_id,
    type,
    amount,
    balance_after,
    reason,
    created_by
  )
  select
    current_user_id,
    'initial',
    100,
    100,
    '初始點數',
    null
  where not exists (
    select 1
    from public.point_transactions
    where user_id = current_user_id
      and type = 'initial'
  );

  return profile_row;
end;
$$;

grant execute on function public.initialize_user_profile() to authenticated;
