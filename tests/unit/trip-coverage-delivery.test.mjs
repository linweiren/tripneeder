import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { fixture, mockMatrix, FIXED_NOW } from './fixtures/supplement-quality.mjs'
import { assessCoverageV2, createRemedyTrace, getRemedyTimelineSignature, getRemedyPoolSignature,
  recordCoverageSearch } from '../../api/_lib/trip-coverage-v2.ts'
import { chooseSupplementalInsertion, createSupplementRouteContext } from '../../api/_lib/trip-supplement-quality.ts'
import { projectCoverageDiagnostics } from '../../api/_lib/trip-coverage-diagnostics-projection.ts'
import { withAcceptanceEvidence, captureAcceptanceDiagnostics, recordEvidenceDelivery } from '../../api/_lib/trip-acceptance-evidence.ts'
import { runCoverageMatrix } from './fixtures/coverage-phase2c1-matrix.mjs'

process.env.GOOGLE_PLACES_API_KEY='unit-test-only'
test.beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:FIXED_NOW})
  t.mock.method(https,'request',()=>{throw Error('Unexpected external request')})
  t.mock.method(globalThis,'fetch',()=>{throw Error('Unexpected external fetch')})
  t.mock.method(console,'info',()=>{})
  t.mock.method(console,'warn',()=>{})
})
function sample() {
  const f=fixture('city')
  Object.assign(f.input,{category:'other',customCategory:'想去公園'})
  f.plan.stops.forEach(s=>Object.assign(s,{duration:90,name:'河濱公園',googleTypes:['park'],types:['park']}))
  f.candidates.allCandidates=f.candidates.otherCandidates=f.candidates.firstStopCandidates=[...f.plan.stops]
  recordCoverageSearch(f.candidates,[{stage:'initial',query:'PRIVATE_LOCATION',radiusMeters:5000,status:'succeeded',count:2}])
  const remedy=createRemedyTrace()
  remedy.supplementPasses.push({scope:'supplied_pool_up_to_three_candidates_two_positions',
    timelineSignature:getRemedyTimelineSignature(f.plan,f.input),
    poolSignature:getRemedyPoolSignature(f.candidates.allCandidates),unprocessedPoolCandidates:0,
    pending:0,eligible:0,compared:0,stopReason:'bounded_pool_insufficient'})
  return {...f,remedy}
}
const shadow=(f,validation={issues:[],routesFailed:false})=>assessCoverageV2(f.plan,f.input,f.candidates,f.remedy,validation)
const decision=f=>shadow(f).deliveryDecision

test('190/300 has a 35 minute normal gap, 110 minute tail and confirmed bounded partial eligibility',()=>{
  const f=sample(),s=shadow(f)
  assert.equal(s.deliveryDecision.status,'conditional_partial')
  assert.equal(s.deliveryDecision.remedy.complete,true)
  assert.equal(s.time.actualMinutes,190)
  assert.equal(s.time.coverageGapMinutes,35)
  assert.equal(s.time.unarrangedMinutes,110)
  assert.equal(s.time.tailBlankMinutes,110)
  assert.equal(s.classification,'B','legacy Phase 1 classification remains unchanged')
  assert.equal(s.nearbyOptionsAvailability,'unknown')
})

test('normal completion takes priority without requiring unnecessary further comparisons',()=>{
  const f=sample();f.plan.stops.forEach(s=>{s.duration=110});f.remedy=createRemedyTrace()
  assert.equal(decision(f).status,'complete')
})

for(const mode of ['pending','shortlist','budget','technical','source','unobserved','timeline','pool','metadata','missing-scope'])
  test(`${mode} uncertainty cannot become conditional partial`,()=>{
    const f=sample(),p=f.remedy.supplementPasses[0]
    if(mode==='pending')p.pending=1
    if(mode==='shortlist')p.unprocessedPoolCandidates=1
    if(mode==='budget')f.remedy.budgetExhausted=true
    if(mode==='technical')f.remedy.technicalFailure=true
    if(mode==='source')recordCoverageSearch(f.candidates,[{stage:'gap',query:'SECRET',radiusMeters:5000,status:'failed',count:0}])
    if(mode==='unobserved')f.remedy=createRemedyTrace()
    if(mode==='timeline')f.plan.stops[1]={...f.plan.stops[1],duration:95}
    if(mode==='pool')f.candidates.allCandidates.push(f.extras[0])
    if(mode==='metadata')f.candidates.allCandidates[0].score=999
    if(mode==='missing-scope')delete p.poolSignature
    const s=shadow(f)
    assert.equal(s.deliveryDecision.status,null)
    assert.equal(s.deliveryDecision.resolved,false)
    assert.equal(s.deliveryDecision.remedy.complete,false)
    assert.equal(s.deliveryDecision.conditionalEligible,false)
  })

