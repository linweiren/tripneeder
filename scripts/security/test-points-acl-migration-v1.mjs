// Local PostgreSQL/WASM only. No .env, network client, Supabase connection or paid API.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({ options: {
  runtime: { type: 'string', default: '.tmp/points-acl-test-runtime/node_modules/@electric-sql/pglite/dist/index.js' },
  proposal: { type: 'string' },
  'weather-fixtures': { type: 'string' },
  report: { type: 'string', default: 'docs/security/points-acl-migration-v1-results.json' },
} })
const { PGlite } = await import(pathToFileURL(resolve(root, values.runtime)).href)
const filename = '20261027103330_points_column_write_acl.sql'
const migration = await readFile(resolve(root, 'supabase/migrations', filename), 'utf8')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const results = []
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
const D = '00000000-0000-4000-8000-000000000004'
const allowed = ['display_name', 'persona_companion', 'persona_budget', 'persona_stamina',
  'persona_diet', 'persona_transport_mode', 'persona_people', 'updated_at'].sort()
const baselineNames = (await readdir(resolve(root, 'supabase/migrations')))
  .filter(name => /^\d+_.+\.sql$/.test(name) && name < filename).sort()
const baseline = await Promise.all(baselineNames.map(async name => ({
  name, sql: await readFile(resolve(root, 'supabase/migrations', name), 'utf8'),
})))
const extra = values['weather-fixtures']
  ? JSON.parse(await readFile(resolve(root, values['weather-fixtures']), 'utf8')) : []
