// Actual generation handler + real PostgreSQL RPCs; all supplier/Auth HTTP mocked.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { identityFixture, mockGeneration } from './plan-identity.mjs'
const [database,id,owner,mode='normal']=process.argv.slice(2)
assert.match(database,/^paid_generation_\d+$/)
assert.ok(['normal','disconnect-after-commit'].includes(mode))
const {default:pg}=await import(pathToFileURL(resolve('.tmp/initial-points-concurrency-v1/runtime/node_modules/pg/lib/index.js')).href)
const db=new pg.Client({host:'127.0.0.1',port:55439,user:'postgres',database,password:'',ssl:false})
await db.connect();await db.query('SET ROLE service_role')
Object.assign(process.env,{NODE_ENV:'production',TRIP_CANDIDATE_DEBUG:'false',ENABLE_LOCAL_FALLBACK_REFILL:'false',
  SUPABASE_URL:'https://unit-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'mock-service-key',SUPABASE_ANON_KEY:'mock-public-key',
  OPENAI_API_KEY:'mock-only',GOOGLE_PLACES_API_KEY:'mock-only'})
for(const key of ['debug','info','warn','error'])mock.method(console,key,()=>{})
const f=identityFixture(),calls=mockGeneration({mock},f,f.plans),fetch=globalThis.fetch,controller=new AbortController()
mock.method(globalThis,'fetch',async(url,init)=>{
  const target=new URL(url)
  if(target.hostname!=='unit-test.supabase.co'||target.pathname==='/auth/v1/user')return fetch(url,init)
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer mock-service-key')
  const v=init.body?JSON.parse(init.body):{}
  if(target.pathname.includes('/rpc/')) {
    assert.equal(v.p_user_id,owner);assert.equal(v.p_generation_id,id)
    let result
    if(target.pathname.endsWith('/claim_trip_generation'))result=await db.query('SELECT public.claim_trip_generation($1,$2,$3) AS value',[owner,id,v.p_request_input])
    else if(target.pathname.endsWith('/complete_paid_trip_generation')) {
      result=await db.query('SELECT public.complete_paid_trip_generation($1,$2,$3,$4) AS value',[owner,id,v.p_attempt_token,v.p_response])
      if(mode==='disconnect-after-commit')controller.abort()
    } else if(target.pathname.endsWith('/fail_trip_generation'))result=await db.query('SELECT public.fail_trip_generation($1,$2,$3) AS value',[owner,id,v.p_attempt_token])
    else assert.fail(`Unexpected RPC: ${target.pathname}`)
    return Response.json(result.rows[0].value)
  }
  assert.equal(target.pathname,'/rest/v1/trip_generations')
  assert.equal(target.searchParams.get('user_id'),`eq.${owner}`)
  assert.equal(target.searchParams.get('generation_id'),`eq.${id}`)
  return Response.json((await db.query('SELECT * FROM public.trip_generations WHERE user_id=$1 AND generation_id=$2',[owner,id])).rows[0]??null)
})
try {
  const handler=(await import('../../../api/generate-trip.ts')).default
  const events=[];let statusCode=200,body
  const sink={status(code){statusCode=code;return this},setHeader(){},end(){},json(value){body=value},write(chunk){events.push(JSON.parse(chunk))}}
  const request={method:'POST',body:{generationId:id,input:f.input},headers:{authorization:'Bearer verified-mock-session'},signal:controller.signal}
  await handler(request,sink)
  const row=(await db.query('SELECT * FROM public.trip_generations WHERE generation_id=$1 AND user_id=$2',[id,owner])).rows[0]
  assert.equal(row.status,'completed')
  if(mode==='normal')assert.deepEqual(events.at(-1).response,row.response)
  else assert.ok(!events.some(e=>['plan','done'].includes(e.event)))
  const providers={ai:calls.ai.length,places:calls.places,routes:calls.routes.length}
  if(mode==='normal') {
    await handler(request,sink)
    assert.deepEqual(body,row.response)
    assert.deepEqual({ai:calls.ai.length,places:calls.places,routes:calls.routes.length},providers)
  }
  process.stdout.write(JSON.stringify({statusCode,snapshot:row.response,delivered:events.some(e=>e.event==='done'),providers}))
} finally {mock.restoreAll();mock.timers.reset();await db.end()}
