import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { EventEmitter } from 'node:events'
import { identityFixture, mockGeneration } from './fixtures/plan-identity.mjs'
import { ProxyTripPlanner } from '../../src/services/ai/proxyTripPlanner.ts'
import { generationInput } from '../../api/_lib/trip-generations.ts'
import { getGenerationId, loadAnalysisSession, saveAnalysisSession, clearStoredAnalysisSession } from '../../src/services/ai/generationSessionStorage.ts'

Object.assign(process.env,{NODE_ENV:'production',TRIP_CANDIDATE_DEBUG:'false',ENABLE_LOCAL_FALLBACK_REFILL:'false',
  OPENAI_API_KEY:'mock-only',GOOGLE_PLACES_API_KEY:'mock-only',SUPABASE_URL:'https://unit-test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'mock-service-key',SUPABASE_ANON_KEY:'mock-public-key'})
const handler=(await import('../../api/generate-trip.ts')).default
const recovery=(await import('../../api/trip-generations.ts')).default
const A='11111111-1111-4111-8111-111111111111'
const proxyInput={startTime:'10:00',endTime:'15:00',tags:[],location:{name:'mock'}}
function storageMock(t,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  Object.defineProperty(globalThis,'localStorage',{value,configurable:true,writable:true})
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage})
}
function setup(t) {
  const deny=()=>assert.fail('Unmocked network forbidden')
  t.mock.method(http,'request',deny); t.mock.method(net,'connect',deny); t.mock.method(net,'createConnection',deny); t.mock.method(tls,'connect',deny)
  for (const key of ['debug','info','warn','error']) t.mock.method(console,key,()=>{})
  const f=identityFixture(), calls=mockGeneration(t,f,f.plans)
  return {f,calls}
}
function sink(onWrite) {
  return {statusCode:200,headers:{},events:[],body:undefined,
    status(code){this.statusCode=code;return this},setHeader(k,v){this.headers[k]=v},
    json(value){this.body=value},write(chunk){const event=JSON.parse(chunk);onWrite?.(event);this.events.push(event)},end(){}}
}
async function invoke(f,id=randomUUID(),res=sink(),signal) {
  await handler({method:'POST',body:{generationId:id,input:structuredClone(f.input)},headers:{authorization:'Bearer mock-valid-session'},signal},res)
  return res
}
function mockBalance(t,value) {
  const request=https.request
  t.mock.method(https,'request',(url,options,callback)=>{
    if (!String(url).endsWith('/get_my_points_balance')) return request(url,options,callback)
    const req=new EventEmitter(); req.write=()=>{};req.setTimeout=()=>req;req.destroy=e=>req.emit('error',e)
    req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};callback(res);res.emit('data',Buffer.from(String(value)));res.emit('end')})
    return req
  })
}

