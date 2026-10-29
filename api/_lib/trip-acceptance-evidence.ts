import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectCoverageDiagnostics } from './trip-coverage-diagnostics-projection.js'

type Service = 'ai' | 'places_search' | 'places_details' | 'geocoding' | 'routes' | 'supabase'
type Stage = 'initial' | 'initial_json_repair' | 'retry' | 'refill'
type Version = { attempt: number; type: string }
type Attempt = { id: number; stage: Stage; targets: string[]; httpStatus: number | null;
  parseStatus: string; reasons: string[]; plans: ReturnType<typeof projectRawPlan>[];
  usage: Record<string, number> | 'unknown' }
type ResponseSink = { write: (chunk: string) => void; json: (body: unknown) => void;
  status: (status: number) => unknown; end: () => void }
// Shape consumed by the projections; provider values retain the runtime checks below.
type EvidenceObject = Record<string, unknown> & {
  id?: string; type?: string; duration?: number;
  messages?: Array<{ content?: unknown }>;
  plans?: EvidenceObject[]; stops?: unknown[]; rainBackup?: unknown[]; results?: unknown[];
}
type Context = { id: string; startedAt: string; manifest: object; prompts: object[]; attempts: Attempt[];
  responses: WeakMap<object, number>; versions: WeakMap<object, Version>; latestAttempt: number | null;
  decisions: object[]; final: unknown; finalVersions: Array<Version & { rawPlanIndex: number | null }>;
  diagnostics: unknown; calls: object[]; totals: Partial<Record<Service, { sent: number; succeeded: number; failed: number }>>;
  cache: Record<string, number>; points: { requestedCost: number | null; outcome: string; balanceDelta: 'unknown' };
  incomplete: Set<string>; sequence: number }
const scope = new AsyncLocalStorage<Context>()
const types = ['safe', 'balanced', 'explore']
const LIMIT = { attempts: 12, calls: 512, decisions: 256, plans: 12, stops: 40, text: 262144, file: 2 * 1024 * 1024 }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): EvidenceObject => value && typeof value === 'object' && !Array.isArray(value) ? value as EvidenceObject : {}
const id = (value: unknown) => typeof value === 'string' && /^[\w-]{1,200}$/.test(value) ? value : null
const short = (value: unknown, max = 240) => typeof value === 'string' ? value.slice(0, max) : null
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

export function acceptanceEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.TRIP_CANDIDATE_DEBUG === 'true'
}
// Every observer is fail-open. Never retry an operation because observation failed.
function observe(fn: (context: Context) => void) {
  const context = scope.getStore()
  if (context) try { fn(context) } catch { context.incomplete.add('observer_error') }
}
export function recordEvidenceCache(kind: 'places_details' | 'routes') {
  observe(c => { c.cache[kind] = (c.cache[kind] ?? 0) + 1 })
}
export function classifyGoogleEvidenceCall(url: string): Service {
  const target = new URL(url)
  return target.hostname === 'maps.googleapis.com' ? 'geocoding'
    : target.pathname.endsWith(':searchText') ? 'places_search' : 'places_details'
}
export function observeGoogleEvidenceCall<T>(url: string, operation: () => Promise<T>) {
  if (!scope.getStore()) return operation()
  let service: Service
  try { service = classifyGoogleEvidenceCall(url) } catch { observe(c => { c.incomplete.add('call_classification_failed') }); return operation() }
  return observeEvidenceCall(service, operation)
}
export function observeEvidenceCall<T>(service: Service, operation: () => Promise<T>): Promise<T> {
  const context = scope.getStore()
  if (!context) return operation()
  let entry: { sequence: number; service: Service; status: string; httpStatus: number | null; aiAttemptId: number | null } | undefined
  observe(c => {
    c.totals[service] ??= { sent: 0, succeeded: 0, failed: 0 }
    c.totals[service]!.sent++
    // Non-AI calls are not necessarily caused by the most recent model attempt.
    entry = { sequence: ++c.sequence, service, status: 'pending', httpStatus: null,
      aiAttemptId: service === 'ai' ? c.latestAttempt : null }
    if (c.calls.length < LIMIT.calls) c.calls.push(entry)
    else c.incomplete.add('call_records_truncated')
  })
  const finish = (status: number | null, failed: boolean) => observe(c => {
    if (entry) { entry.httpStatus = status; entry.status = failed ? 'failed' : 'succeeded' }
    c.totals[service]![failed ? 'failed' : 'succeeded']++
  })
  return (async () => {
    let value: T
    try { value = await operation() } catch (error) { finish(null, true); throw error }
    const status = number(object(value).status)
    finish(status, status !== null && status >= 400)
    return value
  })()
}

