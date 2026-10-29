-- Serialize same-user initialization without changing grants, RLS or point calculations.
-- Forward migration after 20261027103330; does not use teammates' 011-018 versions.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
  was_already_received boolean;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Serialize initialization before the eligibility read, including absent profiles.
  -- Transaction scope releases the lock automatically on COMMIT or ROLLBACK.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tripneeder:initialize_user_profile:' || current_user_id::text, 0)
  );

  -- 取得目前的領取狀態
  select has_received_initial_points into was_already_received
  from public.profiles
  where id = current_user_id;

  if was_already_received is null then
    -- 情況 A：完全的新使用者 (連 Profile 都還沒有)
    insert into public.profiles (
      id,
      email,
      display_name,
      points_balance,
      has_received_initial_points
    )
    values (
      current_user_id,
      current_email,
      current_name,
      100,
      true
    )
    returning * into profile_row;

    insert into public.point_transactions (
      user_id,
      type,
      amount,
      balance_after,
      reason
    )
    values (
      current_user_id,
      'initial',
      100,
      100,
      '初始點數'
    );
  elsif not was_already_received then
    -- 情況 B：Profile 已存在但未標記領取 (例如舊系統遺留或異常)
    update public.profiles
    set
      points_balance = points_balance + 100,
      has_received_initial_points = true,
      email = current_email,
      display_name = coalesce(current_name, display_name),
      updated_at = now()
    where id = current_user_id
    returning * into profile_row;

    insert into public.point_transactions (
      user_id,
      type,
      amount,
      balance_after,
      reason
    )
    values (
      current_user_id,
      'initial',
      100,
      profile_row.points_balance,
      '初始點數'
    );
  else
    -- 情況 C：已經領取過，僅單純更新基本資料 (Email, Name)
    update public.profiles
    set
      email = current_email,
      display_name = coalesce(current_name, display_name),
      updated_at = now()
    where id = current_user_id
    returning * into profile_row;
  end if;

  return profile_row;
end;
$$;

COMMIT;
