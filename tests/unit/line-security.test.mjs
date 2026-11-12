import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { messagingApi } from '@line/bot-sdk'
import binding from '../../api/bind-line.ts'
import { bindingSignature, confirmationSignature, createBindingNonce, readBindingNonce, lineGenerationId } from '../../api/_lib/line-security.ts'
import { identityFixture, mockGeneration } from './fixtures/plan-identity.mjs'
import { buildConfirmCostMessage } from '../../api/_lib/line-flex.ts'

Object.assign(process.env,{GOOGLE_PLACES_API_KEY:'unit-places',NODE_ENV:'production',TRIP_CANDIDATE_DEBUG:'false',ENABLE_LOCAL_FALLBACK_REFILL:'false'})
const {default:webhook}=await import('../../api/line-webhook.ts')
const {default:generate,generateTripForLine}=await import('../../api/generate-trip.ts')

const owner = '11111111-1111-4111-8111-111111111111'
const lineId = 'U' + 'a'.repeat(32)
const otherLine = 'U' + 'b'.repeat(32)
function setEnv(t,key,value) { const previous=process.env[key]; process.env[key]=value; t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous}) }
function config(t) {
  for (const [key,value] of Object.entries({ NODE_ENV:'production', GOOGLE_PLACES_API_KEY:'unit-places', TRIP_CANDIDATE_DEBUG:'false', ENABLE_LOCAL_FALLBACK_REFILL:'false', SUPABASE_URL:'https://unit-test.supabase.co', SUPABASE_ANON_KEY:'unit-public', SUPABASE_SERVICE_ROLE_KEY:'unit-service', LINE_APP_URL:'https://demo.example', LINE_CHANNEL_SECRET:'unit-channel-secret', LINE_CHANNEL_ACCESS_TOKEN:'unit-line-token', OPENAI_API_KEY:'unit-ai' })) setEnv(t,key,value)
}
function sink() { return { code:200, body:undefined, events:[], status(n){this.code=n;return this}, json(v){this.body=v}, setHeader(){}, end(){}, write(c){this.events.push(JSON.parse(c))} } }
function signature(raw) { return createHmac('sha256',process.env.LINE_CHANNEL_SECRET).update(raw).digest('base64') }
function event(type='follow') { return { type, timestamp:Date.now(), webhookEventId:randomUUID(), source:{type:'user',userId:lineId}, replyToken:'unit-reply' } }
async function deliver(events, res=sink()) {
  const raw=JSON.stringify({events})
  await webhook({ method:'POST', headers:{'x-line-signature':signature(raw)}, body:raw },res)
  return res
}
function authRpc(t, fn=()=>true) {
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url)
    assert.equal(u.hostname,'unit-test.supabase.co')
    if(u.pathname==='/auth/v1/user')return Response.json({id:owner})
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer unit-service')
    if(u.pathname.endsWith('/consume_api_rate_limit'))return Response.json(true)
    return fn(u,init)
  })
}
for(const bad of ['missing','invalid','changed-whitespace','parsed-body','too-large']) test(`webhook rejects ${bad} before any side effect`,async t=>{
  config(t)
  t.mock.method(globalThis,'fetch',()=>assert.fail('No database call allowed'))
  t.mock.method(messagingApi.MessagingApiClient.prototype,'replyMessage',()=>assert.fail('No LINE call allowed'))
  const raw='{ "events": [] }'
  const req={method:'POST',headers:{'x-line-signature':signature(raw)},body:raw}
  if(bad==='missing')delete req.headers['x-line-signature']
  if(bad==='invalid')req.headers['x-line-signature']='invalid'
  if(bad==='changed-whitespace')req.body=JSON.stringify(JSON.parse(raw))
  if(bad==='parsed-body')req.body=JSON.parse(raw)
  if(bad==='too-large')req.body='x'.repeat(1048577)
  const res=sink();await webhook(req,res)
  assert.equal(res.code,['parsed-body','too-large'].includes(bad)?400:401)
})
test('raw stream is verified without touching the parsed body getter',async t=>{
  config(t)
  const raw='{\n "events": []\n}'
  const req=Readable.from([Buffer.from(raw.slice(0,8)),Buffer.from(raw.slice(8))])
  req.method='POST';req.headers={'x-line-signature':signature(raw)}
  Object.defineProperty(req,'body',{get(){assert.fail('Parsed body must not be accessed')}})
  const res=sink();await webhook(req,res);assert.equal(res.code,200)
})
for(const key of ['LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','LINE_APP_URL','SUPABASE_SERVICE_ROLE_KEY']) test(`missing ${key} fails closed`,async t=>{
  config(t);setEnv(t,key,'')
  t.mock.method(globalThis,'fetch',()=>assert.fail('No side effects'))
  const res=sink();await webhook({method:'POST',body:'{}'},res);assert.equal(res.code,503)
})
for(const handler of [generate,binding]) for(const token of [undefined,'line-internal-bot','public-fallback-token']) test(`public ${handler===generate?'generation':'binding'} rejects ${token||'missing'} token`,async t=>{
  config(t);setEnv(t,'LINE_DEV_BYPASS_TOKEN','public-fallback-token')
  let calls=0
  t.mock.method(globalThis,'fetch',async url=>{assert.match(String(url),/\/auth\/v1\/user$/);calls++;return Response.json({msg:'invalid'},{status:401})})
  const res=sink();await handler({method:'POST',headers:{authorization:token?`Bearer ${token}`:undefined},body:{action:'unbind',lineId}},res)
  assert.equal(res.code,401);assert.equal(calls,token?1:0)
})
test('authenticated unbind ignores client supplied user ID and uses exact RPC',async t=>{
  config(t);let unbind=0
  authRpc(t,(u,init)=>{assert.ok(u.pathname.endsWith('/unbind_line_user'));assert.deepEqual(JSON.parse(init.body),{p_user_id:owner});unbind++;return Response.json({success:true})})
  const res=sink();await binding({method:'POST',headers:{authorization:'Bearer unit-user'},body:{action:'unbind',p_user_id:randomUUID()}},res)
  assert.equal(res.code,200);assert.equal(unbind,1)
})
test('database errors never become successful unbind',async t=>{
  config(t);authRpc(t,()=>Response.json({message:'private DB details'},{status:500}))
  const res=sink();await binding({method:'POST',headers:{authorization:'Bearer unit-user'},body:{action:'unbind'}},res)
  assert.equal(res.code,503);assert.doesNotMatch(JSON.stringify(res.body),/private DB/)
})
test('begin only issues official LINE confirmation; it never binds directly',async t=>{
  config(t)
  t.mock.method(messagingApi.MessagingApiClient.prototype,'issueLinkToken',async id=>{assert.equal(id,lineId);return {linkToken:'single-use-link'}})
  authRpc(t,u=>{assert.ok(u.pathname.endsWith('/profiles'));assert.equal(u.searchParams.get('id'),`eq.${owner}`);return Response.json({id:owner})})
  const ts=Date.now(),res=sink()
  await binding({method:'POST',headers:{authorization:'Bearer unit-user'},body:{action:'begin',line_user_id:lineId,ts,sig:bindingSignature(lineId,ts,process.env.LINE_CHANNEL_SECRET)}},res)
  assert.equal(res.code,200)
  const u=new URL(res.body.url);assert.equal(u.origin,'https://access.line.me')
  const nonce=u.searchParams.get('nonce');assert.ok(nonce.length<=255)
  assert.equal(readBindingNonce(nonce,lineId,process.env.LINE_CHANNEL_SECRET),owner)
  assert.throws(()=>readBindingNonce(nonce,otherLine,process.env.LINE_CHANNEL_SECRET))
  assert.ok(!nonce.includes(owner))
})
for(const bad of ['wrong-signature','expired','public-secret','malformed-json','direct-bind']) test(`binding rejects ${bad}`,async t=>{
  config(t);authRpc(t,()=>assert.fail('No binding or LINE operation'))
  const ts=Date.now()-(bad==='expired'?601000:0)
  let body={action:'begin',line_user_id:lineId,ts,sig:bindingSignature(lineId,ts,bad==='public-secret'?'tripneeder-line-secret':process.env.LINE_CHANNEL_SECRET)}
  if(bad==='wrong-signature')body.sig='0'.repeat(64)
  if(bad==='malformed-json')body='{'
  if(bad==='direct-bind')body.action='bind'
  const res=sink();await binding({method:'POST',headers:{authorization:'Bearer unit-user'},body},res)
  assert.equal(res.code,['direct-bind','malformed-json'].includes(bad)?400:403)
})
test('signed accountLink consumes nonce once, uses verified LINE source and original website owner',async t=>{
  config(t);let claims=0,binds=0,replies=0
  const nonce=createBindingNonce(owner,lineId,process.env.LINE_CHANNEL_SECRET)
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url),args=JSON.parse(init.body)
    if(u.pathname.endsWith('/consume_api_rate_limit')){claims++;return Response.json(claims===1)}
    assert.ok(u.pathname.endsWith('/bind_line_user'));assert.deepEqual(args,{p_user_id:owner,p_line_user_id:lineId});binds++;return Response.json({success:true})
  })
  t.mock.method(messagingApi.MessagingApiClient.prototype,'replyMessage',async()=>{replies++})
  const e={...event('accountLink'),link:{result:'ok',nonce}}
  assert.equal((await deliver([e])).code,200);assert.equal((await deliver([e])).code,200)
  assert.equal(binds,1);assert.equal(replies,1)
})
test('accountLink rejects wrong source, expired nonce and unavailable durable store',async t=>{
  config(t);let calls=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('offline store')})
  let nonce=createBindingNonce(owner,otherLine,process.env.LINE_CHANNEL_SECRET)
  assert.equal((await deliver([{...event('accountLink'),link:{result:'ok',nonce}}])).code,503);assert.equal(calls,0)
  nonce=createBindingNonce(owner,lineId,process.env.LINE_CHANNEL_SECRET)
  t.mock.timers.enable({apis:['Date'],now:Date.now()+601000})
  assert.equal((await deliver([{...event('accountLink'),link:{result:'ok',nonce}}])).code,503);assert.equal(calls,0)
  t.mock.timers.reset()
  nonce=createBindingNonce(owner,lineId,process.env.LINE_CHANNEL_SECRET)
  assert.equal((await deliver([{...event('accountLink'),link:{result:'ok',nonce}}])).code,503);assert.equal(calls,1)
})

