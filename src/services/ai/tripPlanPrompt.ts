import type {
  GenerateTripPlansResponse,
} from './types.js'
import type {
  PlanType,
  Stop,
  StopType,
  TransportSegment,
  TransportMode,
  TripInput,
  TripPlan,
} from '../../types/trip.js'

const PLAN_ORDER: PlanType[] = ['safe', 'balanced', 'explore']
const TRIP_RESPONSE_ERROR =
  '這次 AI 產生的行程資料不夠完整，請重新分析一次。'

const categoryLabels: Record<TripInput['category'], string> = {
  date: '約會',
  relax: '放鬆',
  explore: '探索',
  food: '美食',
  outdoor: '戶外走走',
  indoor: '室內活動',
  solo: '一個人',
  other: '其他',
}

const budgetLabels: Record<TripInput['budget'], string> = {
  budget: '小資',
  standard: '一般',
  premium: '輕奢',
  luxury: '豪華',
}

const tagLabels: Record<TripInput['tags'][number], string> = {
  not_too_tired: '不要太累',
  indoor_first: '室內優先',
  hidden_gems: '小眾',
  short_distance: '短距離',
  food_first: '美食優先',
  photo_first: '拍照優先',
  no_full_meals: '不吃正餐',
}

export function buildTripPrompt(input: TripInput) {
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
  const wantsNoFullMeals = input.tags.includes('no_full_meals')
  const category =
    input.category === 'other' && input.customCategory
      ? `其他：${input.customCategory}`
      : categoryLabels[input.category]
  const location = [
    input.location.name ? `地點文字：${input.location.name}` : '',
    typeof input.location.lat === 'number' && typeof input.location.lng === 'number'
      ? `座標：${input.location.lat}, ${input.location.lng}`
      : '',
  ]
    .filter(Boolean)
    .join('；')

  return `
你是台灣在地行程規劃 AI。請依使用者輸入產生 3 個單日行程「骨架」方案，並回傳符合 schema 的 JSON。此階段只產生可比較的核心路線，不要產生景點 description、雨天備案或交通 label。

使用者輸入：
- 行程類型：${category}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 預算：${budgetLabels[input.budget]}
- 人數：${input.people}
- 限制條件：${tags}
- 起點：${location}
- 正餐偏好：${wantsNoFullMeals ? '使用者勾選不吃正餐，不強制安排正式午餐或晚餐。' : '使用者未勾選不吃正餐，請依行程時間判斷是否安排正式午餐或晚餐。'}

硬性規則：
1. 三方案風格：safe 保守、balanced 平衡、explore 探索；主題相同但風格不同。
2. 先決定一種最適合本次行程的 transportMode，三方案必須統一。
3. 每 plan 的 transportSegments 長度 = stops.length - 1；fromStopId / toStopId 必須對應相鄰 stop 的 id。
4. stop.id 僅允許英文、數字、底線、連字號；同一 plan 內不可重複。
5. 文字長度：title 4-8 字、subtitle 8-18 字、summary 30 字內；皆繁體中文；title 不可塞入多個地名。
6. stops 類型至少涵蓋 main_activity、food、ending_or_transition，避免同質化。
7. totalTime 為分鐘、budget 為新台幣元、stop.duration 與 transportSegments.duration 為分鐘。
8. 若人數 ≥ 5，避開座位少、精緻小巧、不適合團體的店家或活動。
9. 早餐規則：除非使用者明確要求早餐，否則不要把早餐作為 stop 名稱、主餐或主要餐飲安排。
10. 午晚餐判定採「任意重疊」：行程與 11:00-13:00 有重疊即涵蓋午餐，與 17:00-19:00 有重疊即涵蓋晚餐。
    - 未勾選「不吃正餐」時，涵蓋哪餐就在 stops 安排該餐的 food stop，且該 stop 實際停留時段需與該餐時段有重疊，不可把午餐排在 9 點等過早時段。只涵蓋一餐就只排一餐。
    - 勾選「不吃正餐」時不排正餐，可改咖啡、甜點、點心或輕食。
11. 時間覆蓋率：實際總分鐘數（所有 stop.duration + 所有交通段 duration）需達：2-4h ≥ 70%、4-8h ≥ 75%、8-12h ≥ 80%、12-24h ≥ 70%。
    - 可用時間 > 6h 時實際結束不得明顯早於指定結束：8-12h 最多提早 90 分、12-24h 最多提早 180 分。
    - stops 限 2-6 個；不要硬塞數量或拉長單一停留；時間長但數量已滿時，優先用較完整的主要活動、慢節奏停留、自然用餐或收尾散步貼近時間。
12. 不要在 summary 要求使用者自行新增停靠站；回傳結果需是可直接比較的完整路線骨架。

JSON 範例（其餘欄位請依 schema）：
{
  "plans": [
    {
      "id": "safe",
      "type": "safe",
      "title": "短標題",
      "subtitle": "主要地點或亮點副標題",
      "summary": "一句 30 字以內的繁體中文摘要",
      "totalTime": 300,
      "budget": 1200,
      "transportMode": "scooter",
      "stops": [
        { "id": "safe-main-1", "name": "地點名稱", "type": "main_activity", "address": "完整地址", "duration": 90 }
      ],
      "transportSegments": [
        { "fromStopId": "safe-main-1", "toStopId": "safe-main-2", "mode": "scooter", "duration": 18 }
      ]
    }
  ]
}
`.trim()
}