test('normal handler delivers only committed final JSON; same UUID replay adds zero provider calls or charges',async t=>{
  const {f,calls}=setup(t), id=randomUUID(), seen=[]
  const res=await invoke(f,id,sink(event=>{
    seen.push(event.event)
    if (['plan','done'].includes(event.event)) assert.equal(calls.generations.get(id).status,'completed')
    else assert.ok(!/stops|placeId|latitude|longitude|transportSegments|title|summary/.test(JSON.stringify(event)))
  }))
  assert.equal(res.events.at(-1).event,'done');assert.equal(calls.points,1)
  assert.deepEqual(res.events.at(-1).response,calls.generations.get(id).response)
  assert.deepEqual(res.events.filter(e=>e.event==='plan').map(e=>e.plan),res.events.at(-1).response.plans)
  assert.equal(res.events.filter(e=>e.event==='progress').length,3)
  const before={ai:calls.ai.length,places:calls.places,routes:calls.routes.length}
  mockBalance(t,0);delete process.env.OPENAI_API_KEY
  try {
    const replay=await invoke(f,id)
    assert.equal(replay.statusCode,200);assert.deepEqual(replay.body,res.events.at(-1).response)
  } finally {process.env.OPENAI_API_KEY='mock-only'}
  assert.deepEqual({ai:calls.ai.length,places:calls.places,routes:calls.routes.length},before);assert.equal(calls.points,1)
})
test('preflight 19 points invokes zero paid providers and no completion',async t=>{
  const {f,calls}=setup(t);mockBalance(t,19)
  const result=await invoke(f)
  assert.equal(result.statusCode,402);assert.equal(calls.points,0);assert.equal(calls.ai.length+calls.places+calls.routes.length,0)
  assert.deepEqual(result.events,[])
})
for (const kind of ['payment-rejected','commit-response-lost','confirmation-outage']) test(kind,async t=>{
  const {f,calls}=setup(t), id=randomUUID(), fetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const path=new URL(url).pathname
    if(path.endsWith('/complete_paid_trip_generation')) {
      if(kind==='commit-response-lost') await fetch(url,init)
      throw Error('Mock RPC transport lost')
    }
    if(kind==='confirmation-outage' && path.endsWith('/trip_generations')) return Response.json({}, {status:503})
    return fetch(url,init)
  })
  const result=await invoke(f,id)
  if(kind==='commit-response-lost') {
    assert.equal(result.events.at(-1).event,'done');assert.equal(calls.points,1)
    const before=calls.ai.length;await invoke(f,id);assert.equal(calls.ai.length,before);assert.equal(calls.points,1)
  } else {
    assert.equal(calls.points,0)
    assert.ok(!result.events.some(e=>['plan','done','points_warning'].includes(e.event)))
    assert.ok(result.events.some(e=>e.event==='error'))
    assert.equal(calls.generations.get(id).status,'running','unconfirmed submission must not blindly fail/restart')
  }
})
test('observed disconnect before payment cancels and fails only the unpaid attempt',async t=>{
  const {f,calls}=setup(t),id=randomUUID(),controller=new AbortController()
  const result=await invoke(f,id,sink(e=>{if(e.event==='progress')controller.abort()}),controller.signal)
  assert.equal(calls.points,0);assert.equal(calls.generations.get(id).status,'failed')
  assert.ok(!result.events.some(e=>['plan','done'].includes(e.event)))
})
test('disconnect after commit before plan: recovery returns saved final JSON, with one charge and zero extra AI',async t=>{
  const {f,calls}=setup(t),id=randomUUID(),controller=new AbortController(),fetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const result=await fetch(url,init)
    if(String(url).endsWith('/complete_paid_trip_generation')) controller.abort()
    return result
  })
  const result=await invoke(f,id,sink(),controller.signal)
  assert.equal(calls.points,1);assert.ok(!result.events.some(e=>['plan','done'].includes(e.event)))
  const res=sink(),before=calls.ai.length
  await recovery({method:'GET',url:`/?generationId=${id}`,headers:{authorization:'Bearer valid'}},res)
  assert.equal(res.body.status,'completed');assert.deepEqual(res.body.response,calls.generations.get(id).response)
  assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(calls.ai.length,before)
})
test('same UUID parallel POST produces one generation; another input conflicts before providers',async t=>{
  const {f,calls}=setup(t),id=randomUUID()
  const results=await Promise.all([invoke(f,id),invoke(f,id)])
  assert.ok(results.some(r=>r.statusCode===202));assert.equal(calls.ai.length,1);assert.equal(calls.points,1)
  const before=calls.places
  const other={...f,input:{...f.input,endTime:'16:00'}}
  assert.equal((await invoke(other,id)).statusCode,409);assert.equal(calls.points,1);assert.equal(calls.places,before)
})
for(const code of [401,403,503]) test(`generate and recovery reject unverified session (${code}) before providers`,async t=>{
  const {f,calls}=setup(t),fetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(url,init)=>String(url).endsWith('/auth/v1/user')?Response.json({msg:'bad token'},{status:code}):fetch(url,init))
  const result=await invoke(f)
  assert.equal(result.statusCode,code===503?503:401);assert.equal(calls.generations.size,0)
  const res=sink();await recovery({method:'GET',url:`/?generationId=${randomUUID()}`,headers:{authorization:'Bearer forged'}},res)
  assert.equal(res.statusCode,code===503?503:401);assert.equal(calls.ai.length+calls.places+calls.points,0)
})
test('recovery list and lookup explicitly bind the verified owner and never expose internal credentials',async t=>{
  setup(t);const fetch=globalThis.fetch
  let ownerChecks=0
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url)
    if(u.pathname.endsWith('/trip_generations')) {
      ownerChecks++;assert.equal(u.searchParams.get('user_id'),`eq.${A}`)
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer mock-service-key')
      assert.ok(!/attempt_token|error_code/.test(u.searchParams.get('select')))
      return Response.json(u.searchParams.has('generation_id')?null:[])
    }
    return fetch(url,init)
  })
  const missing=sink();await recovery({method:'GET',url:`/?generationId=${randomUUID()}`,headers:{authorization:'Bearer valid'}},missing)
  assert.equal(missing.statusCode,404)
  const list=sink();await recovery({method:'GET',url:'/?offset=0',headers:{authorization:'Bearer valid'}},list)
  assert.deepEqual(list.body,{generations:[],nextOffset:null});assert.equal(ownerChecks,2)
})
test('proxy EOF recovers original ID and cannot start a second paid call while status is unknown',async t=>{
  const id=randomUUID(),urls=[]
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    urls.push(String(url))
    if(String(url)==='/api/generate-trip') {
      assert.equal(JSON.parse(init.body).generationId,id)
      return new Response('',{headers:{'content-type':'application/x-ndjson'}})
    }
    assert.ok(String(url).includes(id))
    return Response.json({status:'completed',input:proxyInput,response:{plans:[{id:'safe'}]}})
  })
  assert.deepEqual(await new ProxyTripPlanner().generateTripPlans({generationId:id,input:proxyInput}),{plans:[{id:'safe'}]})
  assert.equal(urls.filter(u=>u==='/api/generate-trip').length,1)
})
test('proxy confirmation outage preserves ID and sends no speculative retry',async t=>{
  let posts=0,reads=0
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url)==='/api/generate-trip') {posts++;throw Error('connection lost')}
    reads++;return Response.json({},{status:503})
  })
  await assert.rejects(new ProxyTripPlanner().generateTripPlans({generationId:randomUUID(),input:{}}),/原生成/)
  assert.equal(posts,1);assert.equal(reads,1)
})
test('proxy 202 polls and only takes over the same UUID after confirmed lease expiry',async t=>{
  const id=randomUUID();let posts=0
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url)==='/api/generate-trip') {
      posts++;assert.equal(JSON.parse(init.body).generationId,id)
      return posts===1?Response.json({status:'running'},{status:202}):Response.json({plans:[{id:'safe'}]})
    }
    return Response.json({status:'running',retryable:true})
  })
  await new ProxyTripPlanner().generateTripPlans({generationId:id,input:{}});assert.equal(posts,2)
})
test('persisted input allowlist omits credential and arbitrary fields',()=>{
  const input=generationInput({startTime:'10:00',endTime:'15:00',tags:[],location:{name:'fixture',token:'secret'},accessToken:'secret',apiKey:'secret'})
  assert.doesNotMatch(JSON.stringify(input),/secret|Token|apiKey/)
})

