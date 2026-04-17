create or replace function public.get_my_points_balance()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_balance integer;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select points_balance
  into current_balance
  from public.profiles
  where id = current_user_id;

  if current_balance is null then
    raise exception 'Profile not found';
  end if;

  return current_balance;
end;
$$;

grant execute on function public.get_my_points_balance() to authenticated;

create or replace function public.consume_points_for_analysis(
  cost integer default 20,
  reason text default 'AI 行程分析'
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  profile_row public.profiles;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if cost <= 0 then
    raise exception 'Cost must be positive';
  end if;

  update public.profiles
  set
    points_balance = points_balance - cost,
    updated_at = now()
  where id = current_user_id
    and points_balance >= cost
  returning * into profile_row;

  if profile_row.id is null then
    raise exception 'Insufficient points';
  end if;

  insert into public.point_transactions (
    user_id,
    type,
    amount,
    balance_after,
    reason,
    created_by
  )
  values (
    current_user_id,
    'consume',
    -cost,
    profile_row.points_balance,
    reason,
    current_user_id
  );

  return profile_row;
end;
$$;

grant execute on function public.consume_points_for_analysis(integer, text) to authenticated;
