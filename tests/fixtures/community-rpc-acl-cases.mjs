import assert from 'node:assert/strict'

const writes = [
  'share_trip(jsonb,jsonb,text[])', 'unshare_trip(uuid)', 'toggle_shared_trip_like(uuid)',
  'add_shared_trip_comment(uuid,text)', 'delete_shared_trip_comment(uuid)',
  'record_shared_trip_view(uuid)', 'report_shared_trip_comment(uuid,text)',
]
const limiter = 'consume_api_rate_limit(text,integer,integer)'
let sequence = 0

export async function runRpcAclCases(run, fresh, { allMigrations, migrations, bootstrap, apply }) {
  const forward = allMigrations.find(m => m.name.endsWith('_weather_rpc_execute_acl.sql'))
  async function setup(db, through = 19) {
    await db.query(bootstrap)
    for (const m of migrations.slice(0, through)) await apply(db, m.sql)
    if (through === 19) { assert.ok(forward); await apply(db,forward.sql) }
  }
  async function asRole(db, role, sql, params = []) {
    await db.query(`set role ${role}`)
    try { return await db.query(sql, params) } finally { await db.query('reset role') }
  }
  async function contract(db) {
    for (const signature of [...writes, limiter]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const allowed = (await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, `public.${signature}`, 'EXECUTE'])).rows[0].allowed
        assert.equal(allowed, role === (signature === limiter ? 'service_role' : 'authenticated'), `${role} ${signature}`)
      }
      const publicGrant = (await db.query(`select exists(select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as allowed`, [`public.${signature}`])).rows[0].allowed
      assert.equal(publicGrant, false, `PUBLIC ${signature}`)
    }
  }
  const functions = db => db.query(`select p.oid::regprocedure::text as signature,p.prosrc,p.proowner,p.proacl
    from pg_proc p where p.pronamespace='public'::regnamespace order by 1`)
  const defaults = db => db.query('select defaclrole,defaclnamespace,defaclobjtype,defaclacl from pg_default_acl order by 1,2,3')

  await run('real function defaults: only service_role can consume persistent rate limits', async () => {
    const db = await fresh()
    try {
      await setup(db)
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed',[role,`public.${limiter}`,'EXECUTE'])).rows[0].allowed,false)
        await assert.rejects(asRole(db,role,'select consume_api_rate_limit($1,1,60)',['a'.repeat(64)]), e => e.code === '42501')
      }
      assert.equal((await db.query('select count(*)::int as n from api_rate_limits')).rows[0].n,0)
      assert.equal((await asRole(db,'service_role','select consume_api_rate_limit($1,1,60) as allowed',['a'.repeat(64)])).rows[0].allowed,true)
      assert.equal((await asRole(db,'service_role','select consume_api_rate_limit($1,1,60) as allowed',['a'.repeat(64)])).rows[0].allowed,false)
    } finally { await db.end() }
  })
  await run('real function defaults: seven authenticated writes, public feeds and private helpers', async () => {
    const db = await fresh()
    try {
      await setup(db)
      await contract(db)
      for (const role of ['anon','authenticated']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed',[role,'public.shared_trip_feed(uuid,boolean,integer,integer,text)','EXECUTE'])).rows[0].allowed,true)
        assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed',[role,'public._sanitize_shared_trip_plan(jsonb)','EXECUTE'])).rows[0].allowed,false)
      }
      for (const role of ['anon','service_role']) await assert.rejects(asRole(db,role,'select share_trip($1)',[JSON.stringify({})]),e=>e.code==='42501')
      await assert.rejects(asRole(db,'authenticated','select share_trip($1)',[JSON.stringify({})]),e=>e.code==='P0001')
    } finally { await db.end() }
  })
  await run('append-only RPC repair removes deployed ACL drift without changing bodies, data or defaults', async () => {
    const db = await fresh()
    try {
      assert.ok(forward,'append-only repair migration is required')
      await setup(db)
      for (const signature of [...writes,limiter]) await db.query(`grant execute on function public.${signature} to public,anon,authenticated,service_role`)
      const before = (await functions(db)).rows.map(({proacl,...f})=>f)
      const beforeDefaults = (await defaults(db)).rows
      const beforeData = (await db.query('select to_jsonb(p) as row from profiles p order by id')).rows
      await apply(db,forward.sql)
      await contract(db)
      await apply(db,forward.sql)
      await contract(db)
      assert.deepEqual((await functions(db)).rows.map(({proacl,...f})=>f),before)
      assert.deepEqual((await defaults(db)).rows,beforeDefaults)
      assert.deepEqual((await db.query('select to_jsonb(p) as row from profiles p order by id')).rows,beforeData)
    } finally { await db.end() }
  })
  await run('inherited RPC execution causes repair to fail and roll back instead of revoking parent roles', async () => {
    const db = await fresh()
    const parent = `rpc_acl_parent_${++sequence}`
    let created = false
    try {
      assert.ok(forward)
      await setup(db)
      await db.query(`create role ${parent}`); created = true
      await db.query(`grant execute on function public.${limiter} to ${parent}`)
      await db.query(`grant ${parent} to anon`)
      // Ensure the repair makes an actual change before its effective-privilege guard fails.
      await db.query(`grant execute on function public.${limiter} to authenticated`)
      const before = (await functions(db)).rows
      await assert.rejects(apply(db,forward.sql),e=>e.code==='P0001' && /effective RPC EXECUTE/i.test(e.message))
      assert.deepEqual((await functions(db)).rows,before)
      assert.equal((await db.query('select pg_has_role($1,$2,$3) as member',['anon',parent,'MEMBER'])).rows[0].member,true)
    } finally {
      if (created) {
        await db.query(`revoke ${parent} from anon`)
        await db.query(`revoke all on function public.${limiter} from ${parent}`)
        await db.query(`drop role ${parent}`)
      }
      await db.end()
    }
  })
  await run('append-only RPC repair refuses incomplete schemas without changing earlier ACLs', async () => {
    const db = await fresh()
    try {
      assert.ok(forward)
      await setup(db,15)
      const before = (await functions(db)).rows
      await assert.rejects(apply(db,forward.sql),e=>e.code==='P0001' && /Missing required RPC/i.test(e.message))
      assert.deepEqual((await functions(db)).rows,before)
    } finally { await db.end() }
  })
}