export function buildTripDetailsPrompt(input: TripInput, plan: TripPlan) {
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
  const category =
    input.category === 'other' && input.customCategory
      ? `其他：${input.customCategory}`
      : categoryLabels[input.category]

  return `
你是台灣在地行程規劃 AI。請只替下方單一骨架方案補完整細節，回傳符合 schema 的 JSON。

使用者輸入：
- 行程類型：${category}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 預算：${budgetLabels[input.budget]}
- 人數：${input.people}
- 限制條件：${tags}
- 起點：${input.location.name || '未指定'}

骨架方案：
${JSON.stringify(plan)}

硬性規則：
1. 必須保留原本 plan.id、type、title、subtitle、summary、totalTime、budget、transportMode、stops 的 id/name/type/address/duration 與 transportSegments 的 fromStopId/toStopId/mode/duration，不要替換主方案地點。
2. 替每個主方案 stop 補 20-50 字繁體中文 description。
3. transport label 為 4-16 字繁體中文摘要，禁含數字、分鐘、小時、公里。機車 / 汽車描述路線狀態；大眾運輸描述搭乘摘要。mode = public_transit 時請回傳 publicTransitType（bus/metro/train/walk/mixed，混合用 mixed）。
4. 產生 rainBackup 與 rainTransportSegments；rainBackup 不可覆蓋主方案，但需符合相同時間、預算、餐食與人數限制。
5. rainBackup 每個 stop 都要有 20-50 字 description；rainTransportSegments 長度 = rainBackup.length - 1。
6. 回傳格式只能是 { "plan": ... }，不要多餘文字。
`.trim()
}

