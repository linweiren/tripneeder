import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { classificationInput, classificationPlace, snapshotAvailable, savedClassificationPipelines,
  placesFromSavedCandidates } from './candidate-classification.mjs'
import { quotaFixture } from './candidate-quota-consistency.mjs'
import { buildPreferenceProfile } from '../../../src/services/personalization/preferenceProfile.ts'

export async function loadRankingBaseline() {
  const original = execFileSync('git', ['show', 'c4f70a88:api/_lib/google-places.ts'],
    { encoding: 'utf8', cwd: new URL('../../../', import.meta.url) })
  const source = stripTypeScriptTypes(original).replace(/from (['"])([^'"]+)\1/g, (_m, quote, specifier) => {
    const url = specifier.startsWith('.')
      ? new URL(specifier.replace(/\.js$/, '.ts'), new URL('../../../api/_lib/google-places.ts', import.meta.url)).href : specifier
    return `from ${quote}${url}${quote}`
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

export function rankingPlace(id, name, types, km = 1, rating = 4.5, overrides = {}) {
  return classificationPlace(id, name, types, '高雄市文化路1號', {
    location: { latitude: 22.6 + km / 111.19492664455873, longitude: 120.3 }, rating, ...overrides,
  })
}

export const rankingIntents = [
  ['explore', { category: 'explore', customCategory: '', tags: [] }],
  ['other-neutral', { category: 'other', customCategory: '隨意走走', tags: [] }],
  ['culture', { category: 'other', customCategory: '想參觀博物館與美術展覽', tags: [] }],
  ['coffee', { category: 'other', customCategory: '想喝咖啡並逛咖啡廳', tags: [] }],
  ['outdoor-text', { category: 'other', customCategory: '想去公園與戶外走走', tags: [] }],
  ['mixed', { category: 'other', customCategory: '想看文化展覽，途中喝一杯咖啡', tags: [] }],
  ['negative-coffee', { category: 'other', customCategory: '不想去咖啡廳，想看文化展覽', tags: [] }],
  ['contradictory', { category: 'other', customCategory: '想去咖啡廳，也完全不想去咖啡廳', tags: [] }],
  ['no-drink', { category: 'other', customCategory: '想去咖啡廳，但不喝咖啡', tags: [] }],
  ['food-first', { category: 'explore', customCategory: '', tags: ['food_first'] }],
  ['food-category', { category: 'food', customCategory: '', tags: [] }],
  ['outdoor-category', { category: 'outdoor', customCategory: '', tags: [] }],
  ['indoor-category', { category: 'indoor', customCategory: '', tags: [] }],
  ['indoor-first', { category: 'explore', customCategory: '', tags: ['indoor_first'] }],
  ['culture-food-first', { category: 'other', customCategory: '想參觀博物館與美術展覽', tags: ['food_first'] }],
  ['no-meals-text', { category: 'other', customCategory: '不想吃正餐，只想看展覽', tags: [] }],
  ['no-meals-tag', { category: 'explore', customCategory: '', tags: ['no_full_meals'] }],
  ['inactive-custom', { category: 'explore', customCategory: '想參觀博物館與美術展覽', tags: [] }],
  ['tired-short', { category: 'explore', customCategory: '', tags: ['not_too_tired', 'short_distance'] }],
]

export function rankingProfiles() {
  return { none: undefined,
    culture: buildPreferenceProfile(Array.from({ length: 15 }, () => ({ eventType: 'start_navigation',
      googleTypes: ['museum'], candidateRole: 'main_activity', stopType: 'main_activity', inputCategory: 'explore' }))),
    coffee: buildPreferenceProfile(Array.from({ length: 15 }, () => ({ eventType: 'start_navigation', googleTypes: ['cafe'],
      candidateRole: 'food', foodSubtype: 'cafe', stopType: 'food', inputCategory: 'food', inputTags: ['food_first'] }))) }
}

// Reuses the prior 309 audit's input matrix, dates and venue evidence. These
// controlled hours are not claims about actual night-time museum operations.
export function rankingEnvironments() {
  const p = rankingPlace
  const pair = [p('p-cafe', '地方咖啡廳', ['cafe', 'food']), p('p-culture', '地方博物館', ['museum']),
    p('p-meal', '地方料理餐廳', ['restaurant', 'food']), p('p-dessert', '地方甜點店', ['bakery', 'food']),
    p('p-snack', '地方小吃攤', ['food']), p('p-park', '地方公園', ['park']), p('p-mall', '地方商場', ['shopping_mall'])]
  const city = quotaFixture('city-near'), suburb = quotaFixture('suburb'), night = quotaFixture('night-short')
  suburb.places.push(p('far-meal', '郊區料理餐廳', ['restaurant', 'food'], 8))
  night.places.push(p('night-meal', '深夜料理餐廳', ['restaurant', 'food']))
  const sparse = [p('s-cafe', '地方咖啡廳', ['cafe', 'food']), p('s-culture', '地方博物館', ['museum']),
    p('s-meal', '地方料理餐廳', ['restaurant', 'food']), p('s-park', '地方公園', ['park'])]
  const list = [{ id: 'equal-pair', places: pair, input: classificationInput() },
    { id: 'city', places: city.places, input: city.input }, { id: 'suburb', places: suburb.places, input: suburb.input },
    { id: 'night', places: night.places, input: night.input }, { id: 'sparse', places: sparse, input: classificationInput() }]
  if (snapshotAvailable()) for (const snapshot of savedClassificationPipelines()) list.push({ id: `saved-${snapshot.city}`,
    places: placesFromSavedCandidates(snapshot.candidates), input: snapshot.input,
    intentIds: ['explore', 'culture', 'coffee', 'negative-coffee'] })
  return list
}
