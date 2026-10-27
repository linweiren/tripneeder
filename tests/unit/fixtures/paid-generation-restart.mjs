// New server process. Auth and HTTP transport are mocked; snapshot is read from native PostgreSQL.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import https from 'node:https'
const [database,id,owner]=process.argv.slice(2)
assert.match(database,/^paid_generation_\d+$/)
const { default: pg } = await import(pathToFileURL(resolve('.tmp/initial-points-concurrency-v1/runtime/node_modules/pg/lib/index.js')).href)
const db = new pg.Client({host:'127.0.0.1',port:55439,user:'postgres',database,password:'',ssl:false})
await db.connect(); await db.query('SET ROLE service_role')
Object.assign(process.env,{SUPABASE_URL:'https://unit-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'mock-only',SUPABASE_ANON_KEY:'mock-only'})
mock.method(https,'request',()=>assert.fail('No paid API or live Supabase is permitted'))
mock.method(globalThis,'fetch',async (url,init)=>{
  const target=new URL(url)
  assert.equal(target.hostname,'unit-test.supabase.co')
  if(target.pathname==='/auth/v1/user') return Response.json({id:owner,role:'authenticated'})
  assert.equal(target.pathname,'/rest/v1/trip_generations')
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer mock-only')
  assert.equal(target.searchParams.get('user_id'),`eq.${owner}`)
  assert.equal(target.searchParams.get('generation_id'),`eq.${id}`)
  const result=await db.query('SELECT * FROM public.trip_generations WHERE user_id=$1 AND generation_id=$2',[owner,id])
  return Response.json(result.rows[0]??null)
})
try {
  const handler=(await import('../../../api/trip-generations.ts')).default
  let statusCode=200, body
  const sink={status(code){statusCode=code;return this},json(value){body=value},setHeader(){},end(){}}
  await handler({method:'GET',url:`/?generationId=${id}`,headers:{authorization:'Bearer verified-mock-session'}},sink)
  process.stdout.write(JSON.stringify({statusCode,body}))
} finally {mock.restoreAll();await db.end()}
