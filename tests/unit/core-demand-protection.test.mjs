import test from 'node:test'
import assert from 'node:assert/strict'
import { getCulturalContentEvidence } from '../../api/_lib/trip-cultural-content-evidence.ts'
import { assessVisitRequirements, getSelectedCulturalContent, getVisitRequirementContentText,
  getVisitRequirementWarnings, preservesCoreVisitRequirements } from '../../api/_lib/trip-demand-compliance.ts'
import { getActivityPurpose } from '../../api/_lib/trip-activity-purpose.ts'
import { TripQualityDiagnostics } from '../../api/_lib/trip-quality-diagnostics.ts'

process.env.NODE_ENV = 'production'
const api = await import('../../api/generate-trip.ts')
const input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00',
  endTime: '15:00', people: 2, transportMode: 'scooter', tags: [], location: { name: '市中心' } }
const day = Date.parse('2026-10-26T00:00:00+08:00')
function fixture() {
  const art = { placeId: 'ChIJKTktNo4EbjQRoRKMt38KIUY', name: '光之穹頂',
    lat: 22.6313652, lng: 120.3019167, types: ['tourist_attraction', 'scenic_spot'],
    address: '公開藝術地點', googleMapsUrl: 'https://maps.google.com/', role: 'main_activity',
    score: 95, distanceKm: .7, openingHours: { isKnown: true, isNeverOpen: false, utcOffsetMinutes: 480,
      windows: [{ openAt: new Date(day), closeAt: new Date(day + 86400000) }] } }
  const pet = { ...art, placeId: 'unrelated-pet', name: '動物互動園區', lat: 22.632, score: 99 }
  const unverified = { ...art, placeId: 'unverified-museum', name: '地方博物館', types: ['museum'], score: 99 }
  const otherArt = { ...art, placeId: 'ChIJ6RxSfH0EbjQRFGeK2utk8Q4', name: '城市光廊',
    lat: 22.6230382, lng: 120.3000036, score: 99, distanceKm: .6 }
  const cafe = { ...art, placeId: 'coffee-visit', name: '獨立咖啡館', types: ['cafe'],
    role: 'food', foodSubtype: 'cafe' }
  const stop = { ...art, id: 'activity', type: 'main_activity', duration: 45, description: '',
    googleTypes: art.types, candidateRole: art.role }
  const all = [art, pet, unverified, otherArt, cafe]
  for (const candidate of all) candidate.openingHours = structuredClone(candidate.openingHours)
  const candidates = { allCandidates: all, firstStopCandidates: all, otherCandidates: all }
  const plan = { id: 'balanced', type: 'balanced', title: '原始主題', subtitle: '藝術與咖啡',
    summary: '公共藝術與咖啡休息。', stops: [stop, { ...cafe, id: 'coffee', type: 'food', duration: 60,
      description: '', googleTypes: cafe.types, candidateRole: 'food' }],
    totalTime: 110, budget: 500, transportMode: 'scooter',
    transportSegments: [{ fromStopId: 'activity', toStopId: 'coffee', duration: 5, mode: 'scooter', label: '' }] }
  return { art, pet, unverified, otherArt, cafe, stop, candidates, plan }
}

test('reviewed cultural content requires the actual ID and matching coordinates, not a name or Google tags', () => {
  const f = fixture()
  assert.equal(getCulturalContentEvidence(f.art).content, '玻璃公共藝術觀賞')
  assert.equal(getCulturalContentEvidence({ name: f.art.name, types: f.art.types }), undefined)
  assert.equal(getCulturalContentEvidence({ ...f.art, placeId: 'different-id' }), undefined)
  assert.equal(getCulturalContentEvidence({ ...f.art, lat: 25 }), undefined)
  assert.equal(getCulturalContentEvidence(f.unverified), undefined)
  assert.equal(getActivityPurpose(f.stop), 'activity')
})