for(const kind of ['normal-and-replay','insufficient','ledger-failure','commit-response-lost','parallel']) test(`LINE generation ${kind} uses existing atomic payment path`,async t=>{
  const f=identityFixture(),calls=mockGeneration(t,f,f.plans);config(t)
  for(const name of ['error','warn','debug','info'])t.mock.method(console,name,()=>{})
  const base=globalThis.fetch
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).endsWith('/get_line_user_profile'))return Response.json({id:owner,points_balance:kind==='insufficient'?19:100})
    if(String(url).endsWith('/complete_paid_trip_generation') && ['ledger-failure','commit-response-lost'].includes(kind)){
      if(kind==='commit-response-lost')await base(url,init)
      throw Error('Mock commit/ledger error')
    }
    return base(url,init)
  })
  const id=lineGenerationId('repeat-confirmation'),req={method:'POST',body:{generationId:id,input:f.input}}
  const result=sink()
  if(kind==='parallel'){
    const other=sink();await Promise.all([generateTripForLine(req,result,lineId),generateTripForLine(req,other,lineId)])
    assert.ok([result.code,other.code].includes(202));assert.equal(calls.points,1,JSON.stringify({code:result.code,body:result.body,events:result.events}));assert.equal(calls.ai.length,1)
  }else{
    await generateTripForLine(req,result,lineId)
    if(kind==='insufficient'){assert.equal(result.code,402);assert.equal(calls.points,0);assert.equal(calls.ai.length,0)}
    else if(kind==='ledger-failure'){assert.equal(calls.points,0);assert.ok(!result.events.some(e=>['plan','done'].includes(e.event)))}
    else {assert.equal(calls.points,1,JSON.stringify({code:result.code,body:result.body,events:result.events}));assert.ok(result.events.some(e=>e.event==='done'));const count=calls.ai.length;await generateTripForLine(req,sink(),lineId);assert.equal(calls.points,1,JSON.stringify({code:result.code,body:result.body,events:result.events}));assert.equal(calls.ai.length,count)}
  }
})

