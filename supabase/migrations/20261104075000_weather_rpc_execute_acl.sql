-- Append-only repair after a confirmed weather upgrade through 019.
-- Run transactionally, together with pending 011-019 before exposing new RPCs.
-- Changes only these eight function ACLs. No data, function bodies, LINE RPCs,
-- role memberships, default privileges or migration-history rows are changed here.
do $rpc_acl_prerequisites$
declare signature text;
begin
  foreach signature in array array[
    'public.share_trip(jsonb,jsonb,text[])',
    'public.unshare_trip(uuid)',
    'public.toggle_shared_trip_like(uuid)',
    'public.add_shared_trip_comment(uuid,text)',
    'public.delete_shared_trip_comment(uuid)',
    'public.record_shared_trip_view(uuid)',
    'public.report_shared_trip_comment(uuid,text)',
    'public.consume_api_rate_limit(text,integer,integer)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing required RPC: %. Confirm the upgrade path before applying the ACL repair.', signature;
    end if;
  end loop;
end;
$rpc_acl_prerequisites$;

-- Browser writes need a validated user session. Backend/admin roles are not callers.
revoke all on function public.share_trip(jsonb,jsonb,text[]) from public, anon, authenticated, service_role;
grant execute on function public.share_trip(jsonb,jsonb,text[]) to authenticated;
revoke all on function public.unshare_trip(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unshare_trip(uuid) to authenticated;
revoke all on function public.toggle_shared_trip_like(uuid) from public, anon, authenticated, service_role;
grant execute on function public.toggle_shared_trip_like(uuid) to authenticated;
revoke all on function public.add_shared_trip_comment(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.add_shared_trip_comment(uuid,text) to authenticated;
revoke all on function public.delete_shared_trip_comment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_shared_trip_comment(uuid) to authenticated;
revoke all on function public.record_shared_trip_view(uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_shared_trip_view(uuid) to authenticated;
revoke all on function public.report_shared_trip_comment(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.report_shared_trip_comment(uuid,text) to authenticated;

-- Only api/_lib/request-guards.ts uses this RPC, with a server-side service key.
revoke all on function public.consume_api_rate_limit(text,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.consume_api_rate_limit(text,integer,integer) to service_role;

-- REVOKE cannot negate inherited grants. Stop for review instead of changing shared roles.
do $rpc_acl_verify$
declare signature text; function_oid oid; api_role text; allowed_role text; expected boolean;
begin
  foreach signature in array array[
    'public.share_trip(jsonb,jsonb,text[])',
    'public.unshare_trip(uuid)',
    'public.toggle_shared_trip_like(uuid)',
    'public.add_shared_trip_comment(uuid,text)',
    'public.delete_shared_trip_comment(uuid)',
    'public.record_shared_trip_view(uuid)',
    'public.report_shared_trip_comment(uuid,text)',
    'public.consume_api_rate_limit(text,integer,integer)'
  ] loop
    function_oid := to_regprocedure(signature);
    allowed_role := case when signature = 'public.consume_api_rate_limit(text,integer,integer)'
      then 'service_role' else 'authenticated' end;
    foreach api_role in array array['anon','authenticated','service_role'] loop
      expected := api_role = allowed_role;
      if has_function_privilege(api_role,function_oid,'EXECUTE') is distinct from expected then
        raise exception 'Unexpected effective RPC EXECUTE for role % on %; inspect inherited grants without modifying shared roles.', api_role, signature;
      end if;
    end loop;
    if exists (
      select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=function_oid and a.privilege_type='EXECUTE'
        and a.grantee not in (p.proowner,(select oid from pg_roles where rolname=allowed_role))
    ) then
      raise exception 'Unexpected RPC EXECUTE grantee on %; review the existing grant before upgrading.', signature;
    end if;
  end loop;
end;
$rpc_acl_verify$;