for (const request of [
  { category: 'other', customCategory: '想去咖啡廳' },
  { category: 'explore', customCategory: '' },
]) test(`reviewed culture does not change optional selection without culture demand: ${request.category}`, t => {
  t.mock.timers.enable({ apis: ['Date'], now: day })
  const f = fixture()
  const pool = { allCandidates: [f.art, f.pet], firstStopCandidates: [f.art, f.pet], otherCandidates: [f.art, f.pet] }
  const nonCulture = { ...input, ...request }
  const select = original => api.pickCandidateForStop(original, 1, pool, new Set(), new Set(),
    new Set([f.art.placeId]), undefined, 645, false, nonCulture)
  // Same original taxonomy, ranking and cross-plan reuse as the audited controls.
  assert.equal(select(f.stop).placeId, f.pet.placeId)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.pet, nonCulture, pool), true)
  assert.deepEqual(getSelectedCulturalContent(f.plan, nonCulture, pool), [])
  assert.equal(getVisitRequirementContentText(f.plan, nonCulture, pool), '')
})

test('a repeated source-backed activity cannot become an unrelated activity or taxonomy-only culture for optional variety', t => {
  t.mock.timers.enable({ apis: ['Date'], now: day })
  const f = fixture()
  const pool = { allCandidates: [f.art, f.pet, f.unverified], firstStopCandidates: [f.art], otherCandidates: [f.pet, f.unverified] }
  const selected = api.pickCandidateForStop(f.stop, 1, pool, new Set(), new Set(), new Set([f.art.placeId]),
    undefined, 645, false, input)
  assert.equal(selected.placeId, f.art.placeId)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.pet, input, pool), false)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.unverified, input, pool), false)
})

test('a comparable available alternative with cultural content remains eligible', t => {
  t.mock.timers.enable({ apis: ['Date'], now: day })
  const f = fixture()
  const selected = api.pickCandidateForStop(f.stop, 1, f.candidates, new Set(), new Set(), new Set([f.art.placeId]),
    undefined, 645, false, input)
  assert.equal(selected.placeId, f.otherArt.placeId)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.otherArt, input, f.candidates), true)
})

test('necessary exclusion or closure can still replace the original; protection adds no safety gate', t => {
  t.mock.timers.enable({ apis: ['Date'], now: day })
  const f = fixture()
  const pool = { allCandidates: [f.art, f.pet], firstStopCandidates: [f.art, f.pet], otherCandidates: [f.art, f.pet] }
  assert.equal(api.pickCandidateForStop(f.stop, 1, pool, new Set(), new Set([f.art.placeId]),
    new Set(), undefined, 645, false, input).placeId, f.pet.placeId)
  f.art.openingHours.isNeverOpen = true
  const closedPool = { allCandidates: [f.art, f.unverified], firstStopCandidates: [f.art, f.unverified],
    otherCandidates: [f.art, f.unverified] }
  assert.equal(api.pickCandidateForStop(f.stop, 1, closedPool, new Set(), new Set(),
    new Set([f.art.placeId]), undefined, 645, false, input).placeId, f.unverified.placeId)
})

test('the core guard applies to other explicit demands and does not invent demands for other categories', () => {
  const f = fixture(), cafeStop = f.plan.stops[1]
  const meal = { ...f.cafe, placeId: 'restaurant', types: ['restaurant'], foodSubtype: 'restaurant' }
  assert.equal(preservesCoreVisitRequirements(cafeStop, meal, input, f.candidates), false)
  const park = { ...f.art, placeId: 'park', name: '河畔公園', types: ['park'], role: 'open_space' }
  const parkStop = { ...f.stop, ...park, googleTypes: park.types, candidateRole: park.role }
  const pool = { ...f.candidates, allCandidates: [...f.candidates.allCandidates, park] }
  assert.equal(preservesCoreVisitRequirements(parkStop, f.pet,
    { ...input, customCategory: '想去公園' }, pool), false)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.pet, { ...input, category: 'explore' }, pool), true)
  assert.equal(preservesCoreVisitRequirements(f.stop, f.pet, { ...input, customCategory: '看心情' }, pool), true)
})