for (const file of extra) {
  assert.match(file.name, /^01[1-8]_.+\.sql$/)
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(file.sql)}\0`).update(file.sql).digest('hex')
  assert.equal(blob, file.blob, `Git blob mismatch: ${file.name}`)
}
const proposal = values.proposal ? await readFile(resolve(root, values.proposal), 'utf8') : null
if (proposal) assert.equal(migration.slice(migration.indexOf('BEGIN;')).replaceAll('\r\n', '\n'),
  proposal.slice(proposal.indexOf('BEGIN;')).replaceAll('\r\n', '\n'))
const versions = [...baselineNames, filename, ...extra.map(f => f.name)].map(f => f.split('_')[0])
assert.equal(new Set(versions).size, versions.length, 'Duplicate migration version')
assert.match(filename, /^\d{14}_[a-z_]+\.sql$/)

async function check(scenario, name, fn) {
  try { await fn(); results.push({ scenario, name, passed: true }) }
  catch (error) { results.push({ scenario, name, passed: false, error: error.message }); throw error }
}
let engine
async function run(scenario, files, prepatched, injectFaults) {
  const db = new PGlite()
  const scalar = async sql => Object.values((await db.query(sql)).rows[0])[0]
  const rows = async sql => (await db.query(sql)).rows
  const acl = () => rows(`SELECT * FROM (
    SELECT c.oid::regclass::text AS object, x.* FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT a.attrelid::regclass::text||'.'||a.attname, x.* FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    ) entries ORDER BY object,grantor,grantee,privilege_type,is_grantable`)
  const structure = () => scalar(`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM
      (SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.attnotnull,a.attidentity,a.attgenerated,
        pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a
       JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped) a),
    'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY oid) FROM pg_constraint WHERE connamespace='public'::regnamespace),
    'rls',(SELECT jsonb_agg(jsonb_build_array(oid,relrowsecurity,relforcerowsecurity) ORDER BY oid)
      FROM pg_class WHERE relnamespace='public'::regnamespace),
    'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p),
    'functions',(SELECT jsonb_agg(jsonb_build_array(oid,pg_get_functiondef(oid),proowner,proacl) ORDER BY oid)
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(oid,pg_get_triggerdef(oid),tgenabled) ORDER BY oid)
      FROM pg_trigger WHERE NOT tgisinternal),
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member) FROM pg_auth_members m),
    'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY oid) FROM pg_default_acl d))`)
  const data = () => scalar(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.profiles p),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.point_transactions t))`)
  async function as(role, id, sql) {
    await db.query(`SELECT set_config('request.jwt.claims',$1,false)`,
      [JSON.stringify(id ? { sub: id, email: 'fixture@example.invalid' } : {})])
    await db.exec(`SET ROLE ${role}`)
    try { return await db.query(sql) } finally { await db.exec('RESET ROLE') }
  }
  const denied = (sql, role = 'authenticated', id = A) =>
    assert.rejects(as(role, id, sql), error => error.code === '42501')
  const test = (name, fn) => check(scenario, name, fn)
  async function apply(sql = migration) {
    try { await db.exec(sql) } catch (error) { await db.exec('ROLLBACK'); throw error }
  }
  try {
    // Supabase-managed primitives/default grants, not application migration repairs.
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;`)
    engine = await scalar('SELECT version()')
    await test('all original migrations rebuild without edits', async () => {
      for (const file of files) {
        try { await db.exec(file.sql) } catch (error) { throw new Error(`${file.name}: ${error.message}`, { cause: error }) }
      }
    })
    await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}'),('${D}')`)
    for (const id of [A, B]) await as('authenticated', id, 'SELECT public.initialize_user_profile()')
    if (prepatched) await apply(proposal ?? migration)
    const beforeStructure = await structure(), beforeData = await data()
    const beforeAcl = await acl()
    await test(prepatched ? 'new migration applies over identical pre-existing ACL repair' : 'new migration applies to clean rebuilt database', apply)
    await test('migration changes no schema, RLS, functions, triggers, memberships or data', async () => {
      assert.deepEqual(await structure(), beforeStructure); assert.deepEqual(await data(), beforeData)
    })
    if (prepatched) await test('prepatched ACLs remain exactly identical', async () => assert.deepEqual(await acl(), beforeAcl))
    await test('second application is idempotent across every table and column ACL', async () => {
      const before = await acl(); await apply(); assert.deepEqual(await acl(), before)
    })
    await test('effective grants allow exactly eight persona columns; deny sensitive writes', async () => {
      for (const role of ['anon', 'authenticated']) for (const table of ['profiles', 'point_transactions']) {
        const permissions = await rows(`SELECT attname,
          has_column_privilege('${role}',attrelid,attnum,'UPDATE') AS update_allowed,
          has_column_privilege('${role}',attrelid,attnum,'INSERT') AS insert_allowed
          FROM pg_attribute WHERE attrelid='public.${table}'::regclass AND attnum>0 AND NOT attisdropped`)
        assert.deepEqual(permissions.filter(x => x.update_allowed).map(x => x.attname).sort(),
          role === 'authenticated' && table === 'profiles' ? allowed : [])
        assert.ok(permissions.every(x => !x.insert_allowed))
        for (const op of ['INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal(
          await scalar(`SELECT has_table_privilege('${role}','public.${table}','${op}')`), false)
      }
    })
    await test('authenticated direct balance/initial flag and mixed payload updates fail', async () => {
      for (const payload of ['points_balance=9999','has_received_initial_points=false',"display_name='x',points_balance=9999"])
        await denied(`UPDATE public.profiles SET ${payload} WHERE id='${A}'`)
    })
    await test('INSERT, UPSERT, DELETE and TRUNCATE cannot reset initial eligibility', async () => {
      await denied(`INSERT INTO public.profiles(id,email,points_balance) VALUES('${C}','x',9999)`)
      await denied(`INSERT INTO public.profiles(id,email) VALUES('${A}','x') ON CONFLICT(id) DO UPDATE SET has_received_initial_points=false`)
      await denied(`DELETE FROM public.profiles WHERE id='${A}'`)
      await denied('TRUNCATE public.profiles CASCADE')
    })
    await test('ordinary users cannot forge, update, delete or truncate ledger', async () => {
      await denied(`INSERT INTO public.point_transactions(user_id,type,amount,balance_after) VALUES('${A}','initial',100,100)`)
      await denied(`UPDATE public.point_transactions SET amount=999 WHERE user_id='${A}'`)
      await denied(`DELETE FROM public.point_transactions WHERE user_id='${A}'`)
      await denied('TRUNCATE public.point_transactions')
      await denied(`UPDATE public.profiles SET display_name='x' WHERE id='${A}'`, 'anon', null)
    })
    await test('persona save and reset with RETURNING work; other accounts remain hidden', async () => {
      const saved = await as('authenticated', A, `UPDATE public.profiles SET display_name='saved',
        persona_companion='friends',persona_budget='normal',persona_stamina='high',persona_diet='vegetarian',
        persona_transport_mode='car',persona_people=4,updated_at=now() WHERE id='${A}' RETURNING *`)
      assert.equal(saved.rows[0].persona_people, 4)
      await as('authenticated', A, `UPDATE public.profiles SET persona_companion=null,persona_budget=null,
        persona_stamina=null,persona_diet=null,persona_transport_mode=null,persona_people=null,updated_at=now() WHERE id='${A}'`)
      const reset = (await as('authenticated', A, `SELECT * FROM public.profiles WHERE id='${A}'`)).rows[0]
      for (const field of allowed.filter(name => name.startsWith('persona_'))) assert.equal(reset[field], null)
      assert.equal((await as('authenticated', A, `UPDATE public.profiles SET display_name='hidden' WHERE id='${B}' RETURNING id`)).rows.length, 0)
    })
    for (const [cost, balance] of [[20,80], [2,78]]) await test(`${cost}-point RPC debits and records ledger`, async () => {
      await as('authenticated', A, `SELECT public.consume_points_for_analysis(${cost},'cost-${cost}')`)
      assert.equal(await scalar(`SELECT points_balance FROM public.profiles WHERE id='${A}'`), balance)
      assert.equal(await scalar(`SELECT amount FROM public.point_transactions WHERE user_id='${A}' AND reason='cost-${cost}'`), -cost)
      assert.equal((await as('authenticated', A, 'SELECT public.get_my_points_balance()')).rows[0].get_my_points_balance, balance)
    })
    await test('insufficient, zero, negative and NULL costs leave balance and ledger unchanged', async () => {
      const before = await data()
      for (const cost of ['9999','0','-20','NULL']) await assert.rejects(
        as('authenticated', A, `SELECT public.consume_points_for_analysis(${cost},'invalid')`), error => error.code === 'P0001')
      assert.deepEqual(await data(), before)
    })
    await test('new and legacy unclaimed users receive initial 100 exactly once sequentially', async () => {
      await db.exec(`INSERT INTO public.profiles(id,email,points_balance,has_received_initial_points) VALUES('${D}','legacy',7,false)`)
      for (const id of [C,D]) for (let i=0;i<2;i++) await as('authenticated', id, 'SELECT public.initialize_user_profile()')
      assert.equal(await scalar(`SELECT points_balance FROM public.profiles WHERE id='${C}'`), 100)
      assert.equal(await scalar(`SELECT points_balance FROM public.profiles WHERE id='${D}'`), 107)
      for (const id of [C,D]) assert.equal(await scalar(`SELECT count(*)::int FROM public.point_transactions WHERE user_id='${id}' AND type='initial'`), 1)
    })
    await test('service_role manager changes another account and inserts ledger; trigger keeps newest 30', async () => {
      await db.exec(`UPDATE public.point_transactions SET created_at=timestamptz '1999-01-01' WHERE user_id='${B}'`)
      for (let i=1;i<=42;i++) {
        const updated = await as('service_role', null, `UPDATE public.profiles SET points_balance=points_balance+1,updated_at=now() WHERE id='${B}' RETURNING points_balance`)
        await as('service_role', null, `INSERT INTO public.point_transactions(user_id,type,amount,balance_after,reason,created_at)
          VALUES('${B}','admin_adjust',1,${updated.rows[0].points_balance},'manager-${i}',timestamptz '2000-01-01'+interval '${i} seconds')`)
      }
      assert.equal(await scalar(`SELECT points_balance FROM public.profiles WHERE id='${B}'`), 142)
      assert.deepEqual((await rows(`SELECT reason FROM public.point_transactions WHERE user_id='${B}' ORDER BY created_at`)).map(x => x.reason),
        Array.from({length:30},(_,i)=>`manager-${i+13}`))
    })
    await test('20/2-point RPCs and retention continue after threshold; initialization cannot recredit', async () => {
      for (const cost of [20,2]) {
        await as('authenticated', B, `SELECT public.consume_points_for_analysis(${cost},'threshold-${cost}')`)
        assert.equal(await scalar(`SELECT amount FROM public.point_transactions WHERE user_id='${B}' AND reason='threshold-${cost}'`), -cost)
      }
      await as('authenticated', B, 'SELECT public.trim_my_point_transactions()')
      await as('authenticated', B, 'SELECT public.initialize_user_profile()')
      assert.equal(await scalar(`SELECT points_balance FROM public.profiles WHERE id='${B}'`), 120)
      assert.equal(await scalar(`SELECT count(*)::int FROM public.point_transactions WHERE user_id='${B}'`), 30)
      assert.equal(await scalar(`SELECT has_received_initial_points FROM public.profiles WHERE id='${B}'`), true)
    })
    if (injectFaults) {
      const faults = [
        ['inherited table grant', 'CREATE ROLE acl_parent; GRANT UPDATE ON public.profiles TO acl_parent; GRANT acl_parent TO authenticated',
          'REVOKE acl_parent FROM authenticated; DROP OWNED BY acl_parent; DROP ROLE acl_parent', 'Unexpected effective'],
        ['inherited column INSERT', 'CREATE ROLE acl_parent; GRANT INSERT(amount) ON public.point_transactions TO acl_parent; GRANT acl_parent TO authenticated',
          'REVOKE acl_parent FROM authenticated; DROP OWNED BY acl_parent; DROP ROLE acl_parent', 'Unexpected effective'],
        ['NOINHERIT reachable parent', 'ALTER ROLE authenticated NOINHERIT; CREATE ROLE acl_parent; GRANT UPDATE ON public.profiles TO acl_parent; GRANT acl_parent TO authenticated',
          'REVOKE acl_parent FROM authenticated; DROP OWNED BY acl_parent; DROP ROLE acl_parent; ALTER ROLE authenticated INHERIT', 'Privileged parent'],
        ['service_role missing INSERT', 'REVOKE INSERT ON public.point_transactions FROM service_role',
          'GRANT INSERT ON public.point_transactions TO service_role', 'admin manager'],
        ['disabled RLS', 'ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY',
          'ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY', 'disabled RLS'],
        ['RPC INVOKER drift', 'ALTER FUNCTION public.consume_points_for_analysis(integer,text) SECURITY INVOKER',
          'ALTER FUNCTION public.consume_points_for_analysis(integer,text) SECURITY DEFINER', 'RPC owner'],
        ['unprivileged RPC owner', 'CREATE ROLE acl_owner; ALTER FUNCTION public.initialize_user_profile() OWNER TO acl_owner',
          'ALTER FUNCTION public.initialize_user_profile() OWNER TO postgres; DROP ROLE acl_owner', 'RPC owner'],
        ['disabled retention trigger', 'ALTER TABLE public.point_transactions DISABLE TRIGGER point_transactions_trim_after_insert',
          'ALTER TABLE public.point_transactions ENABLE TRIGGER point_transactions_trim_after_insert', 'Retention trigger'],
        ['retention INVOKER drift', 'ALTER FUNCTION public.trim_point_transactions_for_user() SECURITY INVOKER',
          'ALTER FUNCTION public.trim_point_transactions_for_user() SECURITY DEFINER', 'Retention owner'],
        ['retention owner lacks DELETE', 'CREATE ROLE acl_owner; GRANT SELECT ON public.point_transactions TO acl_owner; ALTER FUNCTION public.trim_point_transactions_for_user() OWNER TO acl_owner',
          'ALTER FUNCTION public.trim_point_transactions_for_user() OWNER TO postgres; DROP OWNED BY acl_owner; DROP ROLE acl_owner', 'Retention owner'],
      ]
      for (const [name, setup, cleanup, message] of faults) await test(`${name}: failure aborts transaction and restores every ACL`, async () => {
        await db.exec(setup)
        // Force real ACL changes before the failing check, including the service_role GRANT.
        await db.exec(`GRANT UPDATE ON public.profiles TO authenticated; GRANT UPDATE(points_balance),INSERT(points_balance) ON public.profiles TO PUBLIC;
          GRANT UPDATE(amount),INSERT(amount) ON public.point_transactions TO PUBLIC; REVOKE UPDATE ON public.profiles FROM service_role`)
        const before = await acl(), catalog = await structure(), records = await data()
        try {
          await assert.rejects(db.exec(migration), error => error.message.includes(message))
          await assert.rejects(db.query('SELECT 1'), error => error.code === '25P02')
        } finally { await db.exec('ROLLBACK') }
        assert.deepEqual(await acl(), before); assert.deepEqual(await structure(), catalog); assert.deepEqual(await data(), records)
        await db.exec(cleanup)
        await apply()
      })
    }
  } finally { await db.close() }
}

let failure
try {
  await run('dev-clean', baseline, false, true)
  await run('dev-prepatched', baseline, true, false)
  if (extra.length) {
    await run('weather-clean', [...baseline, ...extra], false, false)
    await run('weather-prepatched', [...baseline, ...extra], true, false)
  }
} catch (error) { failure = error; console.error(error) }
const report = {
  date: '2026-10-27', engine, migration: filename, migrationSha256: sha256(migration),
  proposalExecutableSqlIdentical: proposal ? true : null,
  baseline: baseline.map(({name,sql}) => ({name,sha256:sha256(sql)})),
  additionalFixtures: extra.map(({name,blob}) => ({name,blob})),
  passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length,
  limitations: ['PGlite PostgreSQL with synthetic Supabase auth primitives/default grants; no native Supabase CLI reset or migration history integration',
    'No production access, real JWT/PostgREST, HTTP manager or paid API calls',
    'Single session: concurrent initialization is outside this migration test'],
  results,
}
await writeFile(resolve(root, values.report), JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({passed:report.passed,failed:report.failed,engine,report:values.report}))
if (failure) process.exitCode = 1
