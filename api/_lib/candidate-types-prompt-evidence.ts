// Prompt-only projection. Never replace the candidate's full Google types.
const GENERIC_OR_BUSINESS_TYPES = new Set([
  'point_of_interest', 'establishment', 'food', 'store', 'food_store',
  'service', 'wholesaler', 'manufacturer', 'confectionery',
  'meal_delivery', 'food_delivery',
])

export const CANDIDATE_TYPES_PROMPT_GUIDANCE =
  'placeTypes are selected Google venue tags, not primaryType or a complete activity list. ' +
  'Missing tags mean unknown. Mixed tags do not prove separate experiences. ' +
  'tourist_attraction is not cultural evidence. Tags do not verify current exhibitions, tours, ' +
  'menus, operating facilities or visit duration; keep existing intent and safety rules.'

export function getCandidateTypesPromptEvidence(types?: readonly string[]): string[] {
  if (!Array.isArray(types) || types.length === 0 || types.length > 64) return []
  // Reject malformed/oversized input as a whole; never render arbitrary Prompt text.
  if (types.some(type => typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(type))) return []
  const informative = [...new Set(types.filter(type => !GENERIC_OR_BUSINESS_TYPES.has(type)))]
  // A generic attraction tag adds nothing when a more specific venue tag is present.
  const selected = informative.filter(type => type !== 'tourist_attraction' || informative.length === 1)
  // Keep every remaining mixed/conflicting tag, or omit this additional field.
  // In particular, never take the first N tags or infer one from a venue name.
  if (selected.length > 4 || selected.join(',').length > 96) return []
  return selected
}
