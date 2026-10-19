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
  const groups: Record<string, string[]> = { culture_primary: [], coffee_venue: [], mixed_or_uncertain: [] }
  for (const candidate of exposed) {
    const types = candidate.types ?? []
    const culturalTypes = types.some(type => ['museum', 'art_gallery'].includes(type))
    const coffeeTypes = types.some(type => ['cafe', 'coffee_shop'].includes(type))
    if (hasConfirmedCulturalPrimaryPurpose(candidate)) groups.culture_primary.push(candidate.placeId)
    else if (!culturalTypes && coffeeTypes && candidate.role === 'food' && candidate.foodSubtype === 'cafe') {
      groups.coffee_venue.push(candidate.placeId)
    } else if (culturalTypes || candidate.role === 'food' && candidate.foodSubtype === 'cafe') {
      groups.mixed_or_uncertain.push(candidate.placeId)
    }
  }
  const guidance = [
    'CURRENT_INTENT_CANDIDATE_LINKS:',
    '本次正向需求：文化景點＋咖啡廳。以下僅列上方已曝光候選的 ID 範例，沿用原排序與 score，不另加分；當次文化需求不因歷史咖啡偏好而降低優先。',
    'culture_primary＝已有文化主用途證據；coffee_venue＝咖啡場館提示；mixed_or_uncertain＝文化／咖啡用途仍待確認。空列或未列不代表不符合；室內文化桶不等於文化證據，文化場館附咖啡類型也不證明獨立咖啡體驗。',
    '在可行時兼顧兩主題，沿用各指定風格的節奏與組合；不強制每案類型或跨案換地點。營業、首站、餐期及交通規則優先；咖啡不等於可靠正餐。勿推測展覽、導覽、菜單或活動深度。',
  ].join('\n')
  // At most three intact IDs per group and 1,800 UTF-8 bytes overall, including
  // the wrapper. Do not truncate IDs or evict any original candidate information.
  const selected: typeof groups = { culture_primary: [], coffee_venue: [], mixed_or_uncertain: [] }
  const render = () => `${guidance}\n${JSON.stringify(selected)}\nEND_CURRENT_INTENT_CANDIDATE_LINKS`
  for (const group of Object.keys(groups)) {
    for (const id of groups[group]) {
      if (selected[group].length === 3) break
      selected[group].push(id)
      if (Buffer.byteLength(render(), 'utf8') > 1800) selected[group].pop()
    }
  }
  return render()
}
