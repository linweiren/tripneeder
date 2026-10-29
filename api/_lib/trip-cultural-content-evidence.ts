// Reviewed content facts, separate from Google venue taxonomy and model prose.
// These support a self-guided visit, never today's programme, admission, opening
// hours, accessibility or a justified visit length. Join on identity, not names.
type PlaceIdentity = { placeId?: string; lat?: number; lng?: number }
export type CulturalContentEvidence = {
  readonly placeId: string
  readonly lat: number
  readonly lng: number
  readonly content: string
  readonly sourceUrl: string
  readonly checkedAt: string
}
const reviewedContent: readonly CulturalContentEvidence[] = [
  { placeId: 'ChIJKTktNo4EbjQRoRKMt38KIUY', lat: 22.6313652, lng: 120.3019167,
    content: '玻璃公共藝術觀賞',
    sourceUrl: 'https://www.krtc.com.tw/Information/travel_more?id=1e596b7e1c214f06b5ff6a44cd5abbba', checkedAt: '2026-10-26' },
  { placeId: 'ChIJ6RxSfH0EbjQRFGeK2utk8Q4', lat: 22.6230382, lng: 120.3000036,
    content: '裝置藝術及藝文走道觀賞',
    sourceUrl: 'https://khh.travel/zh-tw/attractions/detail/271/', checkedAt: '2026-10-26' },
  { placeId: 'ChIJTc5MKfEDbjQRQ7UUWqpeQhA', lat: 22.6175839, lng: 120.2664633,
    content: '砲台、城牆與古蹟建築外觀尋訪',
    sourceUrl: 'https://khh.travel/zh-tw/attractions/detail/1145/', checkedAt: '2026-10-26' },
]
export function getCulturalContentEvidence(place: PlaceIdentity): CulturalContentEvidence | undefined {
  if (!place.placeId || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return undefined
  return reviewedContent.find(item => item.placeId === place.placeId &&
    Math.abs(item.lat - place.lat!) < .001 && Math.abs(item.lng - place.lng!) < .001)
}
