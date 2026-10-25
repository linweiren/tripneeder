// Shared deterministic Coverage fixture support, extracted without changing behavior.
// Loaded only into the isolated source module. These observers do not select plans.
export async function getDeliveryPlanIssues(...args) {
  const issues = await __originalDeliveryPlanIssues(...args);
  __experiment.validationResults.push({ phase: args[2], plan: __snapshot(args[0],args[1]), issues: [...issues] });
  return issues;
}
function __captureShadow(plan,input,pool,remedy,validation) {
  const shadow = recordCoverageShadow(plan,input,pool,remedy,validation);
  __experiment.shadowResults.push({ phase: __experiment.currentWrapper?.phase, style: plan.id,
    plan: __snapshot(plan,input), execution: __executionAudit(plan,input), pool: __poolInfo(pool),
    classification: shadow.classification, coreSatisfied: shadow.coreSatisfied, requirements: shadow.requirements,
    stopReason: shadow.stopReason, budgetExhausted: remedy.budgetExhausted, technicalFailure: remedy.technicalFailure,
    remedy, remainingCandidates: pool.allCandidates.filter(c => !plan.stops.some(s => s.placeId === c.placeId))
      .map(c => ({ placeId: c.placeId, openingKnown: Boolean(c.openingHours?.isKnown), role: c.role })) });
  return shadow;
}
export async function repairAndValidatePlanForDelivery(...args) {
  const previous = __experiment.currentWrapper;
  const context = { style: args[0].id, phase: args[4], pool: __poolInfo(args[2]) };
  __experiment.currentWrapper = context;
  const shadowStart = __experiment.shadowResults.length;
  try {
    const result = await __originalRepairAndValidate(...args);
    const observed = __experiment.shadowResults.slice(shadowStart).at(-1) ?? null;
    __experiment.wrapperResults.push({ ...context, before: __snapshot(args[0],args[1]), observed,
      returnedPlan: Boolean(result.plan), routesFailed: result.routesFailed, issues: [...result.issues],
      after: __snapshot(result.plan,args[1]) });
    return result;
  } finally { __experiment.currentWrapper = previous; }
}
function __captureRefill(planIds,input,nearbyPlaces,validationSummaries) {
  __experiment.refillRequests.push({ targets: [...planIds],
    requiredBy: 'PLAN_IDS_missing_after_final_repair_loop', candidatePromptSha256: __hash(nearbyPlaces),
    validationSummaries: planIds.map(id => ({ id, issues: [...(validationSummaries.get(id) ?? [])] })),
    preceding: planIds.map(id => [...__experiment.wrapperResults].reverse().find(row => row.style === id && row.phase === 'final-repair') ?? null),
    wrapperCountBefore: __experiment.wrapperResults.length, stagesBefore: [...__experiment.aiStages] });
}