test('proxy 409 is terminal and cannot recover the old paid snapshot under a different input',async t=>{
  let calls=0
  t.mock.method(globalThis,'fetch',async url=>{calls++;assert.equal(url,'/api/generate-trip');return Response.json({error:'輸入不符'},{status:409})})
  await assert.rejects(new ProxyTripPlanner().generateTripPlans({generationId:randomUUID(),input:proxyInput}),/輸入不符/)
  assert.equal(calls,1)
})
test('proxy refuses recovered snapshot if input differs after a lost 409 response',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    if(url==='/api/generate-trip') throw Error('connection lost')
    return Response.json({status:'completed',input:{...proxyInput,endTime:'16:00'},response:{plans:[{id:'safe'}]}})
  })
  await assert.rejects(new ProxyTripPlanner().generateTripPlans({generationId:randomUUID(),input:proxyInput}),/輸入不符/)
})

test('browser durable IDs survive reload and TTL, isolate accounts, and change only for new input or successful new generation',t=>{
  const storage=new Map()
  storageMock(t,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)})
  const first=getGenerationId(proxyInput,A)
  saveAnalysisSession({status:'analyzing',userId:A,generationId:first,input:proxyInput,startedAt:0,updatedAt:0,lastRoute:'/'},true)
  assert.equal(loadAnalysisSession(A).generationId,first)
  assert.equal(getGenerationId(proxyInput,A),first)
  assert.equal(getGenerationId(proxyInput,A,first),first)
  assert.notEqual(getGenerationId({...proxyInput,endTime:'16:00'},A),first)
  assert.equal(loadAnalysisSession('another-account'),null)
  assert.notEqual(getGenerationId(proxyInput,'another-account'),first)
  saveAnalysisSession({...loadAnalysisSession(A),status:'success'})
  assert.notEqual(getGenerationId(proxyInput,A),first)
  clearStoredAnalysisSession('another-account');assert.equal(loadAnalysisSession(A).generationId,first)
  assert.doesNotMatch([...storage.values()].join(''),/access_token|Bearer|mock-service-key/)
})
test('browser persistence failure stops before a paid request and still allows an error screen',t=>{
  storageMock(t,{getItem:()=>null,setItem:()=>{throw Error('blocked')},removeItem:()=>{}})
  const record={status:'analyzing',generationId:randomUUID(),userId:A,input:proxyInput}
  assert.throws(()=>saveAnalysisSession(record,true),/尚未啟動付費生成/)
  assert.doesNotThrow(()=>saveAnalysisSession({...record,status:'error'}))
})