export function parseTripPlanResponse(text: string): GenerateTripPlansResponse {
  let parsed: unknown

  try {
    parsed = parseJsonObject(text)
  } catch {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  parsed = normalizeTripPlanResponse(parsed)

  if (!isTripPlanResponse(parsed)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  const transportMode = parsed.plans[0]?.transportMode
  const hasUnifiedTransport = parsed.plans.every(
    (plan) => plan.transportMode === transportMode,
  )

  if (!hasUnifiedTransport) {
    throw new Error('這次 AI 產生的交通安排不夠一致，請重新分析一次。')
  }

  const response = {
    plans: [...parsed.plans].sort(
      (left, right) => PLAN_ORDER.indexOf(left.type) - PLAN_ORDER.indexOf(right.type),
    ),
  }

  return response
}

export function parseTripPlanSkeletonResponse(
  text: string,
): GenerateTripPlansResponse {
  let parsed: unknown

  try {
    parsed = parseJsonObject(text)
  } catch {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  parsed = normalizeTripPlanSkeletonResponse(parsed)

  if (!isTripPlanSkeletonResponse(parsed)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  const transportMode = parsed.plans[0]?.transportMode
  const hasUnifiedTransport = parsed.plans.every(
    (plan) => plan.transportMode === transportMode,
  )

  if (!hasUnifiedTransport) {
    throw new Error('這次 AI 產生的交通安排不夠一致，請重新分析一次。')
  }

  return {
    plans: [...parsed.plans].sort(
      (left, right) => PLAN_ORDER.indexOf(left.type) - PLAN_ORDER.indexOf(right.type),
    ),
  }
}

export function parseTripPlanDetailsResponse(
  text: string,
  skeletonPlan: TripPlan,
): TripPlan {
  let parsed: unknown

  try {
    parsed = parseJsonObject(text)
  } catch {
    throw new Error('細節補充失敗，請稍後再試。')
  }

  const rawPlan = isRecord(parsed) && isRecord(parsed.plan) ? parsed.plan : parsed
  const rawPlanRecord = isRecord(rawPlan) ? rawPlan : {}
  const normalizedPlan = normalizeTripPlan({
    ...rawPlanRecord,
    id: skeletonPlan.id,
    type: skeletonPlan.type,
    title:
      typeof rawPlanRecord.title === 'string'
        ? rawPlanRecord.title
        : skeletonPlan.title,
    subtitle:
      typeof rawPlanRecord.subtitle === 'string'
        ? rawPlanRecord.subtitle
        : skeletonPlan.subtitle,
    summary:
      typeof rawPlanRecord.summary === 'string'
        ? rawPlanRecord.summary
        : skeletonPlan.summary,
    totalTime:
      typeof rawPlanRecord.totalTime === 'number'
        ? rawPlanRecord.totalTime
        : skeletonPlan.totalTime,
    budget:
      typeof rawPlanRecord.budget === 'number'
        ? rawPlanRecord.budget
        : skeletonPlan.budget,
    transportMode: skeletonPlan.transportMode,
    stops: mergeDetailedStops(
      skeletonPlan.stops,
      rawPlanRecord.stops,
    ),
    transportSegments: mergeDetailedSegments(
      skeletonPlan.transportSegments,
      rawPlanRecord.transportSegments,
    ),
  })

  if (!isTripPlan(normalizedPlan)) {
    throw new Error('細節補充失敗，請稍後再試。')
  }

  return {
    ...normalizedPlan,
    isDetailComplete: true,
  }
}

function parseJsonObject(text: string) {
  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed)
  } catch {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    const firstBrace = withoutFence.indexOf('{')
    const lastBrace = withoutFence.lastIndexOf('}')

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new Error('No JSON object found')
    }

    return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1))
  }
}

function normalizeTripPlanResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.plans)) {
    return value
  }

  return {
    ...value,
    plans: value.plans.map((plan) => normalizeTripPlan(plan)),
  }
}

function normalizeTripPlanSkeletonResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.plans)) {
    return value
  }

  return {
    ...value,
    plans: value.plans.map((plan) => normalizeTripPlanSkeleton(plan)),
  }
}

function normalizeTripPlanSkeleton(value: unknown) {
  if (!isRecord(value)) {
    return value
  }

  const planType = isPlanType(value.type) ? value.type : 'balanced'
  const transportMode = isTransportMode(value.transportMode)
    ? value.transportMode
    : 'scooter'
  const stops = normalizeStops(value.stops, planType, 'main')

  if (!Array.isArray(stops)) {
    return value
  }

  const normalizedStops = stops.map((stop) =>
    isRecord(stop)
      ? {
          ...stop,
          description: '',
        }
      : stop,
  )

  return {
    ...value,
    type: planType,
    id: typeof value.id === 'string' && value.id.trim() ? value.id : planType,
    transportMode,
    stops: normalizedStops,
    transportSegments: normalizeSkeletonTransportSegments(
      value.transportSegments,
      normalizedStops,
      transportMode,
    ),
    rainBackup: [],
    rainTransportSegments: [],
    isDetailComplete: false,
  }
}

