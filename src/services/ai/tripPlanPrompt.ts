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
每個 plan 必須包含 transportSegments 與 rainTransportSegments。
transportSegments 是 stops 之間的交通段，長度必須是 stops.length - 1。
rainTransportSegments 是 rainBackup 之間的交通段，長度必須是 rainBackup.length - 1。
每個 stops 與 rainBackup 的 stop 都必須包含穩定 id 欄位。id 必須是英文、數字、底線或連字號組成，同一個 plan 內不可重複。
每個交通段必須包含 fromStopId、toStopId、mode、duration、label。
fromStopId 與 toStopId 必須對應相鄰 stop 的 id，例如第 1 段 fromStopId 必須等於第 1 個 stop.id，toStopId 必須等於第 2 個 stop.id。
duration 單位為分鐘，mode 只能是 "scooter"、"car"、"public_transit"。
label 必須是 4-16 個繁體中文字的交通狀態摘要，不可包含數字、分鐘、小時、公里或任何交通時間。機車 / 汽車可描述路線狀態，例如「騎車沿海行駛」、「開車走主要幹道」；大眾運輸可描述搭乘摘要，例如「美麗島站到西子灣站」、「公車直達商圈」、「捷運轉步行抵達」。
當 mode 是 "public_transit" 時，請盡量回傳 publicTransitType，值只能是 "bus"、"metro"、"train"、"walk"、"mixed"。若同段包含多種大眾運輸，請用 "mixed"。

每個 stops 與 rainBackup 的 stop 都必須包含 description 欄位，請用 20-50 字繁體中文介紹景點特色與適合停留的理由。

你是台灣在地行程規劃 AI。請根據使用者輸入，產生 3 個單日行程方案。

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
1. 只允許回傳 JSON，不可回傳 markdown、說明文字、code block。
2. 必須回傳剛好 3 個 plans，順序固定為 safe、balanced、explore。
3. 三個方案主題相同，但風格不同：safe 保守型、balanced 平衡型、explore 探索型。
4. 先判斷一種最適合本次行程的預設交通方式，三個方案都必須使用同一種 transportMode。
5. transportMode 只能是 "scooter"、"car"、"public_transit"。
6. 交通資訊必須放在 transportSegments / rainTransportSegments，不要依賴 stop 內的 transport 字串。
7. 若人數大於或等於 5，避開精緻小巧、座位有限、不適合團體的店家或活動。
8. 每個方案都要有主方案 stops 與 rainBackup，rainBackup 不可覆蓋主方案。
9. Google Maps 只提供外部搜尋連結，不可假裝使用 Google Maps API。
10. totalTime 單位為分鐘，budget 單位為新台幣元。
11. stop duration 單位為分鐘。
12. stop 類型至少要包含 main_activity、food、ending_or_transition，避免行程同質性過高。
13. stop 數量依時間長度與條件推估，最後限制在 2 到 6 個。
14. title 必須為 4-8 個繁體中文字，不可超過 8 字，不可塞入多個地名。
15. subtitle 必須為 8-18 個繁體中文字，可包含主要地點或亮點。
16. 卡片標題需適合手機顯示，不可產生過長標題。
17. 本專案只依午餐與晚餐時段決定正式正餐，不要因為行程開始在早上就安排早餐；除非使用者明確要求早餐，否則不要把早餐作為 stop 名稱、主餐內容或主要餐飲安排。
18. 午餐判斷採任意重疊規則：午餐時段是 11:00-13:00，行程不需要完整涵蓋這段時間；只要行程與 11:00-13:00 有任何重疊，就視為涵蓋午餐時段，例如 07:00-12:00、10:00-11:00、12:30-16:00 都算涵蓋午餐。
19. 晚餐判斷採任意重疊規則：晚餐時段是 17:00-19:00，行程不需要完整涵蓋這段時間；只要行程與 17:00-19:00 有任何重疊，就視為涵蓋晚餐時段，例如 14:00-17:30、17:00-21:00、18:30-22:00 都算涵蓋晚餐。
20. 若使用者未勾選「不吃正餐」，且行程涵蓋午餐時段，stops 與 rainBackup 都需各自安排午餐停留點，並讓 stop 名稱、type 或 description 自然呈現午餐內容。
21. 若使用者未勾選「不吃正餐」，且行程涵蓋晚餐時段，stops 與 rainBackup 都需各自安排晚餐停留點，並讓 stop 名稱、type 或 description 自然呈現晚餐內容。
22. 若行程只涵蓋午餐時段、沒有涵蓋晚餐時段，正式正餐只需安排午餐，不要額外安排早餐或晚餐。
23. 若行程只涵蓋晚餐時段、沒有涵蓋午餐時段，正式正餐只需安排晚餐，不要額外安排早餐或午餐。
24. 若行程同時涵蓋午餐與晚餐時段，才需要同時安排午餐與晚餐。
25. 若使用者勾選「不吃正餐」，不要強制安排正式午餐或晚餐；可視行程節奏安排咖啡、甜點、點心或輕食。
26. 實際行程長度必須盡量貼近使用者指定的開始與結束時間。請用 stop duration 加上交通段 duration 填滿行程，不要只安排時間範圍中的前半段。
27. stops 與 rainBackup 的實際總分鐘數需依行程長度達到合理覆蓋率。實際總分鐘數 = 所有 stop.duration 加總 + 所有交通段 duration 加總。
28. 時間覆蓋率目標：2-4 小時至少 70%；4-8 小時至少 75%；8-12 小時至少 80%；12-24 小時至少 70%。
29. 若使用者可用時間超過 6 小時，stops 與 rainBackup 的實際結束時間不可明顯早於使用者指定結束時間。8-12 小時行程最多提早 90 分鐘；12-24 小時行程最多提早 180 分鐘。
30. 不要為了填滿時間而無限制增加 stop 數量，也不要把單一景點停留時間拉得不自然；請依景點性質自行分配合理停留時間。
31. 若需安排午餐，午餐 food stop 的實際停留時段必須與 11:00-13:00 有重疊，不可把午餐排在上午 9 點或過早時段。
32. 若需安排晚餐，晚餐 food stop 的實際停留時段必須與 17:00-19:00 有重疊。
33. 若時間較長但 stop 數量已達合理上限，請優先用較完整的主要活動、慢節奏停留、自然用餐、收尾散步或休息點來貼近時間，不要把行程壓縮成過短路線。
34. 不要在 summary 或 description 裡要求使用者自行新增停靠站；本產品主打快速決策，回傳結果需是可直接執行的完整建議。

請嚴格回傳以下 JSON shape：
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
        {
          "id": "safe-main-1",
          "name": "地點名稱",
          "type": "main_activity",
          "description": "20-50 字繁中景點簡介，說明特色與停留理由",
          "address": "完整地址或可搜尋地址",
          "duration": 90,
          "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=..."
        }
      ],
      "transportSegments": [
        {
          "fromStopId": "safe-main-1",
          "toStopId": "safe-main-2",
          "mode": "scooter",
          "duration": 18,
          "label": "騎車沿海行駛"
        }
      ],
      "rainBackup": [
        {
          "id": "safe-rain-1",
          "name": "雨天備案地點",
          "type": "main_activity",
          "description": "20-50 字繁中景點簡介，說明特色與停留理由",
          "address": "完整地址或可搜尋地址",
          "duration": 90,
          "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=..."
        }
      ],
      "rainTransportSegments": [
        {
          "fromStopId": "safe-rain-1",
          "toStopId": "safe-rain-2",
          "mode": "scooter",
          "duration": 12,
          "label": "騎車走主要幹道"
        }
      ]
    }
  ]
}
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
