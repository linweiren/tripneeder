-- Points write ACL baseline; version 20261027103330 (UTC).
-- Executable SQL preserved from the production-applied points-column-grants-proposal.sql.
-- Reapplication is intentional when SQL Editor changes have no migration history entry.
-- Requires existing Supabase roles, table grants, RLS and SECURITY DEFINER owners.
-- Deployment/history reconciliation: docs/security/points-acl-migration-v1.md.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- A column REVOKE alone cannot override a table UPDATE grant, and the inverse is also true.
-- Prevent INSERT/UPSERT or DELETE/recreate from resetting initial-credit eligibility.
REVOKE UPDATE, INSERT, DELETE, TRUNCATE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.point_transactions FROM PUBLIC, anon, authenticated;
DO $proposal$
DECLARE column_list text; target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.profiles'::regclass, 'public.point_transactions'::regclass]
  LOOP
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_list
    FROM pg_attribute WHERE attrelid = target AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE UPDATE (%s), INSERT (%s) ON TABLE %s FROM PUBLIC, anon, authenticated',
                   column_list, column_list, target);
  END LOOP;
END;
$proposal$;

-- Preserve the exact fields written by PersonaPage, including reset and updated_at.
GRANT UPDATE (display_name, persona_companion, persona_budget, persona_stamina, persona_diet,
              persona_transport_mode, persona_people, updated_at)
ON TABLE public.profiles TO authenticated;

-- Keep the owner's localhost manager able to adjust ANY account via its server-side key.
-- Existing SELECT and service_role point_transactions INSERT grants are not revoked.
GRANT UPDATE ON TABLE public.profiles TO service_role;

-- Leave RLS and SECURITY DEFINER point RPCs unchanged.
-- Abort the entire draft if an inherited grant still allows a sensitive update.
DO $proposal$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute a CROSS JOIN pg_roles r
    WHERE a.attrelid IN ('public.profiles'::regclass, 'public.point_transactions'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped AND r.rolname IN ('anon', 'authenticated')
      AND (has_column_privilege(r.oid, a.attrelid, a.attnum, 'UPDATE') <>
           (r.rolname = 'authenticated' AND a.attrelid = 'public.profiles'::regclass AND
            a.attname IN ('display_name', 'persona_companion', 'persona_budget', 'persona_stamina',
                         'persona_diet', 'persona_transport_mode', 'persona_people', 'updated_at'))
        OR has_column_privilege(r.oid, a.attrelid, a.attnum, 'INSERT')
        OR has_table_privilege(r.oid, a.attrelid, 'UPDATE')
        OR has_table_privilege(r.oid, a.attrelid, 'DELETE')
        OR has_table_privilege(r.oid, a.attrelid, 'TRUNCATE'))
  ) THEN
    RAISE EXCEPTION 'Unexpected effective write privileges remain; inspect inherited/PUBLIC grants';
  END IF;

  -- Also detect NOINHERIT parent roles (possible SET ROLE path).
  -- MEMBER is deliberately conservative: on PG16+ it also includes SET-disabled membership.
  IF EXISTS (
    SELECT 1 FROM pg_roles child CROSS JOIN pg_roles parent
    WHERE child.rolname IN ('anon', 'authenticated') AND parent.oid <> child.oid
      AND pg_has_role(child.oid, parent.oid, 'MEMBER')
      AND (parent.rolsuper OR parent.rolbypassrls OR EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid IN ('public.profiles'::regclass, 'public.point_transactions'::regclass)
          AND a.attnum > 0 AND NOT a.attisdropped
          AND (has_column_privilege(parent.oid, a.attrelid, a.attnum, 'INSERT')
            OR (has_column_privilege(parent.oid, a.attrelid, a.attnum, 'UPDATE') AND
                (a.attrelid = 'public.point_transactions'::regclass OR a.attname NOT IN
                 ('display_name', 'persona_companion', 'persona_budget', 'persona_stamina',
                  'persona_diet', 'persona_transport_mode', 'persona_people', 'updated_at')))
            OR has_table_privilege(parent.oid, a.attrelid, 'DELETE')
            OR has_table_privilege(parent.oid, a.attrelid, 'TRUNCATE'))))
  ) THEN
    RAISE EXCEPTION 'Privileged parent role is reachable; review membership rather than revoking shared roles blindly';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated') AND (rolsuper OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_class WHERE oid IN
          ('public.profiles'::regclass, 'public.point_transactions'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'Unexpected API role attributes or disabled RLS';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.profiles', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.profiles', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.point_transactions', 'INSERT')
     OR NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'The existing admin manager privileges are incomplete; preserve them before applying this proposal';
  END IF;
END;
$proposal$;

-- Do not silently break INVOKER functions or functions owned by an unprivileged role.
-- Conservative owner check: owner/bypass must be able to bypass RLS on both tables.
DO $rpc_check$
DECLARE f record; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.initialize_user_profile()',
    'public.get_my_points_balance()', 'public.consume_points_for_analysis(integer,text)']
  LOOP
    SELECT p.*, r.rolsuper, r.rolbypassrls INTO STRICT f
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = signature::regprocedure;
    IF NOT f.prosecdef OR NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')
       OR NOT has_table_privilege(f.proowner, 'public.profiles', 'SELECT')
       OR NOT has_table_privilege(f.proowner, 'public.profiles', 'UPDATE')
       OR NOT has_table_privilege(f.proowner, 'public.profiles', 'INSERT')
       OR NOT has_table_privilege(f.proowner, 'public.point_transactions', 'INSERT')
       OR EXISTS (
         SELECT 1 FROM pg_class c
         WHERE c.oid IN ('public.profiles'::regclass, 'public.point_transactions'::regclass)
           AND NOT (f.rolsuper OR f.rolbypassrls OR (c.relowner = f.proowner AND NOT c.relforcerowsecurity))
       ) THEN
      RAISE EXCEPTION 'RPC owner/SECURITY DEFINER/EXECUTE requirements differ: %', signature;
    END IF;
  END LOOP;
END;
$rpc_check$;

-- A ledger INSERT also invokes retention. Check its real definer owner, including DELETE.
-- Do not repair drift by granting DELETE to ordinary API roles.
DO $retention_check$
DECLARE f record; signature text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.point_transactions'::regclass
      AND tgname = 'point_transactions_trim_after_insert' AND NOT tgisinternal
      AND tgfoid = 'public.trim_point_transactions_for_user()'::regprocedure
      AND tgtype = 5 AND tgenabled IN ('O', 'A') AND tgqual IS NULL AND tgnargs = 0
  ) THEN
    RAISE EXCEPTION 'Retention trigger missing, disabled or changed; repair aborted';
  END IF;
  FOREACH signature IN ARRAY ARRAY['public.trim_point_transactions_for_user()',
                                   'public.trim_my_point_transactions()']
  LOOP
    SELECT p.*, r.rolsuper, r.rolbypassrls INTO STRICT f
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=signature::regprocedure;
    IF NOT f.prosecdef
       OR NOT has_table_privilege(f.proowner, 'public.point_transactions', 'SELECT')
       OR NOT has_table_privilege(f.proowner, 'public.point_transactions', 'DELETE')
       OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.point_transactions'::regclass
         AND (f.rolsuper OR f.rolbypassrls OR (c.relowner=f.proowner AND NOT c.relforcerowsecurity)))
       OR (signature='public.trim_my_point_transactions()'
           AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'Retention owner/SECURITY DEFINER/DELETE/EXECUTE requirements differ: %', signature;
    END IF;
  END LOOP;
END;
$retention_check$;

COMMIT;