test('content-backed public art satisfies broad culture, but does not pretend to be a requested museum', () => {
  const f = fixture()
  assert.deepEqual(assessVisitRequirements(f.plan, input, f.candidates).map(x => x.status), ['satisfied', 'satisfied'])
  assert.equal(assessVisitRequirements(f.plan, { ...input, customCategory: '想參觀博物館' }, f.candidates)[0].status, 'alternative')
  assert.deepEqual(getVisitRequirementWarnings(f.plan, input, f.candidates), [])
})

test('final explanation reflects only delivered identities and distinguishes content from visit logistics', () => {
  const f = fixture()
  const text = api.withVisitRequirementText(f.plan, [], input, f.candidates)
  assert.equal(text.title, f.plan.title)
  assert.match(text.summary, /已確認文化內容：光之穹頂.*玻璃公共藝術/)
  assert.match(text.summary, /來源：https:\/\/www.krtc.com.tw/)
  assert.match(text.summary, /當日場次、入場條件與實際體驗時間仍待確認/)
  assert.equal(api.withVisitRequirementText(text, [], input, f.candidates).summary, text.summary)
  const removed = { ...text, stops: [{ ...f.stop, ...f.pet, id: f.stop.id, googleTypes: f.pet.types }, f.plan.stops[1]] }
  assert.deepEqual(getSelectedCulturalContent(removed, input, f.candidates), [])
  const final = api.withVisitRequirementText(removed, getVisitRequirementWarnings(removed, input, f.candidates), input, f.candidates)
  assert.match(final.summary, /未安排可確認符合/)
  assert.doesNotMatch(final.summary, /已確認文化內容|光之穹頂|krtc.com.tw/)
  const restored = api.withVisitRequirementText({ ...final, stops: f.plan.stops }, [], input, f.candidates)
  assert.match(restored.summary, /已確認文化內容：光之穹頂/)
  assert.doesNotMatch(restored.summary, /未安排可確認符合/)
})

test('types or a model description never become verified cultural content; a food-only visit does not count', () => {
  const f = fixture()
  const plan = { ...f.plan, stops: [{ ...f.stop, ...f.unverified, googleTypes: f.unverified.types,
    description: '有展覽與導覽，一定值得參觀' }, f.plan.stops[1]] }
  assert.equal(getVisitRequirementContentText(plan, input, f.candidates), '')
  assert.match(getVisitRequirementWarnings(plan, input, f.candidates).join(' '), /僅有場館用途資料.*仍待確認/)
  const museumRequest = { ...input, customCategory: '想參觀博物館' }
  const venueOnly = api.withVisitRequirementText(plan, [], museumRequest, f.candidates)
  assert.match(venueOnly.summary, /文化內容說明：.*僅有場館用途資料.*仍待確認/)
  assert.doesNotMatch(venueOnly.summary, /已確認文化內容/)
  assert.equal(api.withVisitRequirementText(venueOnly, [], museumRequest, f.candidates).summary, venueOnly.summary)
  const food = { ...f.plan, stops: [{ ...f.stop, type: 'food' }, f.plan.stops[1]] }
  assert.equal(getVisitRequirementContentText(food, input, f.candidates), '')
  assert.notEqual(assessVisitRequirements(food, input, f.candidates)[0].status, 'satisfied')
})

test('diagnostics expose the same source-backed content and retain unknown programme, admission and duration', () => {
  const f = fixture(), diagnostic = new TripQualityDiagnostics(input)
  diagnostic.recordCandidates(f.candidates)
  const final = diagnostic.buildReport([f.plan]).final[0]
  assert.equal(final.themeCoverage.culture.status, 'confirmed')
  assert.equal(final.stops[0].activityEvidence.status, 'content_confirmed')
  assert.equal(final.stops[0].activityEvidence.duration, 'unknown')
  assert.equal(final.stops[0].activityEvidence.programme, 'unknown')
  assert.equal(final.stops[0].activityEvidence.admission, 'unknown')
})