for(const mode of ['unknown-intent','unknown-evidence','unmet','related-alternative'])
  test(`core ${mode} is never original demand completion`,()=>{
    const f=sample()
    if(mode==='unknown-intent')f.input.customCategory='特殊的未知需求'
    else f.input.customCategory='想去博物館'
    if(mode==='unknown-evidence')f.plan.stops.forEach(s=>{s.googleTypes=['tourist_attraction']})
    if(mode==='related-alternative')f.plan.stops.forEach(s=>Object.assign(s,{name:'地方美術館',googleTypes:['art_gallery']}))
    const s=shadow(f)
    assert.equal(s.coreSatisfied,false)
    assert.equal(s.deliveryDecision.status,mode.startsWith('unknown')?null:'alternative')
    assert.equal(s.deliveryDecision.conditionalEligible,false)
    assert.notEqual(s.deliveryDecision.originalDemand,'confirmed')
    assert.equal(s.deliveryDecision.executable,true)
  })

for(const mode of ['late-start','missing-route','stale-route','estimated-route','interstop-gap','capacity','meal','opening','prohibition','routes-failure'])
  test(`necessary ${mode} cannot be a qualified tail blank`,()=>{
    const f=sample()
    if(mode==='late-start')f.plan.scheduleStartTime='11:00'
    if(mode==='missing-route')f.plan.transportSegments=[]
    if(mode==='stale-route')f.plan.transportSegments[0].toStopId='wrong'
    if(mode==='estimated-route')f.plan.transportSegments[0].label='(估算)'
    if(mode==='interstop-gap')f.plan.transportSegments.push({...f.plan.transportSegments[0],duration:30})
    if(mode==='capacity')f.plan.stops.forEach(s=>{s.duration=180})
    if(mode==='meal')f.input.tags=[]
    if(mode==='opening')f.plan.stops[0].openingHours={...f.plan.stops[0].openingHours,isNeverOpen:true}
    if(mode==='prohibition'){
      f.input.customCategory='不要咖啡廳'
      Object.assign(f.plan.stops[0],{type:'food',role:'food',googleTypes:['cafe'],types:['cafe']})
    }
    const d=shadow(f,{issues:[],routesFailed:mode==='routes-failure'}).deliveryDecision
    assert.equal(d.status,'unavailable')
    assert.equal(d.conditionalEligible,false)
    assert.equal(d.executable,false)
  })

test('night and permitted dawn exception remain distinct from an unauthorized late start',()=>{
  const f=sample();f.plan.stops.forEach(s=>{s.duration=40})
  Object.assign(f.input,{startTime:'23:00',endTime:'01:00'})
  f.candidates.allCandidates.forEach(c=>{c.openingHours.windows[0].closeAt=new Date(FIXED_NOW+2*86400000)})
  assert.equal(shadow(f).time.normalMinimumMinutes,84)
  assert.equal(decision(f).status,'complete')
  Object.assign(f.input,{startTime:'03:00',endTime:'12:00'});f.plan.scheduleStartTime='06:00'
  f.remedy.supplementPasses[0].timelineSignature=getRemedyTimelineSignature(f.plan,f.input)
  f.remedy.supplementPasses[0].poolSignature=getRemedyPoolSignature(f.candidates.allCandidates)
  assert.equal(shadow(f).time.earlyMorningExceptionMinutes,180)
  assert.equal(decision(f).status,'conditional_partial')
  f.plan.scheduleStartTime='07:00'
  assert.equal(decision(f).status,'unavailable')
})

test('Safe/Balanced/Explore have independent eligibility, never a shared flag',()=>{
  const fixtures=['safe','balanced','explore'].map(id=>{const f=sample();f.plan.id=f.plan.type=id;return f})
  fixtures[1].remedy.budgetExhausted=true
  fixtures[2].input.customCategory='想去博物館'
  assert.deepEqual(fixtures.map(f=>decision(f).status),['conditional_partial',null,'alternative'])
})

test('actual bounded comparison preserves full-pool provenance and rejected candidate reasons',async t=>{
  const f=sample(),context=createSupplementRouteContext()
  f.candidates.allCandidates.push(f.extras[0])
  Object.assign(f.routes,{'A>far':200,'far>B':200,'B>far':200})
  mockMatrix(t,f)
  const opts={stops:f.plan.stops,segments:f.plan.transportSegments,input:f.input,capacity:300,
    pool:[f.extras[0]],allCandidates:f.candidates.allCandidates,
    used:new Set(f.plan.stops.map(s=>s.placeId)),crossPlanUsed:new Set(),mode:'scooter',makeStop:c=>({...c}),context}
  await chooseSupplementalInsertion(opts)
  f.remedy=context.remedy
  assert.equal(decision(f).status,'conditional_partial')
  assert.ok(f.remedy.events.some(e=>e.outcome==='capacity_rejected'&&e.routeComparisonCompleted))
  const omitted=createSupplementRouteContext()
  await chooseSupplementalInsertion({...opts,pool:[],context:omitted})
  f.remedy=omitted.remedy
  assert.equal(f.remedy.supplementPasses[0].unprocessedPoolCandidates,1)
  assert.equal(decision(f).status,null)
})

