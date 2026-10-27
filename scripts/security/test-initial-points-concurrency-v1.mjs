// Native PostgreSQL, independent TCP sessions, synthetic local data only.
// Never reads .env or accepts a remote connection URL; the host is fixed to loopback.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({ options: {
  port: { type: 'string', default: '55439' },
  driver: { type: 'string', default: '.tmp/initial-points-concurrency-v1/runtime/node_modules/pg/lib/index.js' },
  report: { type: 'string', default: 'docs/security/initial-points-concurrency-v1-results.json' },
} })
assert.match(values.port, /^\d+$/)
const { default: pg } = await import(pathToFileURL(resolve(root, values.driver)).href)
const connection = { host: '127.0.0.1', port: Number(values.port), user: 'postgres', password: '', ssl: false,
  connectionTimeoutMillis: 5000, statement_timeout: 15000, application_name: 'initial-points-local-test-v1' }
const filename = '20261027111646_initial_points_concurrency.sql'
const migration = await readFile(resolve(root, 'supabase/migrations', filename), 'utf8')
const names = (await readdir(resolve(root, 'supabase/migrations')))
  .filter(name => /^\d+_.+\.sql$/.test(name) && name < filename).sort()
const baseline = await Promise.all(names.map(async name => ({name,
  sql: await readFile(resolve(root, 'supabase/migrations', name), 'utf8')})))
