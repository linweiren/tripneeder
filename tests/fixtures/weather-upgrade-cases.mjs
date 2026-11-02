import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { deduplicateAndValidateSharedTrips, getSharedPlanSignature, isShareablePlan, sanitizeSharedPlan } from '../../src/services/community/communityData.js'

const migrationRoot = new URL('../../supabase/migrations/', import.meta.url)
export const migrations = readdirSync(migrationRoot).filter(x => /^\d.*\.sql$/.test(x)).sort().map(name => ({name, sql: readFileSync(new URL(name, migrationRoot), 'utf8')}))
const legacyManifest = JSON.parse(readFileSync(new URL('./weather-legacy/manifest.json', import.meta.url), 'utf8'))
const oldSql = (ref, name) => readFileSync(new URL(`./weather-legacy/${legacyManifest[ref][name]}`, import.meta.url), 'utf8')
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
export const bootstrap = `create schema auth; create table auth.users(id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema public,auth to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`
export const plan = (extra={}) => ({id:'same-plan',type:'balanced',title:'台北行程',subtitle:'',summary:'',totalTime:100,budget:500,transportMode:'car',isDetailComplete:true,
  stops:[{id:'s1',name:'Cafe',type:'food',duration:35,lat:25,lng:121,address:'private-a'}, {id:'s2',name:'Park',type:'main_activity',duration:45}],
  transportSegments:[{fromStopId:'s1',toStopId:'s2',mode:'car',duration:20,label:'Driving'}],
  rainBackup:[{id:'r1',name:'Rain cafe',type:'food',duration:30},{id:'r2',name:'Museum',type:'main_activity',duration:40}],
  rainTransportSegments:[{fromStopId:'r1',toStopId:'r2',mode:'public_transit',duration:18,label:'Bus',publicTransitType:'bus'}],...extra})
export async function apply(db, sql) {
  await db.query('begin')
  try {await db.query(sql); await db.query('commit')}
  catch(e) {await db.query('rollback'); throw e}
}
async function setup(db, through=19, ref) {
  await db.query(bootstrap)
  for(const f of migrations.slice(0,through)) await apply(db, ref && /^01[1-8]_/.test(f.name) ? oldSql(ref,f.name) : f.sql)
}
export async function auth(db,id,sql,params=[]) {
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,email:'fixture@example.invalid'})])
  await db.query('set role authenticated')
  try {return await db.query(sql,params)} finally {await db.query('reset role')}
}
async function users(db,count=12) {
  for(let i=1;i<=count;i++) {
    await db.query('insert into auth.users values($1)',[uid(i)])
    await auth(db,uid(i),'select initialize_user_profile()')
  }
}
async function seed(db,plans,stage) {
  await users(db,2)
  for(let i=0;i<plans.length;i++) {
    await db.query(`insert into shared_trips(id,owner_id,author_display_name,plan,input,like_count) values($1,$2,'Traveler',$3,'{"private":"input"}',1)`,[uid(100+i),uid(1),JSON.stringify(plans[i])])
    await db.query('insert into shared_trip_likes(shared_trip_id,user_id) values($1,$2)',[uid(100+i),uid(2)])
    if(stage>=12) {
      await db.query(`insert into shared_trip_comments(id,shared_trip_id,user_id,author_display_name,body) values($1,$2,$3,'Reader','Keep this')`,[uid(200+i),uid(100+i),uid(2)])
      await db.query('insert into shared_trip_views(shared_trip_id,user_id) values($1,$2)',[uid(100+i),uid(2)])
    }
    if(stage>=16) await db.query(`insert into shared_trip_comment_reports(comment_id,reporter_id,reason) values($1,$2,'spam')`,[uid(200+i),uid(1)])
  }
}
export async function snapshot(db,stage=19) {
  const tables=['shared_trips','shared_trip_likes','profiles','point_transactions']
  if(stage>=12) tables.push('shared_trip_comments','shared_trip_views')
  if(stage>=16) tables.push('shared_trip_comment_reports')
  return Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await db.query(`select to_jsonb(t) ${stage<12 && t==='shared_trips' ? "- 'tags'" : ''} as row from ${t} t order by to_jsonb(t)::text`)).rows])))
}
const legacyPlans=()=>[
  plan(), plan({stops:[{...plan().stops[0],lat:26,address:'private-b'},plan().stops[1]]}),
  plan({privatePreference:'one'}),plan({privatePreference:'two'}),
  plan({isDetailComplete:false}),plan({stops:null}),plan({rainBackup:{broken:true}}),
  plan({totalTime:'bad-number'}),plan({budget:{bad:true}}),plan({isDetailComplete:'true'}),
  plan({stops:[null,42,[],{}]}), plan({transportSegments:{bad:true}}),
  plan({scheduleStartTime:['10:00']}),plan({id:'edge',totalTime:1e50}),
  plan({id:'duplicate-stops',stops:[plan().stops[0],plan().stops[0]]}),
  plan({id:'bad-google',stops:[{...plan().stops[0],googleTypes:[{},null,7]}]}),
]

