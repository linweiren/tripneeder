import type { Stop } from '../../src/types/trip.js'

// Coarse, local selection hints. These are neither Places facts nor validation gates.
export function getActivityPurpose(stop: Stop) {
  if (stop.type === 'food') return 'food'
  if (stop.type === 'ending_or_transition') return 'transition'
  const types = stop.googleTypes ?? []
  if (types.some(type => ['museum', 'art_gallery', 'cultural_center', 'historical_landmark'].includes(type)) ||
    /(文物館|博物館|美術館|文化|藝術|文創|展覽|古蹟|歷史|紀念館|museum|art gallery)/i.test(stop.name)) return 'culture'
  if (stop.candidateRole === 'open_space' || types.some(type => ['park', 'hiking_area', 'national_park'].includes(type)) ||
    /(公園|步道|海邊|湖|森林|河|海灣|草地|park)/i.test(stop.name)) return 'open_space'
  if (stop.candidateRole === 'shopping' || /(市場|商圈|老街|夜市|百貨|購物|mall|outlet)/i.test(stop.name)) return 'shopping'
  return 'activity'
}

// Compare the supplied AI skeleton, not a baseline already changed by capacity/identity repair.
// Separate retained-place shrink from replacement/removal and purpose changes.
export function compareOriginalActivities(originals: Stop[], finals: Stop[]) {
  let retainedStayLoss = 0
  let removedStops = 0
  let identityChanges = 0
  let purposeChanges = 0
  let identityLostMinutes = 0
  let purposeLostMinutes = 0
  for (const original of originals) {
    const final = finals.find(stop => stop.id === original.id)
    if (!final) {
      removedStops++
      identityLostMinutes += original.duration
      purposeLostMinutes += original.duration
      continue
    }
    if (original.placeId !== final.placeId) {
      identityChanges++
      identityLostMinutes += original.duration
    } else retainedStayLoss += Math.max(0, original.duration - final.duration)
    const originalPurpose = getActivityPurpose(original)
    if (originalPurpose !== getActivityPurpose(final) &&
      !(original.placeId === final.placeId && original.type === final.type && originalPurpose === 'activity')) {
      purposeChanges++
      purposeLostMinutes += original.duration
    }
  }
  return { retainedStayLoss, removedStops, identityChanges, purposeChanges,
    identityLostMinutes, purposeLostMinutes }
}
