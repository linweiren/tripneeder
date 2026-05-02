-- 008_fix_initial_points_logic.sql
-- 解決初始點數因為交易紀錄被清理而重複領取的問題

-- 1. 在 profiles 表格新增「是否已領取初始點數」的狀態欄位
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS has_received_initial_points BOOLEAN DEFAULT FALSE;

-- 2. 資料同步：標記現有已領取過的人
-- 根據現有的 initial 紀錄來標記
UPDATE public.profiles 
SET has_received_initial_points = TRUE 
WHERE id IN (
  SELECT user_id FROM public.point_transactions WHERE type = 'initial'
);

-- 3. 安全防護：如果點數餘額 >= 100 且目前沒紀錄，保險起見也設為已領取，避免剛好被刪除紀錄的使用者重複加點
UPDATE public.profiles
SET has_received_initial_points = TRUE
WHERE has_received_initial_points = FALSE AND points_balance >= 100;

-- 4. 重寫初始化函式邏輯
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