export async function evidenceAiFetch(stage: Stage, targets: readonly string[], url: string, init: RequestInit) {
  const context = scope.getStore()
  if (!context) return fetch(url, init)
  let attempt: Attempt | undefined
  observe(c => {
    if (c.attempts.length >= LIMIT.attempts) { c.incomplete.add('ai_attempts_truncated'); c.latestAttempt = null; return }
    attempt = { id: c.attempts.length + 1, stage, targets: targets.filter(t => types.includes(t)),
      httpStatus: null, parseStatus: 'not_observed', reasons: [], plans: [], usage: 'unknown' }
    c.attempts.push(attempt); c.latestAttempt = attempt.id
    const bodyText = String(init.body)
    if (Buffer.byteLength(bodyText) > LIMIT.text * 4) { c.incomplete.add('prompt_capture_limit'); return }
    const body = object(JSON.parse(bodyText))
    const prompt = body.messages?.[0]?.content
    if (typeof prompt !== 'string') { c.incomplete.add('prompt_unavailable'); return }
    const rawIds = [...prompt.matchAll(/^- name=.*?placeId="([^"]+)"/gm)].map(m => m[1])
    const exposedIds = rawIds.filter(value => id(value))
    if (rawIds.length !== exposedIds.length) c.incomplete.add('prompt_identity_projection_omitted')
    const blocks = [...prompt.matchAll(/CURRENT_INTENT_CANDIDATE_LINKS:\n([^]*?)\nEND_CURRENT_INTENT_CANDIDATE_LINKS/g)]
    let links: Record<string, string[]> | null = null
    if (blocks.length) {
      const raw = object(JSON.parse(blocks[0][1].split('\n').at(-1)!))
      const keys = ['culture_primary', 'coffee_venue', 'mixed_or_uncertain']
      // Optional for historical Prompts: absent is different from a captured [].
      // Project only the actual request, never reclassify candidates here.
      if (Object.hasOwn(raw, 'culture_related_unverified')) {
        const related = raw.culture_related_unverified
        if (Array.isArray(related)) keys.push('culture_related_unverified')
        if (!Array.isArray(related) || related.length > 42 || related.some(value => !id(value))) {
          c.incomplete.add('culture_related_unverified_projection_omitted')
        }
      }
      links = Object.fromEntries(keys.map(key => [key,
        Array.isArray(raw[key]) ? raw[key].slice(0, 42).map(id).filter((value: string | null): value is string => value !== null) : []]))
    }
    c.prompts.push({ attemptId: attempt.id, stage, exposedIds: exposedIds.slice(0, 42),
      links, blockCount: blocks.length, linksPresent: blocks.length > 0,
      linkedIdsExposed: links ? Object.values(links).flat().every(value => exposedIds.includes(value)) : null,
      characters: prompt.length, utf8Bytes: Buffer.byteLength(prompt), sha256: hash(prompt) })
    if (exposedIds.length > 42) c.incomplete.add('prompt_ids_truncated')
    if (blocks.length > 1) c.incomplete.add('duplicate_intent_blocks')
    if (links && Object.values(links).flat().some(value => !exposedIds.includes(value))) c.incomplete.add('intent_identity_not_exposed')
  })
  let response: Response
  try { response = await observeEvidenceCall('ai', () => fetch(url, init)) }
  catch (error) {
    observe(() => { if (attempt) { attempt.parseStatus = 'unavailable'; attempt.reasons.push('transport_error') } })
    throw error
  }
  observe(c => {
    if (attempt) {
      attempt.httpStatus = response.status
      if (!response.ok) { attempt.parseStatus = 'unavailable'; attempt.reasons.push('http_error') }
      c.responses.set(response, attempt.id)
    }
  })
  return response
}
function attemptFor(c: Context, response: object) { return c.attempts.find(a => a.id === c.responses.get(response)) }
function projectRawPlan(value: unknown, index: number) {
  const plan = object(value), reasons: string[] = []
  if (typeof plan.id !== 'string' || !plan.id.trim() || !types.includes(plan.type ?? '') || types.includes(plan.id) && plan.id !== plan.type) reasons.push('invalid_identity')
  else if (!id(plan.id)) reasons.push('identity_projection_omitted')
  if (!Array.isArray(plan.stops) || !plan.stops.length) reasons.push('missing_stops')
  const seen = new Set<string>()
  const stops = (Array.isArray(plan.stops) ? plan.stops : []).slice(0, LIMIT.stops).map((value: unknown, order: number) => {
    const stop = object(value), stopId = id(stop.id), duration = number(stop.duration)
    if (typeof stop.id !== 'string' || !stop.id.trim() || typeof stop.placeId !== 'string' || !stop.placeId.trim()
      || duration === null || duration <= 0) reasons.push('invalid_stop')
    if ((typeof stop.id === 'string' && !stopId) || (typeof stop.placeId === 'string' && !id(stop.placeId))) reasons.push('identity_projection_omitted')
    if (stopId && seen.has(stopId)) reasons.push('duplicate_stop_id')
    if (stopId) seen.add(stopId)
    return { order, id: stopId, placeId: id(stop.placeId), duration: number(stop.duration),
      durationValueType: typeof stop.duration }
  })
  return { rawPlanIndex: index, id: id(plan.id), type: id(plan.type), stops,
    reasons: [...new Set(reasons)], disposition: 'observed_not_final' }
}
// Called on model content BEFORE the application's identity normalizer/parser.
export function recordRawAiPlan(response: object, value: unknown) {
  observe(c => {
    const attempt = attemptFor(c, response)
    if (!attempt) return
    if ((object(value).stops?.length ?? 0) > LIMIT.stops) c.incomplete.add('raw_projection_truncated')
    if (attempt.plans.length < LIMIT.plans) {
      const projected = projectRawPlan(value, attempt.plans.length)
      attempt.plans.push(projected)
      if (projected.reasons.includes('identity_projection_omitted')) c.incomplete.add('identity_projection_omitted')
    }
    else c.incomplete.add('raw_plans_truncated')
  })
}
export function recordAiModelText(response: object, text: unknown) {
  observe(c => {
    const attempt = attemptFor(c, response)
    if (!attempt) return
    if (typeof text !== 'string') { attempt.parseStatus = 'failed'; attempt.reasons.push('invalid_model_envelope'); return }
    if (Buffer.byteLength(text) > LIMIT.text) { attempt.parseStatus = 'not_captured'; c.incomplete.add('model_content_limit'); return }
    let raw: EvidenceObject
    try { raw = object(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))) }
    catch { attempt.parseStatus = 'failed'; attempt.reasons.push('invalid_json'); return }
    attempt.parseStatus = Array.isArray(raw.plans) ? 'parsed' : 'failed'
    if (!Array.isArray(raw.plans)) { attempt.reasons.push('invalid_format'); return }
    if (raw.plans.length > LIMIT.plans || raw.plans.some((p: EvidenceObject) => (p?.stops?.length ?? 0) > LIMIT.stops)) c.incomplete.add('raw_projection_truncated')
    attempt.plans = raw.plans.slice(0, LIMIT.plans).map(projectRawPlan)
    if (attempt.plans.some(p => p.reasons.includes('identity_projection_omitted'))) c.incomplete.add('identity_projection_omitted')
    const seen = new Set<string>()
    for (const plan of attempt.plans) {
      if (plan.type && seen.has(plan.type)) plan.reasons.push('duplicate_style')
      if (plan.type && !attempt.targets.includes(plan.type)) plan.reasons.push('not_requested_style')
      if (plan.type && !plan.reasons.includes('invalid_identity')) seen.add(plan.type)
    }
  })
}
export function recordAiUsage(response: object, data: unknown) {
  observe(c => {
    const attempt = attemptFor(c, response), raw = object(object(data).usage)
    if (!attempt) return
    const usage: Record<string, number> = {}
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
      const count = number(raw[key])
      if (count !== null && count >= 0) usage[key] = count
    }
    if (Object.keys(usage).length) attempt.usage = usage // Numeric counts only; never token strings or credentials.
  })
}
export function recordAiStreamUsage(response: object, event: string) {
  if (!scope.getStore()) return
  for (const line of event.split('\n')) if (line.startsWith('data:')) {
    try { recordAiUsage(response, JSON.parse(line.slice(5))) } catch { /* [DONE] or malformed SSE is not model JSON */ }
  }
}
export function bindEvidencePlan(response: object, plan: object) {
  observe(c => { const attempt = attemptFor(c, response), type = object(plan).type
    if (attempt && typeof type === 'string' && types.includes(type)) c.versions.set(plan, { attempt: attempt.id, type }) })
}
export function carryEvidencePlan(source: object, target: object) {
  observe(c => { const version = c.versions.get(source); if (version && !c.versions.has(target)) c.versions.set(target, version) })
}
export function getEvidencePlanVersion(plan: object) { return scope.getStore()?.versions.get(plan) ?? null }
export function bindLocalEvidencePlan(plan: { type: string }) {
  observe(c => { c.versions.set(plan, { attempt: 0, type: object(plan).type! }) })
}
export function recordEvidencePlanDecision(plan: object, decision: string, reasons: string[] = []) {
  observe(c => {
    const previous = c.latestAttempt
    c.latestAttempt = c.versions.get(plan)?.attempt ?? null
    recordEvidenceDecision(object(plan).id, decision, reasons)
    c.latestAttempt = previous
  })
}
export function recordEvidenceDecision(planId: unknown, decision: string, reasons: string[] = []) {
  observe(c => {
    if (c.decisions.length >= LIMIT.decisions) { c.incomplete.add('decisions_truncated'); return }
    c.decisions.push({ sequence: ++c.sequence, attemptId: c.latestAttempt, planId: id(planId), decision,
      reasons: reasons.map(reason => /餐|meal/i.test(reason) ? 'meal_validation' : /營業|關門/.test(reason) ? 'opening_validation'
        : /時間|時長|停留/.test(reason) ? 'duration_validation' : /公里|km/.test(reason) ? 'distance_validation' : 'validation_issue') })
  })
}
export function recordEvidenceProfile(stamina: string, sampleCount: number, coffeeSignal: boolean) {
  observe(c => { c.manifest = { ...c.manifest, resolvedStamina: ['弱', '普通', '強'].includes(stamina) ? stamina : 'unknown',
    history: { sampleCount, coffeeSignal, basis: 'existing_server_preference_profile_not_raw_events' } } })
}
export function recordEvidencePoints(outcome: string, requestedCost: number) {
  observe(c => { c.points = { requestedCost, outcome, balanceDelta: 'unknown' } })
}
export function captureAcceptanceDiagnostics(report: unknown) {
  const context = scope.getStore()
  if (!context) return false
  // Reuse snapshots, but exclude raw search queries/custom prose and arbitrary
  // root fields. There is no second stage collector.
  observe(c => {
    const raw = object(report), queries = object(raw.queryLayer), quality = object(raw.qualityDiagnostics)
    const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys
      .filter(key => value[key] !== undefined).map(key => [key, value[key]]))
    const coverageV2 = raw.coverageV2 === undefined ? undefined : projectCoverageDiagnostics(raw.coverageV2)
    if (coverageV2?.projection.incomplete) c.incomplete.add('coverage_v2_projection_incomplete')
    c.diagnostics = {
      ...pick(raw, ['version', 'createdAt', 'outcome', 'candidatePool', 'aiInput', 'aiOutput', 'resultLayer', 'diversity']),
      input: { ...pick(object(raw.input), ['startTime', 'endTime', 'modes']),
        location: { name: short(object(object(raw.input).location).name),
          lat: number(object(object(raw.input).location).lat), lng: number(object(object(raw.input).location).lng) } },
      qualityDiagnostics: pick(quality, ['version', 'intent', 'candidateThemes', 'stages', 'transitions', 'earliestVisible', 'final', 'limitations']),
      ...(coverageV2 === undefined ? {} : { coverageV2 }),
      queryLayer: { ...pick(queries, ['rawPlacesReturnedAcrossQueries', 'finalUniqueRawCandidateCount']),
        batches: (Array.isArray(queries.batches) ? queries.batches : []).map((value: unknown) => ({
          ...pick(object(value), ['phase', 'requestedQueryCount', 'queryLimit', 'truncated']),
          rawPlaceCounts: (object(value).results ?? []).map((row: unknown) => number(object(row).rawPlaceCount)),
        })) },
    }
  })
  return true
}