function normalizeTripPlan(value: unknown) {
  if (!isRecord(value)) {
    return value
  }

  const planType = isPlanType(value.type) ? value.type : 'balanced'
  const transportMode = isTransportMode(value.transportMode)
    ? value.transportMode
    : 'scooter'
  const stops = normalizeStops(value.stops, planType, 'main')
  const rainBackup = normalizeStops(value.rainBackup, planType, 'rain')

  return {
    ...value,
    type: planType,
    id: typeof value.id === 'string' && value.id.trim() ? value.id : planType,
    transportMode,
    stops,
    rainBackup,
    transportSegments: normalizeTransportSegments(
      value.transportSegments,
      stops,
      transportMode,
    ),
    rainTransportSegments: normalizeTransportSegments(
      value.rainTransportSegments,
      rainBackup,
      transportMode,
    ),
  }
}

function normalizeStops(
  value: unknown,
  planType: PlanType,
  mode: 'main' | 'rain',
) {
  if (!Array.isArray(value)) {
    return value
  }

  const usedIds = new Set<string>()

  return value.map((stop, index) => {
    if (!isRecord(stop)) {
      return stop
    }

    const fallbackId = `${planType}-${mode}-${index + 1}`
    const rawId = typeof stop.id === 'string' ? stop.id.trim() : ''
    const safeId = /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : fallbackId
    const id = usedIds.has(safeId) ? `${safeId}-${index + 1}` : safeId
    usedIds.add(id)

    return {
      ...stop,
      id,
      type: normalizeStopType(stop.type),
    }
  })
}

