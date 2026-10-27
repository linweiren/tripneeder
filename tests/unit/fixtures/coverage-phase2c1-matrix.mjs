import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { CASES, HANDLER_CASES } from './coverage-experiment-cases.mjs'
import { paidEventsFromLegacy } from './paid-generation-regression-contract.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value
const hash = value => createHash('sha256').update(value).digest('hex')
const contractHash = (value,fields) => hash(JSON.stringify(canonical(Object.fromEntries(fields.map(key=>[key,value[key]])))))
const sourceHash = path => hash(fs.readFileSync(path,'utf8').replaceAll('\r\n','\n'))
const CONTRACT = new URL('./coverage-delivery-contract.json',import.meta.url)

export function runCoverageMatrix({writeReport=false,progress=false,contractFile=CONTRACT}={}) {
  let contract
  try { contract=JSON.parse(fs.readFileSync(contractFile,'utf8')) }
  catch(error) { throw new Error(`Required Coverage regression fixture unavailable: ${error.code??error.message}`,{cause:error}) }
  assert.equal(contract.version,1)
  assert.equal(contract.rows.length,48)
  assert.equal(contract.handlers.length,12)
  function replay(mode,kind,style,layer='repair',variant='default') {
    return JSON.parse(execFileSync(process.execPath,['--disable-warning=ExperimentalWarning',
      '--import','./tests/unit/register-ts-js-extension-loader.mjs','./tests/unit/fixtures/coverage-phase2c1-replay.mjs',
      mode,kind,style,layer,variant,'trace'],{encoding:'utf8',timeout:30000,maxBuffer:12*1024*1024}))
  }
  const rows=[]
  for(const kind of CASES) for(const style of ['safe','balanced','explore']) {
    const expected=contract.rows.find(row=>row.kind===kind&&row.style===style)
    assert.ok(expected,`Required case contract missing: ${kind}/${style}`)
    const row={kind,style}
    for(const mode of ['A','B2']) {
      const fresh=replay(mode,kind,style)
      assert.equal(contractHash(fresh,contract.repairFields),expected[mode].formalSha256,
        `Formal drift ${mode}/${kind}/${style}; all original deep-comparison fields included`)
      assert.deepEqual(fresh.deliveryDecision,expected[mode].decision,`Decision drift ${mode}/${kind}/${style}`)
      row[mode]=Object.fromEntries(['deliveryDecision','delivered','coreSatisfied','necessaryPassed','time',
        'finalStay','travel','coverageAdded','unsupportedCoverageAdded','activityImpact','pipelineCalls','repairCalls',
        'candidateComparisons','pendingPositions','budgetExhausted','technicalFailure','remedy','requirements',
        'issues','finalStops','originalStops'].map(key=>[key,fresh[key]]))
      row[mode].b2Bounds=fresh.executionTrace.b2Bounds
    }
    row.futureConditionalRecovery=!row.B2.delivered&&row.B2.deliveryDecision.status==='conditional_partial'
    rows.push(row)
    if(progress)process.stderr.write(`${kind}/${style}: A=${row.A.deliveryDecision.status??'unresolved'}; B2=${row.B2.deliveryDecision.status??'unresolved'}\n`)
  }
  const handlers=[]
  for(const kind of HANDLER_CASES) for(const mode of ['A','B2']) {
    const fresh=replay(mode,kind,'explore','handler')
    const expected=contract.handlers.find(row=>row.kind===kind&&row.mode===mode)
    assert.ok(expected,`Required handler contract missing: ${kind}/${mode}`)
    // Keep the frozen research contract intact. Compare a read-only pre-change
    // handler to it, then permit ONLY the explicitly approved payment event delta.
    const beforePaid = replay(mode,kind,'explore','handler-before-paid')
    assert.equal(contractHash(beforePaid,contract.handlerFields),expected.formalSha256,
      `Frozen pre-payment handler drift ${kind}/${mode}`)
    for (const field of contract.handlerFields.filter(field=>field!=='events')) {
      assert.deepEqual(fresh[field],beforePaid[field],`Handler quality/provider drift ${field}/${kind}/${mode}`)
    }
    assert.deepEqual(fresh.events,paidEventsFromLegacy(beforePaid.events),`Paid event boundary drift ${kind}/${mode}`)
    handlers.push({kind,mode,matched:true,responseSha256:hash(JSON.stringify(fresh.response)),
      eventsSha256:hash(JSON.stringify(fresh.events)),delivered:fresh.delivered,
      aiCalls:fresh.aiCalls,routes:fresh.routes,places:fresh.places,retry:fresh.retry,refill:fresh.refill})
  }
  const negatives=['capacity-pressure','opening-pressure'].map(variant=>({variant,
    B2:replay('B2','central-two-stop','explore','repair',variant)}))
  const capacity=negatives[0].B2, opening=negatives[1].B2
  assert.equal(capacity.activityImpact.retainedStayLoss,24)
  assert.equal(capacity.finalStops.find(s=>s.name==='愛河灣').finalMinutes,126)
  assert.ok(capacity.finalStops.some(s=>s.events.some(e=>e.reason==='capacity'&&e.delta===-24)))
  assert.equal(capacity.executionTrace.rawExecutionAudit.passed,true)
  assert.equal(opening.delivered,false)
  assert.equal(opening.executionTrace.rawExecutionAudit.checks.opening,false)
  assert.ok(opening.openingIssues.length>0)
  assert.ok(opening.executionTrace.b2Bounds.every(row=>!row.preserved))
  const totals=Object.fromEntries(['A','B2'].map(mode=>[mode,{
    formalReturned:rows.filter(row=>row[mode].delivered).length,
    states:Object.fromEntries(['complete','conditional_partial','alternative','unavailable','unresolved'].map(state=>
      [state,rows.filter(row=>(row[mode].deliveryDecision.status??'unresolved')===state).length])),
    originalStayLoss:rows.reduce((n,row)=>n+row[mode].activityImpact.retainedStayLoss,0),
    routes:rows.reduce((n,row)=>n+row[mode].pipelineCalls.routes,0),
    repairCalls:rows.reduce((n,row)=>n+row[mode].repairCalls,0)
  }]))
  assert.deepEqual(totals,contract.totals)
  const sourcePaths=['api/generate-trip.ts','api/_lib/trip-coverage-v2.ts','api/_lib/trip-coverage-delivery.ts',
    'api/_lib/trip-supplement-quality.ts','api/_lib/trip-coverage-diagnostics-projection.ts',
    'tests/unit/fixtures/coverage-phase2c1-replay.mjs','tests/unit/fixtures/coverage-phase2c1-matrix.mjs',
    'tests/unit/fixtures/coverage-experiment-loader.mjs','tests/unit/fixtures/coverage-experiment-support.mjs',
    'tests/unit/fixtures/coverage-experiment-observers.mjs','tests/unit/fixtures/coverage-experiment-cases.mjs',
    'tests/unit/fixtures/coverage-delivery-contract.json','tests/unit/fixtures/supplement-quality.mjs',
    'tests/unit/fixtures/stop-duration-quality.mjs','tests/unit/fixtures/optional-activity-quality.mjs',
    'tests/unit/fixtures/meal-reliability.mjs','tests/unit/fixtures/supplement-final-quality.mjs','tests/unit/fixtures/plan-identity.mjs']
  const result={baseline:contract.baseline,paidCalls:0,evidenceClass:'fresh_fixed_fixture_mock_not_real_model_quality',
    sourceHashBasis:'utf8_LF_normalized_for_clean_checkout',regressionContractSha256:sourceHash('tests/unit/fixtures/coverage-delivery-contract.json'),
    rows,handlers,negatives,totals,conditionalRecovery:rows.filter(row=>row.futureConditionalRecovery).map(row=>({kind:row.kind,style:row.style})),
    sourceSha256:Object.fromEntries(sourcePaths.map(path=>[path,sourceHash(path)]))}
  if(writeReport)fs.writeFileSync('docs/coverage-v2-phase2c1-results.json',JSON.stringify(result,null,2)+'\n')
  return result
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=runCoverageMatrix({writeReport:true,progress:true})
  console.log(JSON.stringify({totals:result.totals,conditionalRecovery:result.conditionalRecovery.length,handlers:result.handlers.length}))
}
