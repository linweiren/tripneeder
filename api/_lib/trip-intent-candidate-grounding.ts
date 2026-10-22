import type { TripInput } from '../../src/types/trip.js'
import { resolveCandidateRankingContext } from './candidate-ranking-context.js'
import { getPromptCandidateSelection, hasConfirmedCulturalPrimaryPurpose,
  type NearbyPlaceCandidates } from './google-places.js'

// Prompt-only evidence projection. Never expand the shortlist or change its order.
export function buildIntentCandidateGrounding(input: TripInput, candidates: NearbyPlaceCandidates): string {
  const intent = resolveCandidateRankingContext(input)
  if (intent.customStatus !== 'recognized' || intent.avoidCoffee || intent.themes.length !== 2 ||
    !intent.themes.includes('culture') || !intent.themes.includes('coffee')) return ''
  const exposed = getPromptCandidateSelection(candidates).promptCandidates
  if (!exposed.length) return ''
  const groups: Record<string, string[]> = {
    culture_primary: [], coffee_venue: [], mixed_or_uncertain: [], culture_related_unverified: [],
  }
  for (const candidate of exposed) {
    const types = candidate.types ?? []
    const culturalTypes = types.some(type => ['museum', 'art_gallery'].includes(type))
    const coffeeTypes = types.some(type => ['cafe', 'coffee_shop'].includes(type))
    const culturalPrimary = hasConfirmedCulturalPrimaryPurpose(candidate)
    if (culturalPrimary) groups.culture_primary.push(candidate.placeId)
    else if (!culturalTypes && coffeeTypes && candidate.role === 'food' && candidate.foodSubtype === 'cafe') {
      groups.coffee_venue.push(candidate.placeId)
    } else if (culturalTypes || candidate.role === 'food' && candidate.foodSubtype === 'cafe') {
      groups.mixed_or_uncertain.push(candidate.placeId)
    }
    // Context only: do not change primary purpose, food evidence or ranking.
    if (!culturalPrimary && types.some(type => ['historical_landmark', 'historical_place'].includes(type))) {
      groups.culture_related_unverified.push(candidate.placeId)
    }
  }
  const guidance = [
    'CURRENT_INTENT_CANDIDATE_LINKS:',
    '本次需求：文化景點＋咖啡廳；文化需求不因歷史咖啡偏好降低。僅列已曝光ID，沿用排序與score。',
    'culture_primary＝文化主用途證據；coffee_venue＝咖啡提示；mixed_or_uncertain＝用途待確認。',
    'culture_related_unverified＝types有歷史線索，非已確認展覽、導覽或文化活動；勿據此虛構內容。',
    '未列不代表沒有文化價值。室內桶不是文化證據，附設咖啡不證明獨立咖啡體驗或正餐。',
    '不強制選用或跨案換點；依可行性兼顧需求、其他活動及各風格。營業、首站、餐期、交通優先；咖啡非可靠正餐，勿猜測展覽、導覽、菜單或活動深度。',
  ].join('\n')
  // Keep the three existing groups first; shorter guidance pays for the new key
  // without reducing their ID budget. Related clues get remaining space (max 4).
  // The whole block still fits 1,800 UTF-8 bytes; never truncate an ID or a row.
  const selected: typeof groups = {
    culture_primary: [], coffee_venue: [], mixed_or_uncertain: [], culture_related_unverified: [],
  }
  const render = () => `${guidance}\n${JSON.stringify(selected)}\nEND_CURRENT_INTENT_CANDIDATE_LINKS`
  for (const group of Object.keys(groups)) {
    for (const id of groups[group]) {
      if (selected[group].length === (group === 'culture_related_unverified' ? 4 : 3)) break
      selected[group].push(id)
      if (Buffer.byteLength(render(), 'utf8') > 1800) selected[group].pop()
    }
  }
  return render()
}
