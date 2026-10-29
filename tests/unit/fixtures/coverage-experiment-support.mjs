// Shared deterministic Coverage fixture support, extracted without changing behavior.
// Loaded as test-only source text by coverage-phase2a-loader; no production import.
import { getCachedOpeningHoursForDurationComparison as __cachedHours } from './_lib/google-places.js';
import { createHash as __createHash } from 'node:crypto';
const __poolIds = new WeakMap();
function __hash(value) { return __createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function __poolInfo(pool) {
  if (!__poolIds.has(pool)) __poolIds.set(pool, __experiment.poolSequence = (__experiment.poolSequence ?? 0) + 1);
  return { objectId: __poolIds.get(pool), size: pool.allCandidates.length,
    sha256: __hash(pool.allCandidates.map(c => [c.placeId, c.score, c.role, c.types, c.openingHours]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))) };
}
function __snapshot(plan, input) {
  if (!plan) return null;
  const actual = getPlanActualDuration(plan), minimum = getMinimumRequiredActualMinutes(input);
  return { planId: plan.id, actualMinutes: actual, minimumMinutes: minimum,
    coverageGapMinutes: minimum === null ? null : Math.max(0, minimum - actual),
    targetCoverageMinutes: getCoverageRepairTargetMinutes(input), capacityMinutes: getScheduleCapacityMinutes(input), scheduleStartTime: plan.scheduleStartTime ?? input.startTime,
    requestedStartTime: input.startTime, requestedEndTime: input.endTime,
    stops: plan.stops.map(stop => ({ id: stop.id, placeId: stop.placeId, name: stop.name, type: stop.type, duration: stop.duration })),
    segments: plan.transportSegments.map(leg => ({ fromStopId: leg.fromStopId, toStopId: leg.toStopId, duration: leg.duration, label: leg.label })) };
}
function __executionAudit(plan, input) {
  const arrivalInput = { ...input, scheduleStartTime: plan.scheduleStartTime };
  const arrivals = plan.stops.map((s,i) => getEstimatedArrivalMinutesForStop(plan.stops,i,arrivalInput,plan.transportSegments));
  const start = parseTimeToMinutes(input.startTime), rawEnd = parseTimeToMinutes(input.endTime);
  const end = rawEnd === null || start === null ? null : rawEnd < start ? rawEnd + 1440 : rawEnd;
  const opening = plan.stops.map((stop,i) => {
    const hours = stop.placeId ? __cachedHours(stop.placeId) : null;
    return { stopId: stop.id, duration: stop.duration, arrival: arrivals[i], known: Boolean(hours?.isKnown),
      fits: Boolean(hours?.isKnown && isCandidateOpenForVisit({ ...stop, openingHours: hours },arrivals[i],stop.duration)) };
  });
  const first = plan.stops[0];
  const firstDistanceKm = first && Number.isFinite(first.lat) && Number.isFinite(first.lng) &&
    Number.isFinite(input.location.lat) && Number.isFinite(input.location.lng)
    ? calculateDistance(input.location.lat,input.location.lng,first.lat,first.lng) : null;
  const checks = { capacity: Number.isFinite(getPlanActualDuration(plan)) && getScheduleCapacityMinutes(input) !== null &&
      getPlanActualDuration(plan) <= getScheduleCapacityMinutes(input),
    meal: getRequiredMealCoverageIssues(plan,input).length === 0,
    opening: opening.length > 0 && opening.every(row => row.fits),
    minimumStay: plan.stops.every(stop => stop.duration >= getMinimumStopDuration(stop)),
    routes: plan.transportSegments.length === Math.max(0,plan.stops.length-1) && plan.transportSegments.every((leg,i) =>
      leg.fromStopId === plan.stops[i].id && leg.toStopId === plan.stops[i+1].id && Number.isFinite(leg.duration) && leg.duration > 0 && !leg.label?.includes('(估算)')),
    requestedWindow: start !== null && end !== null && arrivals.length > 0 && arrivals[0] >= start &&
      arrivals.at(-1) + plan.stops.at(-1).duration <= end,
    firstDistance: firstDistanceKm !== null && firstDistanceKm <= FIRST_STOP_MAX_DISTANCE_KM,
    prohibition: getForbiddenVisitIssues(plan,input).length === 0 };
  return { checks, passed: Object.values(checks).every(Boolean), opening,
    startDelayMinutes: start === null || !arrivals.length ? null : arrivals[0]-start,
    mealIssues: getRequiredMealCoverageIssues(plan,input), firstDistanceKm };
}
function __b2DurationBound(stop, plan, input) {
  // This is a local coverage clamp guard, not a floor on raw AI or restored visits.
  // Earlier capacity/opening/meal repairs keep their changed duration. Unknown or
  // failing execution evidence conservatively leaves the existing bound in force.
  const audit = __executionAudit(plan,input), min = getMinimumStopDuration(stop), max = getMaximumStopDuration(stop);
  const trace = __trace(stop);
  const retainedOriginal = Number.isFinite(trace.aiOriginalMinutes) && stop.duration <= trace.aiOriginalMinutes &&
    !trace.events.some(event => event.identityChanged);
  const preserved = retainedOriginal && audit.passed && stop.duration > max;
  const after = clamp(stop.duration,min,preserved ? stop.duration : max);
  if (__experiment.traceEnabled) __experiment.b2Bounds.push({ stopId: stop.id, name: stop.name,
    before: stop.duration, minimum: min, softMaximum: max, after, preserved, retainedOriginal, audit });
  return after;
}