function normalizeStopType(value: unknown): StopType {
  if (isStopType(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return 'main_activity'
  }

  const normalized = value.toLowerCase()

  if (
    normalized.includes('food') ||
    normalized.includes('meal') ||
    normalized.includes('restaurant') ||
    normalized.includes('cafe') ||
    normalized.includes('餐') ||
    normalized.includes('咖啡')
  ) {
    return 'food'
  }

  if (
    normalized.includes('ending') ||
    normalized.includes('transition') ||
    normalized.includes('收尾') ||
    normalized.includes('轉場')
  ) {
    return 'ending_or_transition'
  }

  return 'main_activity'
}

function normalizeTransportSegments(
  value: unknown,
  stops: unknown,
  fallbackMode: TransportMode,
) {
  if (!Array.isArray(stops) || !stops.every(isStop)) {
    return value
  }

  const expectedLength = Math.max(stops.length - 1, 0)
  const segments = Array.isArray(value) ? value : []

  return Array.from({ length: expectedLength }, (_, index) => {
    const segment = segments[index]

    if (!isRecord(segment)) {
      return buildFallbackTransportSegment(stops, index, fallbackMode)
    }

    const mode = isTransportMode(segment.mode) ? segment.mode : fallbackMode
    const publicTransitType = isPublicTransitType(segment.publicTransitType)
      ? segment.publicTransitType
      : undefined

    return {
      ...segment,
      fromStopId: stops[index].id,
      toStopId: stops[index + 1].id,
      mode,
      publicTransitType,
      duration:
        typeof segment.duration === 'number' && segment.duration >= 0
          ? segment.duration
          : 20,
      label:
        typeof segment.label === 'string' && segment.label.trim()
          ? cleanTransportSummary(segment.label, mode, publicTransitType)
          : buildTransportFallbackLabel(mode, publicTransitType),
    }
  })
}

function normalizeSkeletonTransportSegments(
  value: unknown,
  stops: unknown,
  fallbackMode: TransportMode,
) {
  if (!Array.isArray(stops) || !stops.every(isStop)) {
    return value
  }

  const expectedLength = Math.max(stops.length - 1, 0)
  const segments = Array.isArray(value) ? value : []

  return Array.from({ length: expectedLength }, (_, index) => {
    const segment = segments[index]

    if (!isRecord(segment)) {
      return {
        ...buildFallbackTransportSegment(stops, index, fallbackMode),
        label: '',
      }
    }

    const mode = isTransportMode(segment.mode) ? segment.mode : fallbackMode

    return {
      fromStopId: stops[index].id,
      toStopId: stops[index + 1].id,
      mode,
      duration:
        typeof segment.duration === 'number' && segment.duration >= 0
          ? segment.duration
          : 20,
      label: '',
    }
  })
}

function mergeDetailedStops(skeletonStops: Stop[], rawStops: unknown) {
  if (!Array.isArray(rawStops)) {
    return skeletonStops
  }

  return skeletonStops.map((skeletonStop, index) => {
    const rawStop = rawStops.find(
      (stop) => isRecord(stop) && stop.id === skeletonStop.id,
    ) ?? rawStops[index]

    if (!isRecord(rawStop)) {
      return skeletonStop
    }

    return {
      ...skeletonStop,
      description:
        typeof rawStop.description === 'string'
          ? rawStop.description
          : skeletonStop.description,
    }
  })
}

function mergeDetailedSegments(
  skeletonSegments: TransportSegment[],
  rawSegments: unknown,
) {
  if (!Array.isArray(rawSegments)) {
    return skeletonSegments
  }

  return skeletonSegments.map((skeletonSegment, index) => {
    const rawSegment = rawSegments.find(
      (segment) =>
        isRecord(segment) &&
        segment.fromStopId === skeletonSegment.fromStopId &&
        segment.toStopId === skeletonSegment.toStopId,
    ) ?? rawSegments[index]

    if (!isRecord(rawSegment)) {
      return skeletonSegment
    }

    return {
      ...skeletonSegment,
      publicTransitType: isPublicTransitType(rawSegment.publicTransitType)
        ? rawSegment.publicTransitType
        : skeletonSegment.publicTransitType,
      label:
        typeof rawSegment.label === 'string'
          ? rawSegment.label
          : skeletonSegment.label,
    }
  })
}

function buildFallbackTransportSegment(
  stops: Stop[],
  index: number,
  mode: TransportMode,
): TransportSegment {
  return {
    fromStopId: stops[index].id,
    toStopId: stops[index + 1].id,
    mode,
    duration: 20,
    label: buildTransportFallbackLabel(mode),
  }
}

function buildTransportFallbackLabel(
  mode: TransportMode,
  publicTransitType?: TransportSegment['publicTransitType'],
) {
  if (mode === 'public_transit' && publicTransitType) {
    return '大眾運輸前往'
  }

  if (mode === 'public_transit') {
    return '大眾運輸前往'
  }

  if (mode === 'car') {
    return '開車順路前往'
  }

  return '騎車順路前往'
}

function cleanTransportSummary(
  value: string,
  mode: TransportMode,
  publicTransitType?: TransportSegment['publicTransitType'],
) {
  const cleaned = value
    .replace(/[0-9０-９]+\s*(?:小時|分鐘|分|公里|km|KM)/g, '')
    .replace(/約\s*(?:小時|分鐘|分|公里)?/g, '')
    .replace(/\s+/g, '')
    .replace(/[，,、。．.]+$/g, '')
    .trim()

  return cleaned || buildTransportFallbackLabel(mode, publicTransitType)
}

function isTripPlanResponse(value: unknown): value is GenerateTripPlansResponse {
  if (!isRecord(value) || !Array.isArray(value.plans) || value.plans.length !== 3) {
    return false
  }

  const types = value.plans.map((plan) => (isRecord(plan) ? plan.type : ''))

  return (
    PLAN_ORDER.every((type) => types.includes(type)) &&
    value.plans.every(isTripPlan)
  )
}

function isTripPlanSkeletonResponse(
  value: unknown,
): value is GenerateTripPlansResponse {
  if (!isRecord(value) || !Array.isArray(value.plans) || value.plans.length !== 3) {
    return false
  }

  const types = value.plans.map((plan) => (isRecord(plan) ? plan.type : ''))

  return (
    PLAN_ORDER.every((type) => types.includes(type)) &&
    value.plans.every(isTripPlanSkeleton)
  )
}

function isTripPlanSkeleton(value: unknown): value is TripPlan {
  if (!isRecord(value)) {
    return false
  }

  const stops = value.stops

  if (
    !Array.isArray(stops) ||
    stops.length < 2 ||
    stops.length > 6 ||
    !stops.every(isStop) ||
    !hasUniqueStopIds(stops)
  ) {
    return false
  }

  return (
    isPlanType(value.type) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.subtitle === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.totalTime === 'number' &&
    typeof value.budget === 'number' &&
    isTransportMode(value.transportMode) &&
    Array.isArray(value.transportSegments) &&
    value.transportSegments.length === stops.length - 1 &&
    value.transportSegments.every((segment, index) =>
      isTransportSegment(segment, stops, index),
    ) &&
    Array.isArray(value.rainBackup) &&
    value.rainBackup.length === 0 &&
    Array.isArray(value.rainTransportSegments) &&
    value.rainTransportSegments.length === 0
  )
}

function isTripPlan(value: unknown): value is TripPlan {
  if (!isRecord(value)) {
    return false
  }

  const stops = value.stops
  const rainBackup = value.rainBackup

  if (
    !Array.isArray(stops) ||
    stops.length < 2 ||
    stops.length > 6 ||
    !stops.every(isStop) ||
    !hasUniqueStopIds(stops)
  ) {
    return false
  }

  if (
    !Array.isArray(rainBackup) ||
    rainBackup.length < 2 ||
    rainBackup.length > 6 ||
    !rainBackup.every(isStop) ||
    !hasUniqueStopIds(rainBackup)
  ) {
    return false
  }

  return (
    isPlanType(value.type) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.subtitle === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.totalTime === 'number' &&
    typeof value.budget === 'number' &&
    isTransportMode(value.transportMode) &&
    Array.isArray(value.transportSegments) &&
    value.transportSegments.length === stops.length - 1 &&
    value.transportSegments.every((segment, index) =>
      isTransportSegment(segment, stops, index),
    ) &&
    Array.isArray(value.rainTransportSegments) &&
    value.rainTransportSegments.length === rainBackup.length - 1 &&
    value.rainTransportSegments.every((segment, index) =>
      isTransportSegment(segment, rainBackup, index),
    )
  )
}

function isStop(value: unknown): value is Stop {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value.id) &&
    typeof value.name === 'string' &&
    isStopType(value.type) &&
    typeof value.description === 'string' &&
    typeof value.address === 'string' &&
    typeof value.duration === 'number' &&
    (typeof value.transport === 'undefined' ||
      typeof value.transport === 'string') &&
    (typeof value.googleMapsUrl === 'undefined' ||
      typeof value.googleMapsUrl === 'string')
  )
}