function revision() {
  try {
    const head = readFileSync('.git/HEAD', 'utf8').trim()
    const value = head.startsWith('ref: refs/') ? readFileSync(join('.git', head.slice(5)), 'utf8').trim() : head
    return /^[a-f0-9]{40}$/.test(value) ? value : 'unknown'
  } catch { return 'unknown' }
}
function sourceHashes() {
  return Object.fromEntries(['api/generate-trip.ts', 'api/_lib/trip-acceptance-evidence.ts',
    'api/_lib/trip-intent-candidate-grounding.ts', 'src/services/ai/tripPlanPrompt.ts'].map(file => {
    try { return [file, hash(readFileSync(file, 'utf8'))] } catch { return [file, 'unknown'] }
  }))
}
function projectFinal(response: unknown) {
  const raw = object(response)
  const pick = (value: unknown, fields: string[]) => Object.fromEntries(fields.filter(key => object(value)[key] !== undefined)
    .map(key => [key, typeof object(value)[key] === 'string' ? short(object(value)[key], 512) : number(object(value)[key])]))
  const stops = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, LIMIT.stops)
    .map(stop => pick(stop, ['id', 'placeId', 'name', 'type', 'duration', 'address', 'lat', 'lng', 'candidateRole', 'foodSubtype']))
  const legs = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, LIMIT.stops)
    .map(leg => pick(leg, ['fromStopId', 'toStopId', 'mode', 'duration', 'publicTransitType']))
  return { sha256: hash(JSON.stringify(response)), representation: 'public_plan_allowlist',
    plans: (Array.isArray(raw.plans) ? raw.plans : []).slice(0, LIMIT.plans).map((p: EvidenceObject) => ({
      ...pick(p, ['id', 'type', 'title', 'subtitle', 'summary', 'totalTime', 'budget', 'transportMode', 'scheduleStartTime']),
      stops: stops(p.stops), transportSegments: legs(p.transportSegments), rainBackup: stops(p.rainBackup), rainTransportSegments: legs(p.rainTransportSegments),
    })) }
}
export function recordEvidenceDelivery(value: unknown) {
  observe(c => {
    const event = object(value)
    if (event.event !== 'done') return
    const plans = object(event.response).plans
    if (Array.isArray(plans) && (plans.length > LIMIT.plans || plans.some(p => (p?.stops?.length ?? 0) > LIMIT.stops || (p?.rainBackup?.length ?? 0) > LIMIT.stops))) c.incomplete.add('final_projection_truncated')
    c.final = projectFinal(event.response)
    for (const plan of object(event.response).plans ?? []) {
      const version = c.versions.get(plan)
      if (!version) { c.incomplete.add('final_version_unknown'); continue }
      const attempt = c.attempts.find(a => a.id === version.attempt)
      const raw = attempt?.plans.find(p => p.type === version.type && !p.reasons.includes('invalid_identity'))
      if (version.attempt !== 0 && !raw) c.incomplete.add('final_raw_version_unknown')
      c.finalVersions.push({ ...version, rawPlanIndex: raw?.rawPlanIndex ?? null })
    }
  })
}
function finish(context: Context) {
  const envelope = (data: unknown) => ({ requestId: context.id, data })
  if (!context.final) context.incomplete.add('no_done_response')
  if (!context.diagnostics) context.incomplete.add('no_candidate_diagnostics')
  const initialSources = object(context.manifest).sourceSha256
  if (initialSources && JSON.stringify(initialSources) !== JSON.stringify(sourceHashes())) context.incomplete.add('source_changed_during_request')
  if (context.points.outcome === 'attempted') context.points.outcome = 'unknown_after_attempt'
  for (const attempt of context.attempts) if (attempt.parseStatus === 'not_observed') {
    attempt.parseStatus = 'unavailable'; attempt.reasons.push('no_model_content_observed')
  }
  for (const attempt of context.attempts) for (const plan of attempt.plans) {
    const selected = context.finalVersions.some(v => v.attempt === attempt.id && v.rawPlanIndex === plan.rawPlanIndex)
    plan.disposition = selected ? 'final_selected' : 'not_final_selected'
  }
  const attemptReports = context.attempts.map(attempt => ({ ...attempt,
    finalSelectedTypes: context.finalVersions.filter(v => v.attempt === attempt.id).map(v => v.type),
    outcome: context.finalVersions.some(v => v.attempt === attempt.id) ? 'contributed_to_final' : 'not_final_selected' }))
  const folder = join(process.env.TRIP_ACCEPTANCE_EVIDENCE_DIR || '.tripneeder-acceptance-evidence', context.id)
  const files = { 'prompt-evidence.json': envelope(context.prompts),
    'ai-attempts.json': envelope({ attempts: attemptReports, decisions: context.decisions, finalVersions: context.finalVersions }),
    'diagnostics.json': envelope(context.diagnostics), 'final-response.json': envelope(context.final),
    'calls-and-points.json': envelope({ calls: context.calls, totals: context.totals, cacheHits: context.cache,
      cacheScope: 'application_cache_only_provider_cache_unknown',
      points: context.points, providerCost: 'unknown', scope: 'this_generate_trip_request_only' }) }
  const saved: Record<string, string> = {}
  try {
    mkdirSync(folder, { recursive: true })
    for (const [file, data] of Object.entries(files)) {
      let text = JSON.stringify(data)
      if (Buffer.byteLength(text) > LIMIT.file) { context.incomplete.add(`${file}:size_limit`); text = JSON.stringify(envelope({ omitted: 'size_limit' })) }
      try { writeFileSync(join(folder, file), text + '\n', { encoding: 'utf8', flag: 'wx' }); saved[file] = hash(text + '\n') }
      catch { context.incomplete.add(`${file}:write_failed`) }
    }
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ requestId: context.id, schemaVersion: 1,
      startedAt: context.startedAt, finishedAt: new Date().toISOString(), ...context.manifest,
      status: context.incomplete.size ? 'incomplete' : 'complete', reasons: [...context.incomplete], files: saved }) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch { context.incomplete.add('manifest_or_directory_write_failed') }
  try {
    console[context.incomplete.size ? 'warn' : 'info'](context.incomplete.size ? '[acceptance-evidence-incomplete]' : '[acceptance-evidence-saved]',
      { requestId: context.id, status: context.incomplete.size ? 'incomplete' : 'complete', reasons: [...context.incomplete] })
  } catch { /* Never affect the response. */ }
}

