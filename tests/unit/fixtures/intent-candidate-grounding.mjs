import { styleGenerationFixture } from './style-generation.mjs'
import { FIXED_NOW } from './supplement-quality.mjs'

export const intentCases = ['mixed', 'unexposed', 'uncertain', 'illegal-culture', 'history-coffee',
  'coffee-only', 'culture-only', 'explore', 'negative', 'conditional', 'unknown', 'three-themes',
  'retry-balanced', 'retry-invalid', 'stream-tail', 'related-history', 'related-retry', 'related-refill']

export const stripIntentLinks = text => text.replace(/\n\nCURRENT_INTENT_CANDIDATE_LINKS:\n[^]*?\nEND_CURRENT_INTENT_CANDIDATE_LINKS/g, '')
export const readIntentLinks = text => {
  const block = /CURRENT_INTENT_CANDIDATE_LINKS:\n([^]*?)\nEND_CURRENT_INTENT_CANDIDATE_LINKS/.exec(text)?.[1]
  return block ? JSON.parse(block.split('\n').at(-1)) : null
}
// Local heuristic only, not a model tokenizer or provider usage measurement.
export function tokenEstimate(text) {
  const nonAscii = [...text].filter(c => c.codePointAt(0) > 127).length
  const ascii = text.length - nonAscii
  return [Math.ceil(nonAscii + ascii / 4), Math.ceil(nonAscii * 2 + ascii / 3)]
}

export function intentGroundingFixture(kind) {
  const f = styleGenerationFixture(['retry-balanced', 'related-refill'].includes(kind) ? 'missing-balanced' : 'positioning')
  f.input = { ...f.input, category: 'other', customCategory: '文化景點＋咖啡廳', tags: [] }
  const base = f.candidates.allCandidates[0]
  const extra = (id, name, types, lat, role = 'main_activity') => ({ ...base, id, placeId: id, name, types,
    lat, lng: 120.3, distanceKm: (lat - 22.6) * 111, role, type: role === 'food' ? 'food' : 'main_activity',
    foodSubtype: role === 'food' ? 'cafe' : undefined, duration: 60, availabilitySlots: ['early', 'middle', 'late'],
    openingHours: { isKnown: true, isNeverOpen: false, utcOffsetMinutes: 0,
      windows: [{ openAt: new Date(FIXED_NOW), closeAt: new Date(FIXED_NOW + 86400000) }] } })
  f.candidates.allCandidates.push(extra('intent-cafe', '地方咖啡館', ['cafe', 'food'], 22.605, 'food'),
    extra('intent-mixed', '複合藝文咖啡館', ['museum', 'cafe'], 22.606, 'food'),
    extra('intent-book-1', '街角書店', ['book_store'], 22.607), extra('intent-book-2', '城市書店', ['book_store'], 22.608))
  if (kind.startsWith('related-')) f.candidates.allCandidates.push(...Array.from({ length: 4 }, (_, i) =>
    extra(`intent-history-${i}`, `歷史地標${i}`, ['historical_landmark', 'historical_place'], 22.608 + i * .0001)))
  if (kind === 'uncertain') for (const c of f.candidates.allCandidates.filter(c => c.types?.some(t => ['museum', 'art_gallery'].includes(t)))) {
    c.name = c.placeId === 'intent-mixed' ? c.name : `複合藝文咖啡館${c.id}`
    c.types = ['museum', 'cafe']
  }
  if (kind === 'unexposed') {
    f.candidates.allCandidates.push(...Array.from({ length: 34 }, (_, i) =>
      extra(`intent-book-${i + 3}`, `街區書店${i}`, ['book_store'], 22.6001 + i * .00001)))
    for (const c of f.candidates.allCandidates.filter(c => c.types?.some(t => ['museum', 'art_gallery'].includes(t)))) {
      c.lat = 22.635; c.distanceKm = 3.89
    }
  }
  if (['unexposed', 'illegal-culture'].includes(kind)) {
    const books = f.candidates.allCandidates.filter(c => c.placeId.startsWith('intent-book-')).sort((a, b) => a.lat - b.lat)
    const ids = new Set(f.candidates.allCandidates.filter(c => c.types?.some(t => ['museum', 'art_gallery'].includes(t))).map(c => c.placeId))
    for (const p of f.aiPlans) p.stops = p.stops.map((s, i) => ids.has(s.placeId) ? { ...books[i % books.length], id: s.id, duration: s.duration } : s)
  }
  const custom = { 'coffee-only': '想去咖啡廳', 'culture-only': '想參觀博物館', negative: '不想去咖啡廳，想看文化展覽',
    conditional: '如果下雨就看展覽，否則去咖啡廳', unknown: '看心情找有趣的地方', 'three-themes': '想去博物館、咖啡廳與公園' }
  if (custom[kind]) f.input.customCategory = custom[kind]
  if (kind === 'explore') { f.input.category = 'explore'; f.input.customCategory = '' }
  f.mockOptions = { ...f.mockOptions, preferenceEvents: ['history-coffee', 'related-history'].includes(kind) ? Array.from({ length: 15 }, (_, i) => ({
    event_type: 'start_navigation', place_id: `history-${i}`, place_name: '歷史咖啡廳', google_types: ['cafe'],
    candidate_role: 'food', food_subtype: 'cafe', stop_type: 'food', input_category: 'food', input_tags: ['food_first'],
    created_at: new Date(FIXED_NOW - 86400000).toISOString(),
  })) : [], streamTail: kind === 'stream-tail' }
  if (['retry-invalid', 'related-retry'].includes(kind)) {
    f.aiPlans[0].stops[0].duration = 20
    f.aiPlans[0].totalTime -= 130
  }
  for (const c of f.candidates.allCandidates) c.availabilitySlots ??= ['early', 'middle', 'late']
  if (kind === 'unexposed') f.candidates.allCandidates.sort((a, b) => a.distanceKm - b.distanceKm)
  f.candidates.firstStopCandidates = f.candidates.allCandidates.filter(c => c.distanceKm <= 2)
  f.candidates.otherCandidates = f.candidates.allCandidates
  f.routes = {}
  for (const a of f.candidates.allCandidates) for (const b of f.candidates.allCandidates) if (a !== b) f.routes[`${a.placeId}>${b.placeId}`] = 4
  // Refill uses the same fixed bodies, except that invalid/missing initial data is repaired.
  if (!['retry-balanced', 'retry-invalid', 'related-retry', 'related-refill'].includes(kind)) f.plans = structuredClone(f.aiPlans)
  f.transformPlace = place => kind === 'illegal-culture' && place.types?.some(t => ['museum', 'art_gallery'].includes(t))
    ? { ...place, currentOpeningHours: { periods: [] }, regularOpeningHours: { periods: [] } } : place
  return f
}
