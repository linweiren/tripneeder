import type {
  GenerateTripPlansResponse,
  Persona,
} from './types.js'
import type {
  BudgetLevel,
  PlanType,
  TransportMode,
  TripCategory,
  TripInput,
  TripPlan,
} from '../../types/trip.js'
const PLAN_ORDER: PlanType[] = ['safe', 'balanced', 'explore']
const TRIP_RESPONSE_ERROR =
  '這次 AI 產生的行程資料不夠完整，請重新分析一次。'

const categoryLabels: Record<TripCategory, string> = {
  date: '約會',
  relax: '放鬆',
  explore: '探索',
  food: '美食',
  outdoor: '戶外走走',
  indoor: '室內活動',
  solo: '一個人',
  other: '其他',
}

const budgetLabels: Record<BudgetLevel, string> = {
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

const transportModeLabels: Record<TransportMode, string> = {
  scooter: '機車',
  car: '汽車',
  public_transit: '大眾運輸',
}

export function buildTripPrompt(input: TripInput, persona?: Persona, nearbyPlaces?: string, locationWarning?: string) {
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
  const wantsNoFullMeals = input.tags.includes('no_full_meals')
  const allowedMinutes = getAllowedTripMinutes(input)
  const minimumActualMinutes = allowedMinutes
    ? Math.ceil(allowedMinutes * getRequiredCoverageRatio())
    : null
  
  // Use persona values if input values are missing
  const displayCategory =
    input.category === 'other' && input.customCategory
      ? `其他：${input.customCategory}`
      : input.category
        ? categoryLabels[input.category]
        : (persona?.companion || '放鬆')
  
  const displayBudget = input.budget 
    ? budgetLabels[input.budget] 
    : (persona?.budget || '一般')

  const displayPeople = input.people ?? persona?.people ?? 2
  const preferredTransportMode = input.transportMode || persona?.transportMode
  const displayTransportMode = preferredTransportMode
    ? transportModeLabels[preferredTransportMode]
    : '未指定，請依地點與行程節奏判斷'

  const location = [
    input.location.name ? `地點文字：${input.location.name}` : '',
    typeof input.location.lat === 'number' && typeof input.location.lng === 'number'
      ? `座標：${input.location.lat}, ${input.location.lng}`
      : '',
  ]
    .filter(Boolean)
    .join('；')

  const personaContext = persona
    ? `
- 使用者人設背景：
  - 同行對象：${persona.companion || '未指定'}
  - 預算偏好：${persona.budget || '未指定'}
  - 體力狀況：${persona.stamina || '未指定'}
  - 經常出遊人數：${persona.people ?? 2}
  - 常用交通工具：${persona.transportMode ? transportModeLabels[persona.transportMode] : '未指定'}
  - 飲食禁忌：${persona.diet || '無'}
`.trim()
    : ''

  const nearbyPlacesContext = nearbyPlaces
    ? `
- 起點附近的真實地點參考（來自 Google Maps 即時搜尋）：
${nearbyPlaces}

重要指示：
1. 所有 stops（包含 safe、balanced、explore 三方案）只能從上方 Google Maps 候選清單挑選，不可自創、改寫 or 使用清單外地點。
2. stop.name 必須逐字複製候選清單的 name；stop.address 必須逐字複製同一筆候選的 address；若候選資料含 placeId，請原樣填入 stop.placeId。
3. 第一站（即每個 plan 的 stops[0]）必須從 FIRST_STOP_CANDIDATES_WITHIN_2KM 區塊挑選；若該區塊存在，禁止使用其他區塊作為第一站。
4. 不可使用「特色小吃」「親民餐廳」「附近餐廳」「咖啡廳」「景點」這類空泛名稱。
5. 若候選清單沒有適合的地點，也不要補入清單外地點；請改用清單內較接近需求的地點組合。
`.trim()
    : `
- 警告：目前無法取得起點附近的即時地點清單。
- 指示：請完全依據您的內部知識庫，為該起點規劃合理的真實地點行程。請確保地點名稱與地址正確。
`.trim()

  return `你是台灣在地行程規劃 AI。請依使用者輸入產生 3 個單日行程「骨架」方案，並回傳符合 schema 的 JSON。此階段只產生可比較的核心路線，不要產生景點 description、雨天備案或交通 label。

使用者輸入：
- 行程類型：${displayCategory}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 可用行程時間：${allowedMinutes ?? '未知'} 分鐘
- 最低實際行程長度：${minimumActualMinutes ?? '未知'} 分鐘（所有 stop.duration + transportSegments.duration 加總）
- 預算：${displayBudget}
- 人數：${displayPeople}
- 交通工具偏好：${displayTransportMode}
- 限制條件：${tags}
- 起點：${location}
${locationWarning ? `- ${locationWarning}` : ''}
- 正餐偏好：${wantsNoFullMeals ? '使用者勾選不吃正餐，不強制安排正式午餐或晚餐。' : '使用者未勾選不吃正餐，請依行程時間判斷是否安排正式午餐或晚餐。'}
${personaContext}
${nearbyPlacesContext}

硬性規則：
1. 三方案風格：safe 保守、balanced 平衡、explore 探索；主題相同但風格不同。
2. transportMode：若使用者有指定交通工具偏好，三方案必須使用該 transportMode；若未指定，先決定一種最適合本次行程的 transportMode，三方案必須統一。
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
11. 時間覆蓋率：實際總分鐘數（所有 stop.duration + 所有交通段 duration）必須 >= 上方「最低實際行程長度」；totalTime 也必須等於這個實際總分鐘數。
    - 可用時間 > 6h 時實際結束不得明顯早於指定結束：8-12h 最多提早 90 分、12-24h 最多提早 180 分。
    - stops 不設硬性上限；時間越長可安排越多站，避免把單一 stop.duration 拉到不合理長度。
12. 不要在 summary 要求使用者自行新增停靠站；回傳結果需是可直接比較的完整路線骨架。
13. 第一站距離起點必須 ≤ 2 km (若有經緯度座標時為硬性規則)。
14. 交通效率建議 (軟性規則)：相鄰站點間交通時間建議 ≤ 30 分鐘；整日累積交通時間建議 ≤ 總行程時長的 25%。
15. 規劃核心：必須以使用者提供的「起點」為地理中心點往外擴張，優先選擇附近的景點，避免跨區過遠。
16. 禁止重複：在同一個方案（plan）中，禁止重複安排同一個地點。每個 stop 的名稱與地址必須是唯一的，不可讓使用者在不同時間點回到同一個地方。

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

export function buildTripDetailsPrompt(input: TripInput, plan: TripPlan, persona?: Persona, nearbyIndoorPlaces?: string, locationWarning?: string) {
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
  
  const displayCategory =
    input.category === 'other' && input.customCategory
      ? `其他：${input.customCategory}`
      : input.category
        ? categoryLabels[input.category]
        : (persona?.companion || '放鬆')
  
  const displayBudget = input.budget 
    ? budgetLabels[input.budget] 
    : (persona?.budget || '一般')

  const displayPeople = input.people ?? persona?.people ?? 2
  const preferredTransportMode = input.transportMode || persona?.transportMode
  const displayTransportMode = preferredTransportMode
    ? transportModeLabels[preferredTransportMode]
    : '未指定'

  const personaContext = persona
    ? `
- 使用者人設背景：
  - 同行對象：${persona.companion || '未指定'}
  - 預算偏好：${persona.budget || '未指定'}
  - 體力狀況：${persona.stamina || '未指定'}
  - 經常出遊人數：${persona.people ?? 2}
  - 常用交通工具：${persona.transportMode ? transportModeLabels[persona.transportMode] : '未指定'}
  - 飲食禁忌：${persona.diet || '無'}
`.trim()
    : ''
const nearbyPlacesContext = nearbyIndoorPlaces
  ? `
- 附近的真實「室內/有遮蔽」地點參考（來自 Google Maps）：
${nearbyIndoorPlaces}

雨天備案硬性規則：
1. rainBackup 的所有景點必須從上方「真實室內地點參考」清單挑選，禁止自創、改寫或使用清單外地點。
2. stop.name 必須逐字複製候選清單的 name；stop.address 必須逐字複製 address；若有 placeId 請原樣填入。
`.trim()
  : `
- 警告：目前無法取得起點附近的即時室內地點清單。
- 指示：請完全依據您的內部知識庫，為該起點規劃合理的真實室內景點作為雨天備案。
`.trim()

  return `你是台灣在地行程規劃 AI。請只替下方單一骨架方案補完整細節，回傳符合 schema 的 JSON。

使用者輸入：
- 行程類型：${displayCategory}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 預算：${displayBudget}
- 人數：${displayPeople}
- 交通工具偏好：${displayTransportMode}
- 限制條件：${tags}
- 起點：${input.location.name || '未指定'}
${locationWarning ? `- ${locationWarning}` : ''}
${personaContext}
${nearbyPlacesContext}

骨架方案（JSON）：
${JSON.stringify(plan, null, 2)}

補充規則：
1. 必須保留原本 plan.id、type、title、subtitle、summary、totalTime、budget、transportMode、stops 的 id/name/type/address/duration 與 transportSegments 的 fromStopId/toStopId/mode/duration，不要替換主方案地點。
2. 替每個主方案 stop 補 20-50 字繁體中文 description。
3. transport label 為 4-16 字繁體中文摘要，禁含數字、分鐘、小時、公里。機車 / 汽車描述路線狀態；大眾運輸描述搭乘摘要。mode = public_transit 時請回傳 publicTransitType（bus/metro/train/walk/mixed，混合用 mixed）。
4. 產生 rainBackup 與 rainTransportSegments；rainBackup 不可覆蓋主方案，但需符合相同時間、預算、餐食與人數限制。
5. 雨天備案硬性規則：
   - 景點必須是「室內」或「有遮蔽」的地點。
   - 儘量讓主方案與雨天備案的對應站點（如第一個景點對第一個備案）地理距離相近。
6. rainBackup 每個 stop 都要有 20-50 字 description；rainTransportSegments 長度 = rainBackup.length - 1。
7. 不要翻譯、羅馬拼音或改寫任何既有主方案 stop.name / stop.address；若原本是中文就必須維持中文。
8. 回傳格式只能是 { "plan": ... }，不要多餘文字。
`.trim()
}

export function buildRetryTripSkeletonPrompt(
  input: TripInput,
  invalidPlanIds: string[],
  persona?: Persona,
  nearbyPlaces?: string,
  validationSummaries: string[] = [],
) {
  const originalPrompt = buildTripPrompt(input, persona, nearbyPlaces)
  const validationContext = validationSummaries.length > 0
    ? `\n未通過原因：\n${validationSummaries.map((summary) => `- ${summary}`).join('\n')}`
    : ''

  return `
${originalPrompt}

重要：你之前產生的以下方案 ID 未通過 server 端品質檢查，請重新規劃這幾個方案。其餘方案仍需照 schema 回傳，但可維持原風格。
請務必修正所有列出的問題：地點必須來自候選清單、能通過 Google Places 驗證、第一站 ≤ 2 km，且實際總分鐘數必須達到指定時間範圍的覆蓋率。

需重產的方案 ID：${invalidPlanIds.join(', ')}
${validationContext}
`.trim()
}

export function parseTripPlanResponse(text: string): GenerateTripPlansResponse {
  const parsed = parseJsonObject(text)
  const response = normalizeTripPlanResponse(parsed)

  if (!isTripPlanResponse(response)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  // 排序計畫
  response.plans.sort((a, b) => PLAN_ORDER.indexOf(a.type) - PLAN_ORDER.indexOf(b.type))

  return response
}

export function parseTripPlanSkeletonResponse(text: string): GenerateTripPlansResponse {
  const parsed = parseJsonObject(text)
  
  // 骨架版 parser 邏輯
  if (!parsed || typeof parsed !== 'object' || !('plans' in parsed) || !Array.isArray(parsed.plans)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  return parsed as GenerateTripPlansResponse
}

export function parseTripPlanDetailsResponse(text: string, skeletonPlan: TripPlan): TripPlan {
  const parsed = parseJsonObject(text) as { plan: TripPlan }
  
  if (!parsed || !parsed.plan) {
    throw new Error('詳情補充回傳格式不正確。')
  }

  const detailedPlan = parsed.plan
  
  // 將骨架版的基礎資訊合併回來（以防 AI 弄亂）
  return {
    ...skeletonPlan,
    ...detailedPlan,
    stops: mergeDetailedStops(skeletonPlan.stops, detailedPlan.stops),
    rainBackup: detailedPlan.rainBackup || [],
    transportMode: skeletonPlan.transportMode,
    transportSegments: mergeDetailedTransportSegments(
      skeletonPlan.transportSegments,
      detailedPlan.transportSegments,
    ),
    rainTransportSegments: detailedPlan.rainTransportSegments || [],
    isDetailComplete: true,
  }
}

function mergeDetailedStops(skeletonStops: TripPlan['stops'], detailedStops?: TripPlan['stops']) {
  return skeletonStops.map((skeletonStop) => {
    const detailedStop = detailedStops?.find((stop) => stop.id === skeletonStop.id)

    return {
      ...skeletonStop,
      description:
        typeof detailedStop?.description === 'string' && detailedStop.description.trim()
          ? detailedStop.description
          : skeletonStop.description,
    }
  })
}

function mergeDetailedTransportSegments(
  skeletonSegments: TripPlan['transportSegments'],
  detailedSegments?: TripPlan['transportSegments'],
) {
  return skeletonSegments.map((skeletonSegment) => {
    const detailedSegment = detailedSegments?.find(
      (segment) =>
        segment.fromStopId === skeletonSegment.fromStopId &&
        segment.toStopId === skeletonSegment.toStopId,
    )

    return {
      ...skeletonSegment,
      label:
        typeof detailedSegment?.label === 'string' && detailedSegment.label.trim()
          ? detailedSegment.label
          : skeletonSegment.label,
    }
  })
}

function parseJsonObject(text: string): unknown {
  try {
    // 找出第一個 { 與最後一個 }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error()
    
    const jsonStr = text.slice(start, end + 1)
    return JSON.parse(jsonStr)
  } catch {
    throw new Error('無法解析 AI 回傳的 JSON。')
  }
}

function normalizeTripPlanResponse(parsed: unknown): GenerateTripPlansResponse {
  // 這裡實作基本的正規化邏輯
  return parsed as GenerateTripPlansResponse
}

function isTripPlanResponse(value: unknown): value is GenerateTripPlansResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plans' in value &&
    Array.isArray(value.plans) &&
    value.plans.length === 3
  )
}

function getAllowedTripMinutes(input: TripInput) {
  const start = parseTimeToMinutes(input.startTime)
  const end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null

  return end >= start ? end - start : end + 24 * 60 - start
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function getRequiredCoverageRatio() {
  // 統一提升至 85%，確保行程時長符合使用者期望
  return 0.85
}