test('signed repeated confirmation recovers same paid generation even at zero balance',async t=>{
  config(t)
  const f=identityFixture(),id=lineGenerationId('location-event'),at=Date.now(),claims=[],pushes=[]
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url),v=JSON.parse(init.body)
    if(u.pathname.endsWith('/consume_api_rate_limit'))return Response.json(true)
    if(u.pathname.endsWith('/get_line_user_profile'))return Response.json({id:owner,points_balance:0})
    assert.ok(u.pathname.endsWith('/claim_trip_generation'))
    claims.push(v);assert.equal(v.p_user_id,owner);assert.equal(v.p_generation_id,id)
    return Response.json({outcome:'completed',response:{plans:f.plans}})
  })
  for(const name of ['replyMessage','showLoadingAnimation'])t.mock.method(messagingApi.MessagingApiClient.prototype,name,async()=>({}))
  t.mock.method(messagingApi.MessagingApiClient.prototype,'pushMessage',async v=>{pushes.push(v)})
  const data=new URLSearchParams({action:'confirm_trip_cost',request:id,at:String(at),lat:'25',lng:'121',dur:'180',mode:'car',owner_sig:confirmationSignature(lineId,owner,id,String(at))}).toString()
  for(let i=0;i<2;i++)assert.equal((await deliver([{...event('postback'),postback:{data}}])).code,200)
  assert.equal(claims.length,2);assert.deepEqual(claims[0],claims[1]);assert.equal(pushes.length,2)
  assert.ok(JSON.stringify(pushes).includes(`/line-trip/${id}`));assert.ok(!JSON.stringify(pushes).includes('?plan='))
})
test('configuration quick replies retain stable request and position without instance memory',t=>{
  config(t)
  const id=lineGenerationId('fixture')
  const data=new URLSearchParams({action:'confirm_trip_cost',request:id,at:String(Date.now()),lat:'25.033123456789',lng:'121.565412345678',dur:'180',mode:'public_transit',owner_sig:confirmationSignature(lineId,owner,id,'1')}).toString()
  const message=buildConfirmCostMessage(180,'car',100,data)
  assert.equal(message.quickReply.items.length,9)
  for(const {action} of message.quickReply.items){
    assert.ok(action.data.length<=300)
    if(action.data==='action=cancel_trip')continue
    const p=new URLSearchParams(action.data);assert.equal(p.get('request'),id);assert.equal(p.get('lat'),'25.033123456789')
  }
})

