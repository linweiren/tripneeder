import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readGitRevision } from '../../api/_lib/git-revision.js'
import { geocodeLocation } from '../../src/services/geocoding.js'
import { getPlanDetailStateKey } from '../../src/utils/detailIdentity.js'
import { isShareablePlan, sanitizeSharedPlan, getSharedPlanSignature } from '../../src/services/community/communityData.js'
import { identityFixture, mockGeneration } from './fixtures/plan-identity.mjs'

Object.assign(process.env,{SUPABASE_URL:'https://unit-test.supabase.co',SUPABASE_ANON_KEY:'mock-anon',SUPABASE_SERVICE_ROLE_KEY:'mock-service',GOOGLE_PLACES_API_KEY:'mock-only',OPENAI_API_KEY:'mock-only'})
const geocode=(await import('../../api/geocode.ts')).default
const generate=(await import('../../api/generate-trip.ts')).default
const sink=()=>({statusCode:200,body:null,events:[],status(n){this.statusCode=n;return this},json(v){this.body=v},setHeader(){},end(){},write(v){this.events.push(JSON.parse(v))}})

test('revision resolves the actual checkout plus detached and shared packed worktree refs',()=>{
  assert.equal(readGitRevision(),execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
  const root=mkdtempSync(join(tmpdir(),'weather-git-'))
  try {
    const sha='a'.repeat(40), dir=join(root,'checkout'),git=join(root,'common','worktrees','test')
    mkdirSync(dir,{recursive:true});mkdirSync(git,{recursive:true})
    writeFileSync(join(dir,'.git'),'gitdir: ../common/worktrees/test\n')
    writeFileSync(join(git,'HEAD'),sha+'\n');assert.equal(readGitRevision(dir),sha)
    writeFileSync(join(git,'HEAD'),'ref: refs/heads/codex/integration\n')
    writeFileSync(join(git,'commondir'),'../..\n')
    writeFileSync(join(root,'common','packed-refs'),`${sha} refs/heads/codex/integration\n`)
    assert.equal(readGitRevision(dir),sha)
    writeFileSync(join(git,'HEAD'),'broken');assert.equal(readGitRevision(dir),'unknown')
  } finally {rmSync(root,{recursive:true,force:true})}
})

for(const query of [{lat:25.03,lng:121.56},{address:'臺北市信義區'}]) test(`authenticated client -> real geocode API supports ${'address' in query?'address':'coordinates'}`,async t=>{
  let providerCalls=0,authCalls=0
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const target=String(url)
    if(target.endsWith('/auth/v1/user')) {authCalls++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer mock-session');return Response.json({id:'11111111-1111-4111-8111-111111111111'})}
    if(target.endsWith('/consume_api_rate_limit')) return Response.json(true)
    assert.ok(target.startsWith('https://maps.googleapis.com/maps/api/geocode/json?'))
    const params=new URL(target).searchParams
    if('address' in query) assert.equal(params.get('address'),query.address)
    else assert.equal(params.get('latlng'),'25.03,121.56')
    providerCalls++
    return Response.json({status:'OK',results:[{formatted_address:'臺北市信義區',geometry:{location:{lat:25.03,lng:121.56}},address_components:[{types:['country'],short_name:'TW'},{types:['administrative_area_level_1'],long_name:'臺北市'},{types:['locality'],long_name:'信義區'}]}]})
  })
  const bridge=async(url,init)=>{
    assert.equal(url,'/api/geocode');assert.equal(init.headers.Authorization,'Bearer mock-session')
    const res=sink();await geocode({method:init.method,headers:{authorization:init.headers.Authorization},body:JSON.parse(init.body)},res)
    return Response.json(res.body,{status:res.statusCode})
  }
  const place=await geocodeLocation(query,'mock-session',bridge)
  assert.equal(place.name,'臺北市信義區');assert.equal(place.city,'臺北市');assert.equal(place.lat,25.03)
  assert.equal(authCalls,1);assert.equal(providerCalls,1)
})

test('missing browser session cannot call the authenticated paid geocode endpoint',async()=>{
  await assert.rejects(geocodeLocation({address:'臺北市'},undefined,()=>assert.fail('No request allowed')),/登入/)
})

test('rate-limited generation releases lease without debit, completed recovery bypasses quota',async t=>{
  const f=identityFixture(),calls=mockGeneration(t,f,f.plans)
  for(const method of ['warn','error','debug','info']) t.mock.method(console,method,()=>{})
  const fetch=globalThis.fetch
  t.mock.method(globalThis,'fetch',(url,init)=>String(url).endsWith('/consume_api_rate_limit') ? Promise.resolve(Response.json(false)) : fetch(url,init))
  const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',req={method:'POST',headers:{authorization:'Bearer mock-session'},body:{generationId:id,input:structuredClone(f.input)}}
  const first=sink();await generate(req,first)
  assert.equal(first.statusCode,429);assert.equal(calls.points,0);assert.equal(calls.ai.length,0)
  assert.equal(calls.generations.get(id).status,'failed')
  const response={plans:f.plans}
  Object.assign(calls.generations.get(id),{status:'completed',response})
  const recovered=sink();await generate(req,recovered)
  assert.equal(recovered.statusCode,200);assert.deepEqual(recovered.body,JSON.parse(JSON.stringify(response)));assert.equal(calls.points,0)
})

test('dev completed generation plans retain a stable sharing contract and separate detail identities',()=>{
  for(const plan of identityFixture().plans) {
    const completed={...plan,isDetailComplete:true}
    assert.ok(isShareablePlan(completed))
    assert.equal(getSharedPlanSignature(completed),getSharedPlanSignature(sanitizeSharedPlan(completed)))
  }
  assert.equal(getPlanDetailStateKey('safe','recent','record-a'),'recent:record-a')
  assert.notEqual(getPlanDetailStateKey('safe','shared','a'),getPlanDetailStateKey('safe','shared','b'))
})
