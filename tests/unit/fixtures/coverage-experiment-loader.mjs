// Shared deterministic Coverage fixture support, extracted without changing behavior.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'

// Test-only source loading. Production imports never reference this file.
export async function loadCoverageExperiment(mode = 'A', { trace = false } = {}) {
  if (!['A', 'B', 'B2', 'working'].includes(mode)) throw Error('Expected A/B/B2/working')
  if (mode === 'working') return import('../../../api/generate-trip.ts')
  let source = fs.readFileSync(new URL('../../../api/generate-trip.ts', import.meta.url), 'utf8')
  const sha256 = createHash('sha256').update(source).digest('hex')
  source = source.replaceAll('\r\n', '\n')
  const replaceOnce = (needle, replacement) => {
    if (source.split(needle).length !== 2) throw Error(`Experiment hook drift: ${needle}`)
    source = source.replace(needle, replacement)
  }
  replaceOnce('  // Filter at every entry, including recursive alternatives and fallbacks.',
    '  __experiment.repairCalls++\n  // Filter at every entry, including recursive alternatives and fallbacks.')
  replaceOnce('  const minimumMinutes = getMinimumRequiredActualMinutes(input)\n  const unchanged',
    '  __experiment.expansionPasses++\n  const minimumMinutes = getMinimumRequiredActualMinutes(input)\n  const unchanged')
  replaceOnce('  logPlanQualitySummary(plan, input, phase)\n\n  const firstStopDistanceIssue',
    '  __experiment.validationCalls++; __experiment.lastPlan = plan\n  logPlanQualitySummary(plan, input, phase)\n\n  const firstStopDistanceIssue')
  source = source.replace(/evidenceAiFetch\('(initial|initial_json_repair|retry|refill)'/g,
    (_match, stage) => `(__experiment.aiStages.push('${stage}'), evidenceAiFetch)('${stage}'`)
  if (mode === 'B' || mode === 'B2') {
    replaceOnce('const room = getMaximumStopDuration(stops[index]) - stops[index].duration',
      'const room = Math.max(0, __evidenceCeiling(plan.stops[index]) - stops[index].duration)')
    replaceOnce('room: getMaximumStopDuration(stop) - durations[index],',
      'room: Math.max(0, __evidenceCeiling(stop) - durations[index]),')
  }
  const locations = Object.fromEntries(['repairPlanForDelivery', 'extendExistingActivitiesToMinimum',
    'stretchPlanDurationToCoverage', 'getDeliveryPlanIssues', 'repairAndValidatePlanForDelivery', 'fetchRetrySkeletonPlans']
    .map(name => [name, 'api/generate-trip.ts:' + (fs.readFileSync(new URL('../../../api/generate-trip.ts', import.meta.url), 'utf8')
      .replaceAll('\r\n', '\n').split('\n').findIndex(line => line.includes(`function ${name}(`)) + 1)]))
  if (mode === 'B2') replaceOnce(
    'clamp(stop.duration, getMinimumStopDuration(stop), getMaximumStopDuration(stop)),',
    '__b2DurationBound(stop, plan, input),')
  if (trace) {
    replaceOnce('export async function getDeliveryPlanIssues(', 'async function __originalDeliveryPlanIssues(')
    replaceOnce('export async function repairAndValidatePlanForDelivery(', 'async function __originalRepairAndValidate(')
    source = source.replace(/recordCoverageShadow\(/g, '__captureShadow(')
    replaceOnce('  const minimum = getMinimumRequiredActualMinutes(input)\n  let remaining',
      "  __experiment.branches.push({ point: 'extend-entry', plan: __snapshot(plan, input) })\n  const minimum = getMinimumRequiredActualMinutes(input)\n  let remaining")
    replaceOnce('  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)\n  if (!scheduleCapacityMinutes || plan.stops.length === 0)',
      "  __experiment.branches.push({ point: 'stretch-entry', plan: __snapshot(plan, input) })\n  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)\n  if (!scheduleCapacityMinutes || plan.stops.length === 0)")
    replaceOnce("  traceDurationPlan(plan, boundedPlan, 'duration_bounds')",
      "  __experiment.branches.push({ point: 'stretch-bounds', before: __snapshot(plan, input), after: __snapshot(boundedPlan, input), maximums: plan.stops.map(getMaximumStopDuration) })\n  traceDurationPlan(plan, boundedPlan, 'duration_bounds')")
    replaceOnce('  const retryPrompt = buildRetryTripSkeletonPrompt(\n    input,\n    [...planIds],',
      '  __captureRefill(planIds, input, nearbyPlaces, validationSummaries)\n  const retryPrompt = buildRetryTripSkeletonPrompt(\n    input,\n    [...planIds],')
    replaceOnce('                const nonRepairableIssues = getNonRepairableRefillIssues(validation.issues)',
      "                const nonRepairableIssues = getNonRepairableRefillIssues(validation.issues)\n                __experiment.refillPrechecks.push({ style: validatedPlan.id, pool: __poolInfo(nearbyPlaceCandidates), plan: __snapshot(validatedPlan, request.input), preliminaryIssues, nonRepairableIssues, placeIssues: validation.issues.map(issue => ({ stopId: issue.stopId, reason: issue.reason })) })")
    replaceOnce('              const retryPlans = await fetchRetrySkeletonPlans(',
      "              __experiment.refillPoolDispatch.push({ style: missingPlanId, pool: __poolInfo(nearbyPlaceCandidates) })\n              const retryPlans = await fetchRetrySkeletonPlans(")
    replaceOnce('  const allowCoverageRepair = options.allowCoverageRepair ?? true',
      "  __experiment.branches.push({ point: 'repair-entry', plan: __snapshot(plan, input), allowCoverageRepair: options.allowCoverageRepair ?? true, phase: options.debugPhase ?? 'repair' })\n  const allowCoverageRepair = options.allowCoverageRepair ?? true")
  }
  const traceUrl = new URL('../../../api/_lib/trip-coverage-v2.ts', import.meta.url).href
  const prefix = `import { getDurationTrace as __trace } from '${traceUrl}';
export const __experiment = { mode: '${mode}', sourceSha256: '${sha256}', locations: ${JSON.stringify(locations)}, traceEnabled: ${trace}, branches: [], b2Bounds: [], wrapperResults: [], validationResults: [], refillRequests: [], refillPoolDispatch: [], refillPrechecks: [], shadowResults: [], currentWrapper: null, repairCalls: 0, expansionPasses: 0, validationCalls: 0, aiStages: [] };
function __evidenceCeiling(stop) {
  const evidence = __trace(stop).activityEvidence;
  // Preserve existing minutes without declaring them verified. Only independent
  // activity records fund more coverage minutes; existing soft maxima still apply.
  return Math.min(getMaximumStopDuration(stop), Math.max(stop.duration, evidence?.minutes ?? 0));
}
`
  const support = fs.readFileSync(new URL('./coverage-experiment-support.mjs', import.meta.url), 'utf8')
  const wrappers = trace ? fs.readFileSync(new URL('./coverage-experiment-observers.mjs', import.meta.url), 'utf8') : ''
  const resolveImports = text => text.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote, specifier) => {
    const resolved = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/generate-trip.ts', import.meta.url)).href
      : import.meta.resolve(specifier)
    return `from ${quote}${resolved}${quote}`
  })
  source = resolveImports(source)
  return import(`data:text/javascript;base64,${Buffer.from(prefix + resolveImports(support) + wrappers + stripTypeScriptTypes(source)).toString('base64')}`)
}