export function withAcceptanceEvidence<T extends ResponseSink>(body: unknown, res: T, run: (sink: T) => Promise<void>) {
  if (!acceptanceEnabled()) return run(res)
  let context: Context
  try {
    const input = object(object(body).input), checkoutRevision = revision(), sources = sourceHashes()
    context = { id: randomUUID(), startedAt: new Date().toISOString(),
    manifest: { checkoutRevision, sourceSha256: sources,
      versionBasis: 'checkout_revision_and_source_hashes_not_clean_checkout_assertion', environment: 'non-production',
      input: { category: id(input.category), customCategory: input.customCategory === '文化景點＋咖啡廳' ? input.customCategory : 'not_saved',
        startTime: short(input.startTime, 5), endTime: short(input.endTime, 5), people: number(input.people), transportMode: id(input.transportMode),
        tags: Array.isArray(input.tags) ? input.tags.filter((tag: unknown) => ['not_too_tired', 'indoor_first', 'hidden_gems',
          'short_distance', 'food_first', 'photo_first', 'no_full_meals'].includes(String(tag))).slice(0, 7) : [] } },
    prompts: [], attempts: [], responses: new WeakMap(), versions: new WeakMap(), latestAttempt: null,
    decisions: [], final: null, finalVersions: [], diagnostics: null, calls: [], totals: {}, cache: { places_details: 0, routes: 0 },
    points: { requestedCost: null, outcome: 'not_attempted', balanceDelta: 'unknown' }, incomplete: new Set(), sequence: 0 }
    if (checkoutRevision === 'unknown' || Object.values(sources).includes('unknown')) context.incomplete.add('source_version_unknown')
  } catch {
    try { console.warn('[acceptance-evidence-incomplete]', { status: 'incomplete', reasons: ['initialization_failed'] }) } catch { /* no-op */ }
    return run(res)
  }
  return scope.run(context, async () => {
    try { await run(res) } finally { try { finish(context) } catch { try { console.warn('[acceptance-evidence-incomplete]', { requestId: context.id, status: 'incomplete', reasons: ['finalize_error'] }) } catch { /* no-op */ } } }
  })
}
