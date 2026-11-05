// Local isolated test databases only. Does not read .env, DATABASE_URL, or Supabase.
import assert from 'node:assert/strict'
import pg from 'pg'
import { runWeatherUpgradeCases, migrations, rpcAclRepair, bootstrap, apply, auth, plan } from '../tests/fixtures/weather-upgrade-cases.mjs'

const port=Number(process.env.WEATHER_TEST_PG_PORT || 56589)
assert.ok(Number.isInteger(port) && port>=1024 && port<=65535)
const config={host:'127.0.0.1',port,user:'weather_test_admin',password:process.env.WEATHER_TEST_PG_PASSWORD,database:'postgres',ssl:false,connectionTimeoutMillis:5000,statement_timeout:30000}
const admin=new pg.Client(config)
await admin.connect()
let next=0,failed=0
const databases=[]
async function fresh() {
  const database=`weather_integration_test_${process.pid}_${++next}`
  assert.match(database,/^weather_integration_test_\d+_\d+$/)
  await admin.query(`create database ${database}`); databases.push(database)
  const db=new pg.Client({...config,database}); await db.connect(); return db
}
async function run(name,fn) {
  try {await fn(); console.log(`PASS ${name}`)} catch(e) {failed++; console.error(`FAIL ${name}: ${e.code || ''} ${e.message}`)}
}
try {
  console.log((await admin.query('select version()')).rows[0].version)
  for(const role of ['anon','authenticated','service_role']) {
    await admin.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role} nologin ${role==='service_role'?'bypassrls':''}; end if; end $$`)
  }
  await runWeatherUpgradeCases(run,fresh)
  await run('two real connections sharing simultaneously return one share ID',async()=>{
    const first=await fresh()
    const second=new pg.Client({...config,database:first.database})
    try {
      await first.query(bootstrap)
      for(const f of migrations) await apply(first,f.sql)
      await apply(first,rpcAclRepair.sql)
      const owner='00000000-0000-4000-8000-000000000001'
      await first.query('insert into auth.users values($1)',[owner])
      await auth(first,owner,'select initialize_user_profile()')
      await second.connect()
      const [a,b]=await Promise.all([first,second].map(db=>auth(db,owner,'select share_trip($1) as id',[JSON.stringify(plan())])))
      assert.equal(a.rows[0].id,b.rows[0].id)
      assert.equal((await first.query('select count(*)::int as n from shared_trips')).rows[0].n,1)
    } finally {await first.end(); await second.end()}
  })
} finally {
  for(const database of databases) await admin.query(`drop database ${database}`)
  await admin.end()
}
console.log(`Native PostgreSQL: ${next-failed}/${next} passed`)
if(failed) process.exitCode=1
