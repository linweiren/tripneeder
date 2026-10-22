import { capturedCultureProjectionPool } from './culture-evidence-projection.mjs'
import { fixture } from './supplement-quality.mjs'
import { durationQualityFixture } from './stop-duration-quality.mjs'

// Public identity/coordinates from run db8ff9ce final-response; types/roles/scores
// from its existing 38-candidate capture. No real opening windows were saved in
// that fixture: use the tracked all-day clock mock, never assert real-world hours.
const locations = [
  ['高雄中央公園', '801高雄市前金區榮治里中山一路11號', 22.6249002, 120.30089840000001],
  ['草圖自家烘焙咖啡館 Sketch cafe & Roastery.', '801高雄市前金區青山里中正四路111號', 22.6296751, 120.2972473],
  ['城市光廊', '801高雄市前金區長生里中華三路6號', 22.6230382, 120.3000036],
  ['光之穹頂', '800高雄市新興區明莊里中山一路115號B1', 22.631365199999998, 120.3019167],
  ['駁二塔', '803高雄市鹽埕區新化里新化街63-1號', 22.61873, 120.28308390000001],
  ['愛河灣', '802高雄市苓雅區', 22.6182376, 120.2904677],
  ['Delicatesse 洲際烘焙坊', '806高雄市前鎮區意誠里新光路33號1F', 22.6112046, 120.3035582],
  ['晴。晨甜點咖啡', '801高雄市前金區長城里瑞源路181號', 22.634695, 120.296064],
]

export function capturedDurationRepairFixture(style) {
  const f = fixture('legal-gap'), captured = capturedCultureProjectionPool().allCandidates
  const known = new Map(locations.map(([name, address, lat, lng]) => {
    const c = captured.find(c => c.name === name)
    if (!c) throw Error(`Missing captured candidate: ${name}`)
    return [name, { ...c, address, lat, lng, googleTypes: [...c.types], candidateRole: c.role,
      type: c.role === 'food' ? 'food' : 'main_activity', description: '', openingHours: f.plan.stops[0].openingHours }]
  }))
  // Saved post-meal/pre-coverage order and known adjacent route minutes. Balanced
  // is diagnostics stages 68 -> 69: 90/60/60 + 6 travel, NOT a raw full AI replay.
  const rows = style === 'safe'
    ? [['高雄中央公園', 120, 'stop1'], ['草圖自家烘焙咖啡館 Sketch cafe & Roastery.', 60, 'stop2'], ['城市光廊', 60, 'stop3']]
    : style === 'balanced'
      ? [['光之穹頂', 90, 'stop2'], ['草圖自家烘焙咖啡館 Sketch cafe & Roastery.', 60, 'stop1'], ['城市光廊', 60, 'stop3']]
      : [['駁二塔', 90, 'stop2'], ['愛河灣', 60, 'stop3'], ['Delicatesse 洲際烘焙坊', 60, 'stop1'], ['晴。晨甜點咖啡', 45, 'stop4']]
  const minutes = style === 'safe' ? [4, 4] : style === 'balanced' ? [2, 4] : [5, 9, 12]
  const stops = rows.map(([name, duration, id]) => ({ ...structuredClone(known.get(name)), duration, id }))
  f.input = { category: 'other', customCategory: '文化景點＋咖啡廳', startTime: '10:00', endTime: '15:00',
    tags: [], people: 2, transportMode: 'scooter', location: { name: '高雄中央公園', lat: 22.6249002, lng: 120.30089840000001 } }
  f.candidates = { allCandidates: stops, firstStopCandidates: stops, otherCandidates: stops }
  f.routes = Object.fromEntries(stops.slice(1).map((s, i) => [`${stops[i].placeId}>${s.placeId}`, minutes[i]]))
  f.placeOverrides = Object.fromEntries(stops.map(s => [s.placeId, { displayName: { text: s.name },
    formattedAddress: s.address, types: s.types, location: { latitude: s.lat, longitude: s.lng } }]))
  f.plan = { ...f.plan, id: style, type: style, scheduleStartTime: '10:00', stops: structuredClone(stops),
    transportSegments: stops.slice(1).map((s, i) => ({ fromStopId: stops[i].id, toStopId: s.id,
      mode: 'scooter', duration: minutes[i], label: 'saved route minutes under mock' })) }
  f.plan.totalTime = stops.reduce((n, s) => n + s.duration, 0) + minutes.reduce((a, b) => a + b, 0)
  return f
}

export function bookedDurationFixture() {
  const f = durationQualityFixture('booked-long', 'safe')
  f.input = { ...f.input, startTime: '09:30', endTime: '14:30',
    customCategory: '文化景點＋咖啡廳；第一站已預訂180分鐘活動（合成測試前提）' }
  f.plan.scheduleStartTime = '09:30'
  f.plan.stops = [f.plan.stops[0], f.plan.stops[1], f.plan.stops[3]]
  f.plan.stops.forEach((s, i) => { s.duration = [180, 45, 45][i] })
  f.candidates.allCandidates = f.candidates.allCandidates.filter(c => f.plan.stops.some(s => s.placeId === c.placeId))
  f.candidates.firstStopCandidates = f.candidates.otherCandidates = f.candidates.allCandidates
  f.plan.transportSegments = f.plan.stops.slice(1).map((s, i) => ({ fromStopId: f.plan.stops[i].id,
    toStopId: s.id, mode: 'scooter', duration: 4, label: 'fixture' }))
  f.plan.totalTime = 278
  return f
}
