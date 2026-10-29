// Disposable native PostgreSQL databases on loopback only. Never reads .env.
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(import.meta.dirname, '../..')
const { default: pg } = await import(pathToFileURL(resolve(root, '.tmp/initial-points-concurrency-v1/runtime/node_modules/pg/lib/index.js')).href)
const config = { host: '127.0.0.1', port: 55439, user: 'postgres', password: '', ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 15000 }
const database = `paid_generation_${Date.now()}`
const clients = new Set(), results = [], timings = []
async function connect(dbname = database) { const c = new pg.Client({ ...config, database: dbname }); await c.connect(); clients.add(c); return c }
async function close(c) { await c.end(); clients.delete(c) }
async function check(name, run) {
  const start = performance.now()
  try { await run(); results.push({ name, passed: true, milliseconds: Math.round((performance.now() - start) * 100) / 100 }) }
  catch (error) { results.push({ name, passed: false, error: error.message }); throw error }
}
const admin = await connect('postgres')
await admin.query(`CREATE DATABASE ${database}`)
const db = await connect()
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const input = { startTime: '10:00', endTime: '15:00', location: { name: 'Mock location', lat: 22.6, lng: 120.3 }, tags: [] }
const response = { plans: ['safe','balanced','explore'].map(type => ({ id: type, type, stops: [{ id: 'fixture', name: 'Final repaired result' }] })), warnings: ['final text'] }
const rows = async (sql, params) => (await db.query(sql, params)).rows
const scalar = async (sql, params) => Object.values((await rows(sql, params))[0])[0]
async function caller(role = 'service_role', owner = A) {
  const c = await connect(); assert.ok(['service_role','anon','authenticated'].includes(role))
  await c.query(`SET ROLE ${role}`)
  await c.query(`SELECT set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: owner, email: 'fixture@example.invalid' })])
  return c
}
const claim = async (id, user = A, value = input, client = db) => (await client.query(
  'SELECT public.claim_trip_generation($1,$2,$3) AS result', [user, id, value])).rows[0].result
const complete = async (id, token, user = A, snapshot = response, client = db) => (await client.query(
  'SELECT public.complete_paid_trip_generation($1,$2,$3,$4) AS result', [user,id,token,snapshot])).rows[0].result
const fail = async (id, token, user = A) => scalar('SELECT public.fail_trip_generation($1,$2,$3)', [user,id,token])
const balance = async (user = A) => scalar('SELECT points_balance FROM public.profiles WHERE id=$1', [user])
const ledger = async () => rows('SELECT * FROM public.point_transactions ORDER BY id')
const originalObjects = async () => rows(`SELECT 'function' AS kind, oid::text AS id, pg_get_functiondef(oid) AS def, proacl::text AS acl
  FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'
  AND proname NOT IN ('claim_trip_generation','complete_paid_trip_generation','fail_trip_generation','protect_completed_trip_generation')
  UNION ALL SELECT 'table',oid::text,relrowsecurity::text,relacl::text FROM pg_class
  WHERE relnamespace='public'::regnamespace AND relname <> 'trip_generations' AND relkind='r'
  UNION ALL SELECT 'column',attrelid::text||'.'||attnum,attname,attacl::text FROM pg_attribute
    WHERE attrelid IN ('public.profiles'::regclass,'public.point_transactions'::regclass) AND attnum>0
  ORDER BY kind,id`)
let version, migrationHash, paidId
try {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;`)
  const migrationName = '20261027220000_paid_generation_consistency_v1.sql'
  for (const name of (await readdir(resolve(root,'supabase/migrations'))).filter(n => n.endsWith('.sql') && n < migrationName).sort()) {
    await db.query(await readFile(resolve(root,'supabase/migrations',name),'utf8'))
  }
  const original = await originalObjects()
  const migration = await readFile(resolve(root,'supabase/migrations',migrationName),'utf8')
  migrationHash = createHash('sha256').update(migration).digest('hex')
  await check('new migration preserves all existing functions, table and column ACLs', async () => {
    await db.query(migration); assert.deepEqual(await originalObjects(), original)
    version = await scalar('SELECT version()')
  })
  await db.query(`INSERT INTO auth.users VALUES($1),($2);
    `, [A,B])
  await db.query(`INSERT INTO public.profiles(id,email,points_balance,has_received_initial_points)
    VALUES($1,'fixture-a@example.invalid',1000,true),($2,'fixture-b@example.invalid',20,true)`,[A,B])

  await check('normal claim and completion charge exactly 20 and persist the identical final snapshot', async () => {
    paidId = randomUUID()
    const c = await caller()
    const start = performance.now(), g = await claim(paidId,A,input,c)
    const claimedAt = performance.now()
    assert.equal(g.outcome,'claimed')
    assert.deepEqual(await complete(paidId,g.attemptToken,A,response,c),response)
    timings.push({ claimMs: claimedAt-start, atomicCompleteMs: performance.now()-claimedAt })
    assert.equal(await balance(),980)
    const row = (await rows('SELECT * FROM public.trip_generations WHERE generation_id=$1',[paidId]))[0]
    assert.equal(row.charged_points,20); assert.equal(row.status,'completed'); assert.deepEqual(row.response,response)
    assert.equal((await rows('SELECT * FROM public.point_transactions WHERE id=$1',[row.point_transaction_id])).length,1)
    await close(c)
  })
  await check('paid replay ignores a different replacement snapshot and cannot charge again', async () => {
    const before = await ledger()
    assert.deepEqual(await complete(paidId,randomUUID(),A,{ plans:[{id:'forged'}] }),response)
    assert.equal((await claim(paidId)).outcome,'completed')
    assert.equal(await fail(paidId,randomUUID()),false)
    assert.deepEqual(await ledger(),before); assert.equal(await balance(),980)
    await assert.rejects(db.query(`UPDATE public.trip_generations SET response='{}' WHERE generation_id=$1`,[paidId]),/immutable/)
  })
  await check('same UUID with different input or different owner cannot reuse payment or result', async () => {
    assert.equal((await claim(paidId,A,{...input,endTime:'16:00'})).outcome,'input_mismatch')
    assert.deepEqual(await claim(paidId,B),{outcome:'missing'})
    await assert.rejects(complete(paidId,randomUUID(),B),/not found/)
  })
  await check('eight independent simultaneous claims elect exactly one worker', async () => {
    const id=randomUUID(), workers=await Promise.all(Array.from({length:8},()=>caller()))
    const attempts=await Promise.all(workers.map(c=>claim(id,A,input,c)))
    assert.equal(attempts.filter(a=>a.outcome==='claimed').length,1)
    assert.equal(attempts.filter(a=>a.outcome==='running').length,7)
    const g=attempts.find(a=>a.outcome==='claimed')
    const before=await balance(), count=(await ledger()).length
    await Promise.all(workers.map(c=>complete(id,g.attemptToken,A,response,c)))
    assert.equal(await balance(),before-20); assert.equal((await ledger()).length,count+1)
    await Promise.all(workers.map(close))
  })
  await check('lease expiration fences the old worker before and after takeover, including fail', async () => {
    const id=randomUUID(), old=await claim(id)
    await db.query(`UPDATE public.trip_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE generation_id=$1`,[id])
    const before=await balance()
    await assert.rejects(complete(id,old.attemptToken),/Stale/)
    const next=await claim(id); assert.notEqual(next.attemptToken,old.attemptToken)
    await assert.rejects(complete(id,old.attemptToken),/Stale/)
    assert.equal(await fail(id,old.attemptToken),false)
    assert.equal(await balance(),before)
    await complete(id,next.attemptToken)
  })
  await check('failed unpaid attempt is retryable under the same UUID with a new fence', async () => {
    const id=randomUUID(), a=await claim(id), before=await balance()
    assert.equal(await fail(id,a.attemptToken),true)
    const b=await claim(id); assert.notEqual(a.attemptToken,b.attemptToken)
    await assert.rejects(complete(id,a.attemptToken),/Stale/)
    assert.equal(await balance(),before); await complete(id,b.attemptToken)
  })
  await check('two different IDs competing for the last 20 points can complete only once', async () => {
    const ids=[randomUUID(),randomUUID()], claims=await Promise.all(ids.map(id=>claim(id,B)))
    const workers=await Promise.all(ids.map(()=>caller('service_role',B)))
    const results=await Promise.allSettled(ids.map((id,i)=>complete(id,claims[i].attemptToken,B,response,workers[i])))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(results.filter(r=>r.status==='rejected' && /Insufficient points/.test(r.reason.message)).length,1)
    assert.equal(await balance(B),0)
    assert.equal(await scalar(`SELECT count(*)::int FROM public.trip_generations WHERE user_id=$1 AND status='completed'`,[B]),1)
    await Promise.all(workers.map(close))
  })
  await check('snapshot failure after debit AND ledger insertion rolls back all changes including ledger pruning', async () => {
    await db.query(`INSERT INTO public.point_transactions(user_id,type,amount,balance_after)
      SELECT $1,'admin_adjust',0,0 FROM generate_series(1,35)`,[A])
    const id=randomUUID(), g=await claim(id), before=await balance(), beforeLedger=await ledger()
    await db.query(`CREATE FUNCTION public.test_snapshot_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF new.response ? 'injectFailure' THEN RAISE EXCEPTION 'Injected snapshot failure'; END IF; RETURN new; END $$;
      CREATE TRIGGER test_snapshot_failure BEFORE UPDATE ON public.trip_generations FOR EACH ROW EXECUTE FUNCTION public.test_snapshot_failure()`)
    await assert.rejects(complete(id,g.attemptToken,A,{...response,injectFailure:true}),/Injected/)
    assert.equal(await balance(),before); assert.deepEqual(await ledger(),beforeLedger)
    assert.equal(await scalar('SELECT response IS NULL FROM public.trip_generations WHERE generation_id=$1',[id]),true)
    await db.query('DROP TRIGGER test_snapshot_failure ON public.trip_generations; DROP FUNCTION public.test_snapshot_failure()')
    await complete(id,g.attemptToken)
  })
  await check('30-row ledger pruning and recent deletion cannot remove payment idempotency', async () => {
    await db.query(`INSERT INTO public.point_transactions(user_id,type,amount,balance_after,created_at)
      SELECT $1,'admin_adjust',0,0,clock_timestamp()+interval '1 day' FROM generate_series(1,35)`,[A])
    assert.equal(await scalar(`SELECT count(*)::int FROM public.point_transactions WHERE user_id=$1`,[A]),30)
    await db.query('DELETE FROM public.trip_records WHERE user_id=$1',[A])
    const before=await balance()
    assert.deepEqual((await claim(paidId)).response,response)
    assert.equal(await balance(),before)
  })
  await check('anon/authenticated cannot directly read/write snapshots or invoke any generation RPC', async () => {
    for (const role of ['anon','authenticated']) {
      const c=await caller(role)
      for (const sql of ['SELECT * FROM public.trip_generations',`UPDATE public.trip_generations SET status='completed'`,
        `INSERT INTO public.trip_generations(generation_id) VALUES('${randomUUID()}')`,`DELETE FROM public.trip_generations`,
        `SELECT public.claim_trip_generation('${A}','${randomUUID()}','{}')`,
        `SELECT public.complete_paid_trip_generation('${A}','${paidId}','${randomUUID()}','{}')`,
        `SELECT public.fail_trip_generation('${A}','${paidId}','${randomUUID()}')`]) {
        await assert.rejects(c.query(sql),e=>e.code==='42501')
      }
      await close(c)
    }
  })
  await check('existing 2-point recalculation debit, initial gift, owner ACL and admin adjustment still work', async () => {
    const c=await caller('authenticated'), before=await balance()
    await c.query(`SELECT public.consume_points_for_analysis(2,'交通重算')`)
    assert.equal(await balance(),before-2)
    await assert.rejects(c.query('UPDATE public.profiles SET points_balance=999999'),e=>e.code==='42501')
    const newUser=randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)',[newUser])
    const fresh=await caller('authenticated',newUser)
    await fresh.query('SELECT public.initialize_user_profile()'); await fresh.query('SELECT public.initialize_user_profile()')
    assert.equal(await balance(newUser),100)
    const manager=await caller()
    await manager.query('UPDATE public.profiles SET points_balance=points_balance+5 WHERE id=$1',[A])
    assert.equal(await balance(),before+3)
    await Promise.all([c,fresh,manager].map(close))
  })
  await check('fresh independent server process restores from PostgreSQL with no old worker memory or paid providers', async () => {
    const output=execFileSync(process.execPath,['--import','./tests/unit/register-ts-js-extension-loader.mjs',
      './tests/unit/fixtures/paid-generation-restart.mjs',database,paidId,A],{cwd:root,encoding:'utf8',timeout:20000})
    const result=JSON.parse(output)
    assert.equal(result.statusCode,200); assert.deepEqual(result.body.response,response)
    assert.equal(result.body.input.location.name,input.location.name)
    const other=JSON.parse(execFileSync(process.execPath,['--import','./tests/unit/register-ts-js-extension-loader.mjs',
      './tests/unit/fixtures/paid-generation-restart.mjs',database,paidId,B],{cwd:root,encoding:'utf8',timeout:20000}))
    assert.equal(other.statusCode,404); assert.ok(!other.body.response)
  })
  await check('real handler with Mock providers commits final validated JSON to PostgreSQL and recovers after post-commit disconnect', async () => {
    // The pruning scenario intentionally used future-dated rows. Restore only
    // these disposable fixtures so a new receipt stays in the latest 30 rows.
    await db.query(`UPDATE public.point_transactions SET created_at=clock_timestamp()-interval '1 day'`)
    for (const mode of ['normal','disconnect-after-commit']) {
      const id=randomUUID(),before=await balance()
      const generated=JSON.parse(execFileSync(process.execPath,['--import','./tests/unit/register-ts-js-extension-loader.mjs',
        './tests/unit/fixtures/paid-generation-native-handler.mjs',database,id,A,mode],{cwd:root,encoding:'utf8',timeout:20000}))
      assert.equal(generated.statusCode,200);assert.equal(generated.snapshot.plans.length,3)
      assert.equal(generated.delivered,mode==='normal');assert.equal(await balance(),before-20)
      assert.equal(await scalar(`SELECT count(*)::int FROM public.point_transactions WHERE id=(SELECT point_transaction_id FROM public.trip_generations WHERE generation_id=$1)`,[id]),1)
      const restored=JSON.parse(execFileSync(process.execPath,['--import','./tests/unit/register-ts-js-extension-loader.mjs',
        './tests/unit/fixtures/paid-generation-restart.mjs',database,id,A],{cwd:root,encoding:'utf8',timeout:20000}))
      assert.deepEqual(restored.body.response,generated.snapshot);assert.equal(await balance(),before-20)
    }
  })
  await check('account deletion removes private generation input and snapshots', async () => {
    await db.query('DELETE FROM auth.users WHERE id=$1',[A])
    assert.equal(await scalar('SELECT count(*)::int FROM public.trip_generations WHERE user_id=$1',[A]),0)
  })
} finally {
  await writeFile(resolve(root,'docs/security/paid-generation-consistency-v1-db-results.json'),JSON.stringify({
    date:'2026-10-27', nativePostgres:version, migrationHash, results, localOnlyTimings:timings,
    limitations:['Synthetic local data and mocked Supabase HTTP; no production or paid API calls.'],
  },null,2)+'\n')
  await Promise.all([...clients].filter(c=>c!==admin).map(close))
  await admin.query(`DROP DATABASE ${database}`); await close(admin)
}
console.log(JSON.stringify({passed:results.length,results},null,2))