test('a confirmation from a previous binding cannot charge the newly linked owner',async t=>{
  config(t)
  const other='22222222-2222-4222-8222-222222222222',id=lineGenerationId('previous-owner'),at=Date.now()
  const sig=confirmationSignature(lineId,owner,id,String(at))
  let lookups=0
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(String(url).endsWith('/consume_api_rate_limit'))return Response.json(true)
    assert.ok(String(url).endsWith('/get_line_user_profile'),'Cannot claim or debit')
    lookups++;return Response.json({id:other,points_balance:100})
  })
  const data=new URLSearchParams({action:'confirm_trip_cost',request:id,at:String(at),lat:'25',lng:'121',dur:'180',mode:'car',owner_sig:sig}).toString()
  assert.equal((await deliver([{...event('postback'),postback:{data}}])).code,503)
  const res=sink();await generateTripForLine({method:'POST'},res,lineId,owner)
  assert.equal(res.code,409);assert.equal(lookups,2)
})
test('rain backup reads a paid snapshot scoped to the current bound owner',async t=>{
  config(t);let reads=0
  t.mock.method(globalThis,'fetch',async(url)=>{
    const u=new URL(url)
    if(u.pathname.endsWith('/consume_api_rate_limit'))return Response.json(true)
    if(u.pathname.endsWith('/get_line_user_profile'))return Response.json({id:owner,points_balance:0})
    assert.ok(u.pathname.endsWith('/trip_generations'));assert.equal(u.searchParams.get('user_id'),`eq.${owner}`)
    reads++;return Response.json(null)
  })
  t.mock.method(messagingApi.MessagingApiClient.prototype,'replyMessage',()=>assert.fail('Foreign snapshot must not be delivered'))
  const data=new URLSearchParams({action:'rain_backup',generation_id:randomUUID(),plan_id:'safe',stops:'untrusted'}).toString()
  assert.equal((await deliver([{...event('postback'),postback:{data}}])).code,503);assert.equal(reads,1)
})