const results = [], evidence = [], databases = []
const hash = text => createHash('sha256').update(text).digest('hex')
const uid = i => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`
const allowed = ['display_name','persona_companion','persona_budget','persona_stamina',
  'persona_diet','persona_transport_mode','persona_people','updated_at'].sort()
let engine
async function check(phase, name, fn) {
  try { await fn(); results.push({phase,name,passed:true}) }
  catch (error) { results.push({phase,name,passed:false,error:error.message}); throw error }
}
async function scenario(phase) {
  const clients = new Set()
  async function connect(database) {
    const client = new pg.Client({...connection,database})
    await client.connect(); clients.add(client)
    return client
  }
  const admin = await connect('postgres')
  // Unique, disposable databases; never reuse or reset an existing application DB.
  const database = `initial_points_${phase}_${Date.now()}`
  assert.match(database, /^initial_points_(before|after)_\d+$/)
  await admin.query(`CREATE DATABASE ${database}`)
  databases.push(database)
  const db = await connect(database)
  const test = (name, fn) => check(phase,name,fn)
  const rows = async (sql,params) => (await db.query(sql,params)).rows
  const scalar = async (sql,params) => Object.values((await rows(sql,params))[0])[0]
  const close = async client => { await client.end(); clients.delete(client) }
  async function caller(id, role = 'authenticated') {
    assert.ok(['authenticated','anon','service_role'].includes(role))
    const client = await connect(database)
    await client.query(`SET ROLE ${role}`)
    await client.query(`SELECT set_config('request.jwt.claims',$1,false)`,
      [JSON.stringify(id ? {sub:id,email:'fixture@example.invalid',user_metadata:{name:'Fixture'}} : {})])
    return client
  }
  async function invoke(id, sql = 'SELECT * FROM public.initialize_user_profile()', role = 'authenticated') {
    const client = await caller(id,role)
    try { return await client.query(sql) } finally { await close(client) }
  }
  async function user(id, balance, claimed) {
    await db.query('INSERT INTO auth.users VALUES($1)',[id])
    if (balance !== undefined) await db.query(`INSERT INTO public.profiles
      (id,email,points_balance,has_received_initial_points) VALUES($1,'fixture@example.invalid',$2,$3)`,[id,balance,claimed])
  }
  const profile = async id => (await rows('SELECT * FROM public.profiles WHERE id=$1',[id]))[0]
  const initial = id => rows(`SELECT amount,balance_after FROM public.point_transactions WHERE user_id=$1 AND type='initial' ORDER BY balance_after`,[id])
  async function waitForLocks(workers) {
    const pids = workers.map(c => c.processID)
    assert.equal(new Set(pids).size,workers.length)
    for (let attempt=0;attempt<200;attempt++) {
      const waiting = await rows(`SELECT pid,wait_event FROM pg_stat_activity
        WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock'`,[pids])
      if (waiting.length===workers.length) return waiting
      await pause(20)
    }
    throw new Error('Independent RPC sessions did not all reach the lock barrier')
  }
  async function parallel(id, kind) {
    const workers = await Promise.all(Array.from({length:8},()=>caller(id)))
    const gate = await connect(database)
    let pending = []
    try {
      await gate.query('BEGIN')
      if (kind==='new') await gate.query('LOCK TABLE public.profiles IN SHARE MODE')
      else await gate.query('SELECT id FROM public.profiles WHERE id=$1 FOR UPDATE',[id])
      // Real original/replacement function, no injected sleeps or body rewriting.
      pending = workers.map(c=>c.query('SELECT * FROM public.initialize_user_profile()').then(
        r=>({ok:true,balance:r.rows[0].points_balance}),error=>({ok:false,code:error.code})))
      const waiting = await waitForLocks(workers)
      await gate.query('COMMIT')
      const calls = await Promise.all(pending)
      const current = await profile(id), ledger = await initial(id)
      evidence.push({phase,kind,independentConnections:8,waitEvents:waiting.map(x=>x.wait_event),calls,
        balance:current.points_balance,claimed:current.has_received_initial_points,initialTransactions:ledger})
      return {calls,current,ledger}
    } finally {
      await gate.query('ROLLBACK')
      await Promise.all(pending)
      await Promise.all([...workers,gate].map(close))
    }
  }
  async function acl() {
    return rows(`SELECT * FROM (
      SELECT c.oid::regclass::text AS object,x.* FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relnamespace='public'::regnamespace
      UNION ALL SELECT a.attrelid::regclass::text||'.'||a.attname,x.* FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT p.oid::regprocedure::text,x.* FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.pronamespace='public'::regnamespace
    ) permissions ORDER BY object,grantor,grantee,privilege_type,is_grantable`)
  }
  async function catalog() {
    return rows(`SELECT 'table' AS kind,c.oid::text AS id,jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'owner',relowner) AS definition
      FROM pg_class c WHERE relnamespace='public'::regnamespace
      UNION ALL SELECT 'policy',oid::text,to_jsonb(p) FROM pg_policy p
      UNION ALL SELECT 'column',a.attrelid::text||'.'||a.attnum,to_jsonb(a)-'attacl'
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace
      UNION ALL SELECT 'constraint',oid::text,to_jsonb(c) FROM pg_constraint c WHERE connamespace='public'::regnamespace
      UNION ALL SELECT 'trigger',oid::text,to_jsonb(t) FROM pg_trigger t WHERE NOT tgisinternal
      UNION ALL SELECT 'function',oid::text,jsonb_build_object('owner',proowner,'def',pg_get_functiondef(oid))
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'
          AND oid<>'public.initialize_user_profile()'::regprocedure
      ORDER BY kind,id`)
  }
  try {
    engine = await scalar('SELECT version()')
    assert.equal(await scalar('SHOW transaction_isolation'),'read committed')
    // Roles are cluster-wide; the dedicated test cluster may already contain them.
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;`)
    await test('rebuild every baseline migration including the committed ACL fix',async()=>{
      for (const file of baseline) await db.query(file.sql)
    })
    if (phase==='after') {
      const beforeAcl=await acl(), beforeCatalog=await catalog()
      const beforeFunction=(await rows(`SELECT oid,proowner,prosecdef,proacl,proconfig FROM pg_proc WHERE oid='public.initialize_user_profile()'::regprocedure`))[0]
      await test('apply new migration without changing ACLs, other functions, RLS or schema',async()=>{
        await db.query(migration)
        assert.deepEqual(await acl(),beforeAcl); assert.deepEqual(await catalog(),beforeCatalog)
        assert.deepEqual((await rows(`SELECT oid,proowner,prosecdef,proacl,proconfig FROM pg_proc WHERE oid='public.initialize_user_profile()'::regprocedure`))[0],beforeFunction)
      })
      await test('reapplying the migration preserves the same function definition and ACLs',async()=>{
        const before=await scalar(`SELECT pg_get_functiondef('public.initialize_user_profile()'::regprocedure)`)
        await db.query(migration)
        assert.equal(await scalar(`SELECT pg_get_functiondef('public.initialize_user_profile()'::regprocedure)`),before)
        assert.deepEqual(await acl(),beforeAcl)
      })
    }
    await user(uid(1),7,false)
    await test(phase==='before'?'reproduce eight initial credits on a legacy false profile':'eight legacy-profile initializations grant exactly 100 once',async()=>{
      const {calls,current,ledger}=await parallel(uid(1),'legacy-false')
      assert.ok(calls.every(c=>c.ok))
      assert.equal(current.points_balance,phase==='before'?807:107)
      assert.equal(ledger.length,phase==='before'?8:1)
      assert.equal(current.has_received_initial_points,true)
    })
    await user(uid(2))
    await test(phase==='before'?'new-profile primary key prevents duplicate credit but seven callers fail':'eight new-profile initializations all succeed and grant only once',async()=>{
      const {calls,current,ledger}=await parallel(uid(2),'new')
      assert.equal(current.points_balance,100); assert.equal(ledger.length,1)
      assert.equal(calls.filter(c=>c.ok).length,phase==='before'?1:8)
      assert.ok(calls.filter(c=>!c.ok).every(c=>c.code==='23505'))
    })
    await user(uid(3),42,true)
    await test('eight already-claimed calls do not add balance or initial ledger',async()=>{
      const {calls,current,ledger}=await parallel(uid(3),'claimed')
      assert.ok(calls.every(c=>c.ok)); assert.equal(current.points_balance,42); assert.equal(ledger.length,0)
    })
    if(phase==='before')return
    await user(uid(4))
    await test('first initialization and five sequential repeats return one profile and credit',async()=>{
      for(let i=0;i<6;i++)assert.equal((await invoke(uid(4))).rows[0].points_balance,100)
      assert.equal((await initial(uid(4))).length,1)
    })
    await test('anon without UID still cannot initialize',async()=>{
      await assert.rejects(invoke(null,undefined,'anon'),error=>error.code==='P0001'&&error.message==='Not authenticated')
    })
    await test('different users do not share the same initialization lock',async()=>{
      await user(uid(5)); await user(uid(6))
      const held=await caller(uid(5))
      try {
        await held.query('BEGIN');await held.query('SELECT * FROM public.initialize_user_profile()')
        // A second independent user must finish while the first transaction still holds its lock.
        const other=await caller(uid(6));await other.query("SET statement_timeout='2s'")
        try{assert.equal((await other.query('SELECT * FROM public.initialize_user_profile()')).rows[0].points_balance,100)}finally{await close(other)}
      }finally{await held.query('ROLLBACK');await close(held)}
    })
    for(const [i,balance,claimed] of [[7,undefined,undefined],[8,7,false]])await test(`explicit rollback leaves ${balance===undefined?'new':'legacy'} profile and ledger unchanged`,async()=>{
      const id=uid(i);await user(id,balance,claimed)
      const before=await profile(id), ledger=await initial(id), client=await caller(id)
      try{await client.query('BEGIN');await client.query('SELECT * FROM public.initialize_user_profile()');await client.query('ROLLBACK')}
      finally{await close(client)}
      assert.deepEqual(await profile(id),before);assert.deepEqual(await initial(id),ledger)
      assert.equal((await invoke(id)).rows[0].points_balance,balance===undefined?100:107)
      assert.equal((await initial(id)).length,1)
    })
    await test('ledger failure rolls back new/legacy profile, flag and balance; retry grants once',async()=>{
      await db.query(`CREATE FUNCTION public.test_reject_initial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='initial' AND current_setting('test.fail_initial',true)='yes' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_reject_initial BEFORE INSERT ON public.point_transactions FOR EACH ROW EXECUTE FUNCTION public.test_reject_initial()`)
      try {
        for(const [i,balance,claimed] of [[9,undefined,undefined],[10,7,false]]){
          const id=uid(i);await user(id,balance,claimed)
          const before=await profile(id), client=await caller(id)
          try{
            await client.query("SET test.fail_initial='yes'")
            await assert.rejects(client.query('SELECT * FROM public.initialize_user_profile()'),error=>error.message==='injected ledger failure')
          }finally{await close(client)}
          assert.deepEqual(await profile(id),before);assert.equal((await initial(id)).length,0)
          assert.equal((await invoke(id)).rows[0].points_balance,balance===undefined?100:107)
          assert.equal((await initial(id)).length,1)
        }
      }finally{await db.query('DROP TRIGGER test_reject_initial ON public.point_transactions; DROP FUNCTION public.test_reject_initial()')}
    })
    await test('waiting initializer succeeds once after the first transaction rolls back',async()=>{
      const id=uid(11);await user(id)
      const first=await caller(id), second=await caller(id)
      let pending
      try{
        await first.query('BEGIN');await first.query('SELECT * FROM public.initialize_user_profile()')
        assert.equal(await profile(id),undefined);assert.equal((await initial(id)).length,0)
        pending=second.query('SELECT * FROM public.initialize_user_profile()')
        await waitForLocks([second]);await first.query('ROLLBACK')
        assert.equal((await pending).rows[0].points_balance,100)
        assert.equal((await initial(id)).length,1)
      }finally{await first.query('ROLLBACK');if(pending)await pending;await close(first);await close(second)}
    })
    await test('persona save/reset, service_role adjustment and 20/2-point RPCs remain normal',async()=>{
      const id=uid(4)
      const saved=await invoke(id,`UPDATE public.profiles SET display_name='Nickname',persona_companion='friends',persona_budget='normal',persona_stamina='high',persona_diet='vegetarian',persona_transport_mode='car',persona_people=4,updated_at=now() WHERE id='${id}' RETURNING *`)
      assert.equal(saved.rows[0].persona_people,4)
      await invoke(id,`UPDATE public.profiles SET persona_companion=null,persona_budget=null,persona_stamina=null,persona_diet=null,persona_transport_mode=null,persona_people=null,updated_at=now() WHERE id='${id}'`)
      await invoke(null,`UPDATE public.profiles SET points_balance=points_balance+9 WHERE id='${id}'`,'service_role')
      await invoke(null,`INSERT INTO public.point_transactions(user_id,type,amount,balance_after,reason) VALUES('${id}','admin_adjust',9,109,'local manager')`,'service_role')
      for(const [cost,balance]of[[20,89],[2,87]]){
        assert.equal((await invoke(id,`SELECT * FROM public.consume_points_for_analysis(${cost},'cost-${cost}')`)).rows[0].points_balance,balance)
        assert.equal(await scalar(`SELECT amount FROM public.point_transactions WHERE user_id=$1 AND reason=$2`,[id,`cost-${cost}`]),-cost)
      }
      assert.equal((await invoke(id)).rows[0].points_balance,87)
      assert.equal((await profile(id)).persona_people,null)
      assert.equal((await invoke(id,'SELECT public.get_my_points_balance() AS balance')).rows[0].balance,87)
    })
    await test('retention trims to newest 30 and cannot re-enable initial credit',async()=>{
      const id=uid(4)
      await db.query(`UPDATE public.point_transactions SET created_at=timestamptz '1999-01-01' WHERE user_id=$1`,[id])
      for(let i=1;i<=35;i++)await invoke(null,`INSERT INTO public.point_transactions(user_id,type,amount,balance_after,reason,created_at) VALUES('${id}','admin_adjust',0,87,'retain-${i}',timestamptz '2000-01-01'+interval '${i} seconds')`,'service_role')
      assert.equal(await scalar('SELECT count(*)::int FROM public.point_transactions WHERE user_id=$1',[id]),30)
      assert.equal((await initial(id)).length,0)
      await invoke(id,'SELECT public.trim_my_point_transactions()')
      await Promise.all(Array.from({length:8},()=>invoke(id)))
      assert.equal((await profile(id)).points_balance,87);assert.equal((await initial(id)).length,0)
    })
    await test('ACL stays restricted to eight persona fields and direct sensitive writes fail',async()=>{
      for(const role of ['anon','authenticated'])for(const table of ['profiles','point_transactions']){
        const permissions=await rows(`SELECT attname,has_column_privilege($1,attrelid,attnum,'UPDATE') AS update_allowed,has_column_privilege($1,attrelid,attnum,'INSERT') AS insert_allowed FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped`,[role,`public.${table}`])
        assert.deepEqual(permissions.filter(r=>r.update_allowed).map(r=>r.attname).sort(),role==='authenticated'&&table==='profiles'?allowed:[])
        assert.ok(permissions.every(r=>!r.insert_allowed))
        for(const op of ['UPDATE','INSERT','DELETE','TRUNCATE'])assert.equal(await scalar('SELECT has_table_privilege($1,$2,$3)',[role,`public.${table}`,op]),false)
      }
      const id=uid(4)
      for(const sql of [`UPDATE public.profiles SET points_balance=9999 WHERE id='${id}'`,
        `UPDATE public.profiles SET has_received_initial_points=false WHERE id='${id}'`,
        `DELETE FROM public.profiles WHERE id='${id}'`,
        `INSERT INTO public.profiles(id,email) VALUES('${id}','x') ON CONFLICT(id) DO UPDATE SET has_received_initial_points=false`,
        `INSERT INTO public.point_transactions(user_id,type,amount,balance_after) VALUES('${id}','initial',100,187)`])
        await assert.rejects(invoke(id,sql),error=>error.code==='42501')
      assert.equal((await invoke(id,`UPDATE public.profiles SET display_name='other' WHERE id='${uid(3)}' RETURNING id`)).rows.length,0)
    })
  }finally{await Promise.allSettled([...clients].map(c=>c.end()))}
}
let error
try{await scenario('before');await scenario('after')}catch(failure){error=failure;console.error(failure)}
const report={date:'2026-10-27',engine,isolation:'read committed',migration:filename,migrationSha256:hash(migration),
  baseline:baseline.map(({name,sql})=>({name,sha256:hash(sql)})),databases,
  passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results,evidence,
  limitations:['Local native PostgreSQL with synthetic Supabase auth helpers/default grants; no production, real JWT/PostgREST or HTTP manager calls',
    'Concurrency uses distinct PostgreSQL backend PIDs and catalog-confirmed lock barriers; no PGlite or mocked SQL',
    'The unchanged nullable-flag legacy case and production population are not repaired or inferred; no SSE debit work',
    'Native tests use the dev migration sequence; teammates 011-018 are not applied by this runner']}
await writeFile(resolve(root,values.report),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({passed:report.passed,failed:report.failed,engine,report:values.report}))
if(error)process.exitCode=1