// Both adapters execute entire migration files, never extracted or patched SQL.
export async function runWeatherUpgradeCases(run, fresh) {
  await run('clean 001-019: public contract, points, permissions and repeat repair',async()=>{
    const db=await fresh()
    try {
      await setup(db); await users(db)
      const before=(await db.query('select id,points_balance from profiles order by id')).rows
      const ledger=(await db.query('select * from point_transactions order by id')).rows
      const original=plan()
      const share=(await auth(db,uid(1),'select share_trip($1,null,$2) as id',[JSON.stringify(sanitizeSharedPlan(original)),['test']])).rows[0].id
      const feed=(await db.query("select * from shared_trip_feed(null,false,30,0,'newest')")).rows
      assert.equal(feed.length,1); assert.equal(feed[0].input,null)
      assert.equal(deduplicateAndValidateSharedTrips(JSON.parse(JSON.stringify(feed))).length,1)
      assert.equal(getSharedPlanSignature(feed[0].plan),getSharedPlanSignature(original))
      assert.equal(feed[0].plan.transportSegments[0].duration,20)
      assert.equal(feed[0].plan.rainTransportSegments[0].duration,18)
      assert.equal((await auth(db,uid(1),'select share_trip($1,null,$2) as id',[JSON.stringify(original),['same']])).rows[0].id,share)
      for(let i=2;i<=12;i++) await auth(db,uid(i),'select * from toggle_shared_trip_like($1)',[share])
      assert.deepEqual((await db.query('select id,points_balance from profiles order by id')).rows,before)
      assert.deepEqual((await db.query('select * from point_transactions order by id')).rows,ledger)
      assert.equal((await db.query('select like_count from shared_trips')).rows[0].like_count,11)
      await auth(db,uid(2),'select add_shared_trip_comment($1,$2)',[share,'Hello'])
      await auth(db,uid(2),'select record_shared_trip_view($1)',[share])
      await assert.rejects(auth(db,uid(2),'select unshare_trip($1)',[share]))
      await db.query('set role anon')
      try {
        await assert.rejects(db.query('select * from shared_trips'),e=>e.code==='42501')
        assert.equal((await db.query('select * from shared_trip_feed()')).rows.length,1)
        await assert.rejects(db.query('select toggle_shared_trip_like($1)',[share]),e=>e.code==='42501')
      } finally {await db.query('reset role')}
      await auth(db,uid(1),"select consume_points_for_analysis(20,'regression')")
      assert.equal((await db.query('select points_balance from profiles where id=$1',[uid(1)])).rows[0].points_balance,80)
      const beforeRepair=await snapshot(db)
      await apply(db,migrations[18].sql); await apply(db,migrations[18].sql)
      assert.deepEqual(await snapshot(db),beforeRepair)
      await auth(db,uid(1),'select unshare_trip($1)',[share])
      assert.equal((await db.query('select * from shared_trip_comments')).rows.length,0)
    } finally {await db.end()}
  })
  for(const ref of ['corrected','de069c6','a8ce99c']) {
    const stages=ref==='corrected' ? [11,12,13,14,15,16,17,18] : ref==='de069c6' ? [11,12,13,14,15,16,17] : [18]
    for(const stage of stages) await run(`${ref} ${stage} -> 019: retain raw shares, interactions, transport and ledger`,async()=>{
      const db=await fresh()
      try {
        await setup(db,stage,ref==='corrected'?undefined:ref)
        await seed(db,legacyPlans(),stage)
        if(ref==='de069c6') {
          await db.query('update profiles set points_balance=130 where id=$1',[uid(1)])
          await db.query("insert into point_transactions(user_id,type,amount,balance_after,reason) values($1,'share_reward',30,130,'historical reward')",[uid(1)])
        }
        const before=await snapshot(db,stage)
        for(const f of migrations.slice(stage)) {
          await apply(db,f.sql)
          assert.deepEqual(await snapshot(db,stage),before,`data changed during ${f.name}`)
        }
        const feed=(await db.query('select * from shared_trip_feed()')).rows
        assert.equal(feed.length,4)
        assert.equal(deduplicateAndValidateSharedTrips(JSON.parse(JSON.stringify(feed))).length,4)
        assert.ok(feed.every(row=>row.plan.transportSegments[0].duration===20 && row.plan.rainTransportSegments[0].duration===18))
        assert.ok(feed.every(row=>row.input===null && !JSON.stringify(row.plan).includes('private')))
        const repeat=(await auth(db,uid(1),'select share_trip($1,null,$2) as id',[JSON.stringify(plan()),[]])).rows[0].id
        assert.equal(repeat,uid(100))
      } finally {await db.end()}
    })
  }
  await run('SQL / frontend agree on malformed JSON and optional fields',async()=>{
    const db=await fresh()
    try {
      await setup(db)
      const values=[undefined,null,[],{},42,'bad',true]
      const variants=[...legacyPlans(),...values.flatMap(value=>['scheduleStartTime','stops','rainBackup','transportSegments','rainTransportSegments','totalTime','budget','title','id'].map(key=>plan({[key]:value}))),...values.map(label=>plan({transportSegments:[{...plan().transportSegments[0],label}]})),plan({scheduleStartTime:'10:30'}),plan({scheduleStartTime:'24:00'}),plan({title:'  spaced title  ',stops:[{...plan().stops[0],name:'  Cafe  '},plan().stops[1]]})]
      for(const candidate of variants) {
        const wire=JSON.parse(JSON.stringify(candidate))
        const {rows}=await db.query('select _is_valid_shared_trip_plan($1) as valid, _sanitize_shared_trip_plan($1) as plan',[JSON.stringify(wire)])
        assert.equal(rows[0].valid,isShareablePlan(wire),JSON.stringify(wire))
        if(rows[0].valid) assert.equal(getSharedPlanSignature(rows[0].plan),getSharedPlanSignature(wire))
      }
    } finally {await db.end()}
  })
  for(const stage of [16,17]) await run(`historical ${stage} -> 019 directly: no replay and no new rewards`,async()=>{
    const db=await fresh()
    try {
      await setup(db,stage,'de069c6'); await seed(db,legacyPlans(),stage)
      const before=await snapshot(db,stage)
      await apply(db,migrations[18].sql)
      assert.deepEqual(await snapshot(db,stage),before)
      for(let i=3;i<=12;i++) {
        await db.query('insert into auth.users values($1)',[uid(i)])
        await auth(db,uid(i),'select initialize_user_profile()')
      }
      const balances=(await db.query('select id,points_balance from profiles order by id')).rows
      const ledger=(await db.query('select * from point_transactions order by id')).rows
      for(let i=2;i<=12;i++) await auth(db,uid(i),'select toggle_shared_trip_like($1)',[uid(100)])
      assert.deepEqual((await db.query('select id,points_balance from profiles order by id')).rows,balances)
      assert.deepEqual((await db.query('select * from point_transactions order by id')).rows,ledger)
      assert.equal((await db.query('select * from shared_trip_feed()')).rows.length,4)
    } finally {await db.end()}
  })
  for(const order of ['dev-first','weather-first']) await run(`${order}: preserve dev balances, ledger, ACL and normal debit`,async()=>{
    const db=await fresh()
    const devRoot=new URL('./dev-points/',import.meta.url)
    try {
      await setup(db,order==='dev-first'?10:19)
      for(const file of readdirSync(devRoot).sort()) await apply(db,readFileSync(new URL(file,devRoot),'utf8'))
      await users(db,2)
      await auth(db,uid(1),"select consume_points_for_analysis(20,'before-weather')")
      const balances=(await db.query('select * from profiles order by id')).rows
      const ledger=(await db.query('select * from point_transactions order by id')).rows
      for(const f of order==='dev-first'?migrations.slice(10):[migrations[18]]) await apply(db,f.sql)
      assert.deepEqual((await db.query('select * from profiles order by id')).rows,balances)
      assert.deepEqual((await db.query('select * from point_transactions order by id')).rows,ledger)
      await assert.rejects(auth(db,uid(1),'update profiles set points_balance=9999 where id=$1',[uid(1)]),e=>e.code==='42501')
      await auth(db,uid(1),"select consume_points_for_analysis(2,'after-weather')")
      assert.equal((await db.query('select points_balance from profiles where id=$1',[uid(1)])).rows[0].points_balance,78)
      const shared=(await auth(db,uid(1),'select share_trip($1) as id',[JSON.stringify(plan())])).rows[0].id
      await auth(db,uid(2),'select toggle_shared_trip_like($1)',[shared])
      assert.equal((await db.query('select points_balance from profiles where id=$1',[uid(1)])).rows[0].points_balance,78)
    } finally {await db.end()}
  })
  await run('unexpected feed dependency aborts repair and rolls back DDL and data',async()=>{
    const db=await fresh()
    try {
      await setup(db); await seed(db,[plan()],19)
      await db.query('create view weather_dependency_fixture as select * from shared_trip_feed()')
      const definitions=()=>db.query("select pg_get_functiondef(oid) as definition,proacl from pg_proc where pronamespace='public'::regnamespace order by oid")
      const before=await snapshot(db),functions=(await definitions()).rows
      await assert.rejects(apply(db,migrations[18].sql),e=>e.code==='2BP01')
      assert.deepEqual(await snapshot(db),before)
      assert.deepEqual((await definitions()).rows,functions)
    } finally {await db.end()}
  })
  await run('a valid new share never reuses an invalid hidden legacy row',async()=>{
    const db=await fresh()
    try {
      await setup(db)
      const broken=plan({id:'previously-hidden',scheduleStartTime:['10:00']})
      await seed(db,[broken],19)
      const before=await snapshot(db)
      const shared=(await auth(db,uid(1),'select share_trip($1) as id',[JSON.stringify(plan({id:'previously-hidden'}))])).rows[0].id
      assert.notEqual(shared,uid(100))
      const feed=(await db.query('select * from shared_trip_feed()')).rows
      assert.equal(feed.length,1); assert.equal(feed[0].id,shared)
      const after=await snapshot(db)
      assert.deepEqual(after.shared_trips.find(x=>x.row.id===uid(100)),before.shared_trips[0])
      for(const table of ['shared_trip_likes','shared_trip_comments','shared_trip_views','shared_trip_comment_reports']) assert.deepEqual(after[table],before[table])
    } finally {await db.end()}
  })
}
