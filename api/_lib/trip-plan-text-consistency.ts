import type { Stop, TripPlan } from '../../src/types/trip.js'
import { getTripPlanStyleLabel } from '../../src/services/ai/tripPlanIdentity.js'

type NamedPlace = Pick<Stop, 'name' | 'placeId'>
// Private, per-plan lineage. Never add search candidates or names from other styles.
const selectedNames = new WeakMap<TripPlan, Map<string, NamedPlace>>()
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('zh-TW').replace(/\s+/g, ' ').trim()
const places = (plan: TripPlan) => [...(plan.stops ?? []), ...(plan.rainBackup ?? [])]

export function rememberPlanTextTransition<T extends TripPlan>(source: TripPlan, target: T,
  ...selectedStages: readonly (TripPlan | readonly Stop[])[]): T {
  const history = new Map<string, NamedPlace>()
  for (const stage of [source, ...selectedStages, target]) {
    const isPlan = 'stops' in stage
    if (isPlan) for (const [key, value] of selectedNames.get(stage) ?? []) history.set(key, value)
    for (const stop of isPlan ? places(stage) : stage) {
      if (stop.name?.trim()) history.set(JSON.stringify([stop.placeId, normalize(stop.name)]),
        { name: stop.name, placeId: stop.placeId })
    }
  }
  selectedNames.set(source, history)
  selectedNames.set(target, history)
  return target
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// This is deliberately a small set of explicit copy forms, not Chinese word
// segmentation or semantic inference. Every unrecognised context is unresolved.
export function assessRemovedPlaceReference(text: string, old: NamedPlace,
  current: readonly NamedPlace[]): 'confirmed' | 'retained' | 'unresolved' {
  const name = normalize(old.name)
  if (current.some(now => (old.placeId && now.placeId === old.placeId) || normalize(now.name) === name)) return 'retained'
  if (!old.placeId?.trim() || !name || !current.length || current.some(now =>
    !now.placeId?.trim() || normalize(now.name).includes(name))) return 'unresolved'
  // A complete name still needs distinguishing venue wording. Bare types,
  // regions, short names and generic descriptive venue labels are insufficient.
  const chinese = /^([\p{Script=Han}]{2,})(?:咖啡商行|咖啡館|咖啡店|咖啡廳|餐廳|餐館|藝術館|美術館|博物館|文物館)$/u.exec(name)
  const latin = /^(.{2,})\s+caf[eé]$/u.exec(name)
  if ((!chinese && !latin) || (chinese && /^(?:地方|在地|當地|附近|城市|市區|社區|一般|特色|文化|藝術)$/.test(chinese[1]))) return 'unresolved'
  const literal = escape(name)
  const quoted = `(?:「${literal}」|『${literal}』|“${literal}”|"${literal}")`
  // An unquoted cafe/gallery name can still be an ordinary description. Require
  // explicit naming quotes; retain the full business-name form 咖啡商行 only in
  // the closed affirmative copy forms below. No short brand is ever inferred.
  const named = name.endsWith('咖啡商行') ? `(?:${literal}|${quoted})` : quoted
  const value = normalize(text)
  // Match the whole field. A name inside another word, a recollection, negation,
  // conditional sentence or an unrelated clause never supplies positive proof.
  const title = new RegExp(`^${named}(?:小旅行)?[。！!]?$`, 'u')
  const visit = new RegExp(`^(?:先|再|接著|雨天)?(?:到|前往|在|走訪|造訪)\\s*${named}\\s*(?:休息|喝咖啡|用餐|參觀)?(?:[，,]再沿途(?:散步|走走))?[。！!]?$`, 'u')
  return title.test(value) || visit.test(value) ? 'confirmed' : 'unresolved'
}

export function finalizePlanText(plan: TripPlan): TripPlan {
  const history = selectedNames.get(plan)
  if (!history) return plan
  const current = places(plan)
  const fallbacks = {
    title: getTripPlanStyleLabel(plan.type) ?? '出遊方案',
    subtitle: '依行程地點安排的出遊路線',
    summary: '依下方地點與順序展開行程，各站安排可查看詳細資訊。',
  }
  let result = plan
  for (const field of ['title', 'subtitle', 'summary'] as const) {
    const stale = [...history.values()].some(old =>
      assessRemovedPlaceReference(plan[field] ?? '', old, current) === 'confirmed')
    if (stale) {
      if (result === plan) result = { ...plan }
      result[field] = fallbacks[field]
    }
  }
  return result === plan ? plan : rememberPlanTextTransition(plan, result)
}
