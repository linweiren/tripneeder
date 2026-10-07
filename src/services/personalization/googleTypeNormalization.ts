// These metadata types carry no preference meaning. Keep raw Places and event data intact.
const GENERIC_PERSONALIZATION_GOOGLE_TYPES = new Set([
  'establishment',
  'point_of_interest',
  'food',
  'store',
])

export function normalizePersonalizationGoogleTypes(values: readonly string[] | null | undefined) {
  if (!values) return []
  return [...new Set(values.map((value) => value.trim()).filter(
    (value) => value.length > 0 && !GENERIC_PERSONALIZATION_GOOGLE_TYPES.has(value),
  ))]
}