function isTransportSegment(
  value: unknown,
  stops: Stop[],
  expectedFromStopIndex: number,
): value is TransportSegment {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.fromStopId === stops[expectedFromStopIndex]?.id &&
    value.toStopId === stops[expectedFromStopIndex + 1]?.id &&
    isTransportMode(value.mode) &&
    (typeof value.publicTransitType === 'undefined' ||
      isPublicTransitType(value.publicTransitType)) &&
    typeof value.duration === 'number' &&
    value.duration >= 0 &&
    typeof value.label === 'string' &&
    !hasTransportTimeText(value.label)
  )
}

function hasUniqueStopIds(stops: Stop[]) {
  return new Set(stops.map((stop) => stop.id)).size === stops.length
}

function hasTransportTimeText(value: string) {
  return /[0-9０-９]|分鐘|小時|公里|km|KM/.test(value)
}

function isPlanType(value: unknown): value is PlanType {
  return value === 'safe' || value === 'balanced' || value === 'explore'
}

function isTransportMode(value: unknown): value is TransportMode {
  return value === 'scooter' || value === 'car' || value === 'public_transit'
}

function isPublicTransitType(value: unknown) {
  return (
    value === 'bus' ||
    value === 'metro' ||
    value === 'train' ||
    value === 'walk' ||
    value === 'mixed'
  )
}

function isStopType(value: unknown): value is StopType {
  return (
    value === 'main_activity' ||
    value === 'food' ||
    value === 'ending_or_transition'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
