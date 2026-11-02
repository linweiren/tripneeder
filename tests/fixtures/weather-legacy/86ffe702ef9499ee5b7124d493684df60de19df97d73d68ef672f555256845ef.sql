create table if not exists public.api_rate_limits (
  bucket_key text primary key check (length(bucket_key) = 64),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists api_rate_limits_updated_at_idx
  on public.api_rate_limits (updated_at);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;
create or replace function public.consume_api_rate_limit(
  p_bucket_key text,
  p_max_requests integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  next_count integer;
  v_now timestamptz := now();
begin
  if p_bucket_key is null or length(p_bucket_key) <> 64
    or p_max_requests < 1 or p_max_requests > 1000
    or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid rate limit parameters';
  end if;

  insert into public.api_rate_limits (bucket_key, window_started_at, request_count, updated_at)
  values (p_bucket_key, v_now, 1, v_now)
  on conflict (bucket_key) do update set
    request_count = case
      when api_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then 1
      else least(api_rate_limits.request_count + 1, p_max_requests + 1)
    end,
    window_started_at = case
      when api_rate_limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then v_now
      else api_rate_limits.window_started_at
    end,
    updated_at = v_now
  returning request_count into next_count;

  if mod(extract(epoch from v_now)::bigint, 100) = 0 then
    delete from public.api_rate_limits where updated_at < v_now - interval '7 days';
  end if;

  return next_count <= p_max_requests;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;