test('actual diagnostics.json readback retains per-style decisions with bounded sanitized fields',async t=>{
  const root=fs.mkdtempSync(path.resolve('.coverage-c1-disk-'))
  t.after(()=>{assert.equal(path.dirname(root),process.cwd());fs.rmSync(root,{recursive:true,force:true})})
  const keys=['NODE_ENV','TRIP_CANDIDATE_DEBUG','TRIP_ACCEPTANCE_EVIDENCE_DIR']
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
  const values=[sample(),sample(),sample()]
  values[0].plan.stops.forEach(s=>{s.duration=110})
  values[2].input.customCategory='想去博物館'
  const final=values.map((f,i)=>({planId:['safe','balanced','explore'][i],shadow:shadow(f)}))
  final[1].shadow.deliveryDecision.secret='PRIVATE_CREDENTIAL'
  Object.assign(process.env,{NODE_ENV:'development',TRIP_CANDIDATE_DEBUG:'true',TRIP_ACCEPTANCE_EVIDENCE_DIR:root})
  try {
    await withAcceptanceEvidence({input:{}},{write(){},json(){},end(){},status(){return this}},async()=>{
      captureAcceptanceDiagnostics({version:1,coverageV2:{final,attempts:[]}})
      recordEvidenceDelivery({event:'done',response:{plans:[]}})
    })
  } finally {
    for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v
  }
  const folder=path.join(root,fs.readdirSync(root)[0])
  const serialized=fs.readFileSync(path.join(folder,'diagnostics.json'),'utf8')
  const saved=JSON.parse(serialized).data.coverageV2
  assert.deepEqual(saved.final.map(row=>row.shadow.deliveryDecision.status),['complete','conditional_partial','alternative'])
  assert.equal(saved.projection.incomplete,false,JSON.stringify(saved.projection))
  assert.equal(saved.final[1].shadow.time.coverageGapMinutes,35)
  assert.equal(saved.final[1].shadow.time.unarrangedMinutes,110)
  assert.equal(serialized.includes('PRIVATE_'),false)
  assert.equal(saved.final[1].shadow.remedy.supplementPasses[0].poolSignature,undefined)
  const noisy=structuredClone(final[1].shadow)
  noisy.deliveryDecision.reasons=Array(5000).fill('technical_failure')
  noisy.deliveryDecision.prompt='PRIVATE_PROMPT'.repeat(100000)
  const projected=projectCoverageDiagnostics({final:[{planId:'safe',shadow:noisy}],attempts:[]})
  assert.equal(projected.projection.incomplete,true)
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<=256*1024)
  assert.equal(JSON.stringify(projected).includes('PRIVATE_'),false)
  const legacy=shadow(sample());delete legacy.deliveryDecision
  assert.equal(projectCoverageDiagnostics({final:[{planId:'safe',shadow:legacy}]}).final[0].shadow.deliveryDecision,undefined)
})

// Every invocation runs real mocked Repair/Validation; report JSON is an output,
// not a prerequisite or a substitute for executing the matrix.
const matrix=runCoverageMatrix()
test('missing required regression fixture fails explicitly without skipping cases',()=>{
  assert.throws(()=>runCoverageMatrix({contractFile:new URL('./fixtures/missing-coverage-contract.json',import.meta.url)}),
    /Required Coverage regression fixture unavailable: ENOENT/)
})
test('48-case matrix is fresh for the actual decision and Repair sources',()=>{
  assert.equal(matrix.rows.length,48)
  for(const [file,hash] of Object.entries(matrix.sourceSha256))assert.equal(createHash('sha256').update(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')).digest('hex'),hash,file)
  assert.equal(matrix.handlers.length,12)
  assert.ok(matrix.handlers.every(row=>row.matched))
})
for(const row of matrix.rows)test(`fresh matrix ${row.kind}/${row.style}`,()=>{
  const {A,B2}=row
  if(B2.deliveryDecision.status==='conditional_partial'){
    assert.equal(B2.delivered,false,'shadow eligibility is not formal delivery')
    assert.equal(B2.coreSatisfied,true)
    assert.equal(B2.necessaryPassed,true)
    assert.equal(B2.time.tailOnly,true)
    assert.equal(B2.deliveryDecision.remedy.complete,true)
    assert.equal(B2.technicalFailure,false)
    assert.equal(B2.budgetExhausted,false)
  }
  if(row.kind==='central-two-stop'){
    assert.equal(B2.activityImpact.retainedStayLoss,0)
    assert.equal(B2.finalStops.find(s=>s.name==='愛河灣').finalMinutes,150)
    assert.notEqual(B2.deliveryDecision.status,'conditional_partial')
  }
  if(['valuable','optional-coverage'].includes(row.kind))assert.equal(B2.deliveryDecision.status,'complete')
  assert.equal(B2.activityImpact.retainedStayLoss,0)
  assert.ok(A.deliveryDecision.internalOnly&&B2.deliveryDecision.internalOnly)
})
