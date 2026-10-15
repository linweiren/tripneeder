create or replace function public.trim_point_transactions_for_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.point_transactions
  where id in (
    select id
    from public.point_transactions
    where user_id = new.user_id
    order by created_at desc, id desc
    offset 30
  );

  return new;
end;
$$;

drop trigger if exists point_transactions_trim_after_insert
  on public.point_transactions;

create trigger point_transactions_trim_after_insert
after insert on public.point_transactions
for each row
execute function public.trim_point_transactions_for_user();

create or replace function public.trim_my_point_transactions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  deleted_count integer;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  with deleted_rows as (
    delete from public.point_transactions
    where id in (
      select id
      from public.point_transactions
      where user_id = current_user_id
      order by created_at desc, id desc
      offset 30
    )
    returning id
  )
  select count(*) into deleted_count
  from deleted_rows;

  return deleted_count;
end;
$$;

grant execute on function public.trim_my_point_transactions() to authenticated;
