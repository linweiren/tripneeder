-- Paid snapshots outlive the 30-row ledger and the editable recent-trip copies.
-- No changes to existing point functions, grants, initial credits or admin tools.
begin;

create table public.trip_generations (
  generation_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_input jsonb not null check (jsonb_typeof(request_input) = 'object'),
  request_hash text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  attempt_token uuid,
  lease_expires_at timestamptz,
  response jsonb,
  charged_points integer not null default 0,
  point_transaction_id uuid, -- Deliberately no FK to the pruned ledger.
  completed_at timestamptz,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint trip_generation_payment_snapshot check (
    (status = 'completed' and response is not null and jsonb_typeof(response) = 'object'
      and charged_points = 20 and point_transaction_id is not null and completed_at is not null
      and attempt_token is null and lease_expires_at is null)
    or (status <> 'completed' and response is null and charged_points = 0
      and point_transaction_id is null and completed_at is null)
  ),
  constraint trip_generation_running_lease check (
    status <> 'running' or (attempt_token is not null and lease_expires_at is not null)
  )
);
create index trip_generations_owner_created_idx on public.trip_generations(user_id, created_at desc, generation_id desc);
alter table public.trip_generations enable row level security;
-- All access is through the authenticated backend; no user JWT can write snapshots.
revoke all on public.trip_generations from public, anon, authenticated, service_role;
grant select on public.trip_generations to service_role;

create function public.protect_completed_trip_generation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if old.status = 'completed' then
    raise exception 'Completed generation is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_completed_trip_generation() from public, anon, authenticated, service_role;
create trigger trip_generation_immutable before update on public.trip_generations
for each row execute function public.protect_completed_trip_generation();

create function public.claim_trip_generation(p_user_id uuid, p_generation_id uuid, p_request_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare g public.trip_generations;
begin
  if p_user_id is null or p_generation_id is null or p_request_input is null
    or jsonb_typeof(p_request_input) <> 'object' then raise exception 'Invalid generation'; end if;
  insert into public.trip_generations(generation_id,user_id,request_input,request_hash,status)
    values(p_generation_id,p_user_id,p_request_input,md5(p_request_input::text),'failed')
    on conflict (generation_id) do nothing;
  select * into g from public.trip_generations where generation_id = p_generation_id for update;
  if g.user_id <> p_user_id then return jsonb_build_object('outcome','missing'); end if;
  -- Compare the actual JSON too; a hash collision never authorizes a different input.
  if g.request_input <> p_request_input then return jsonb_build_object('outcome','input_mismatch'); end if;
  if g.status = 'completed' then
    return jsonb_build_object('outcome','completed','response',g.response);
  end if;
  if g.status = 'running' and g.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('outcome','running','leaseExpiresAt',g.lease_expires_at);
  end if;
  update public.trip_generations set status='running', attempt_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '360 seconds', updated_at=clock_timestamp(), error_code=null
    where generation_id=p_generation_id returning * into g;
  return jsonb_build_object('outcome','claimed','attemptToken',g.attempt_token,'leaseExpiresAt',g.lease_expires_at);
end;
$$;

create function public.complete_paid_trip_generation(p_user_id uuid, p_generation_id uuid, p_attempt_token uuid, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare g public.trip_generations; balance integer; transaction_id uuid;
begin
  select * into g from public.trip_generations
    where generation_id=p_generation_id and user_id=p_user_id for update;
  if not found then raise exception 'Generation not found'; end if;
  if g.status='completed' then return g.response; end if;
  if g.status <> 'running' or p_attempt_token is null or g.attempt_token is distinct from p_attempt_token
    or g.lease_expires_at <= clock_timestamp() then raise exception 'Stale generation attempt'; end if;
  if p_response is null or jsonb_typeof(p_response) <> 'object'
    or jsonb_typeof(p_response->'plans') is distinct from 'array'
    or jsonb_array_length(p_response->'plans') < 1 then raise exception 'Invalid snapshot'; end if;
  update public.profiles set points_balance=points_balance-20, updated_at=clock_timestamp()
    where id=p_user_id and points_balance>=20 returning points_balance into balance;
  if not found then raise exception 'Insufficient points'; end if;
  insert into public.point_transactions(user_id,type,amount,balance_after,reason,created_by)
    values(p_user_id,'consume',-20,balance,'AI 行程分析',p_user_id) returning id into transaction_id;
  update public.trip_generations set status='completed', response=p_response, charged_points=20,
    point_transaction_id=transaction_id, completed_at=clock_timestamp(), updated_at=clock_timestamp(),
    attempt_token=null, lease_expires_at=null, error_code=null where generation_id=p_generation_id;
  return p_response;
end;
$$;

create function public.fail_trip_generation(p_user_id uuid, p_generation_id uuid, p_attempt_token uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
begin
  update public.trip_generations set status='failed', attempt_token=null, lease_expires_at=null,
    error_code='attempt_failed', updated_at=clock_timestamp()
    where generation_id=p_generation_id and user_id=p_user_id and status='running'
      and attempt_token=p_attempt_token;
  return found;
end;
$$;

revoke all on function public.claim_trip_generation(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.complete_paid_trip_generation(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.fail_trip_generation(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_trip_generation(uuid,uuid,jsonb) to service_role;
grant execute on function public.complete_paid_trip_generation(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.fail_trip_generation(uuid,uuid,uuid) to service_role;
commit;
