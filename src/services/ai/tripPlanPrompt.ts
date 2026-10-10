import type {
  GenerateTripPlansResponse,
  Persona,
} from './types.js'
import { MEAL_SUITABILITY_PROMPT_RULE } from './mealSuitability.js'
import { isTripPlanType, normalizeTripPlanIdentities, TRIP_PLAN_TYPES } from './tripPlanIdentity.js'
import type {
  BudgetLevel,
  PlanType,
  Stop,
  TransportSegment,
  TransportMode,
  TripCategory,
  TripInput,
  TripPlan,
} from '../../types/trip.js'
const EARLY_MORNING_ACTIVE_START_MINUTES = 6 * 60
const MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES = 40 * 2 + 18
const TRIP_RESPONSE_ERROR =
  '這次 AI 產生的行程資料不夠完整，請重新分析一次。'

const STYLE_GUIDANCE: Record<PlanType, { label: string; instruction: string; summary: string }> = {
  safe: {
    label: 'Safe／保守',
    instruction: '行程集中、交通負擔低；偏向深入值得停留的主要活動，不追求大量景點，適合輕鬆穩定執行。',
    summary: '集中路線，深入主要活動',
  },
  balanced: {
    label: 'Balanced／平衡',
    instruction: '活動類型與停留節奏均衡；合理組合主要景點、休息與必要餐飲，兼顧豐富度及交通效率。',
    summary: '主要活動與休息節奏均衡',
  },
  explore: {
    label: 'Explore／探索',
    instruction: '優先尋找符合使用者興趣、具有不同體驗價值的活動；允許較豐富的探索，但不代表必須更遠、更多站或更趕，不為與其他方案不同而犧牲地點品質。',
    summary: '依興趣安排有價值的不同體驗',
  },
}

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

export function buildTripPrompt(input: TripInput, persona?: Persona, nearbyPlaces?: string, locationWarning?: string,
  options: { planTypes?: readonly PlanType[] } = {}) {
  const planTypes = options.planTypes ?? TRIP_PLAN_TYPES
  const styleTasks = planTypes.map(type => `- ${type}（${STYLE_GUIDANCE[type].label}）：${STYLE_GUIDANCE[type].instruction}`).join('\n')
  const identityExample = JSON.stringify({ plans: planTypes.map(type => ({
    id: type, type, title: '體驗短標題', summary: STYLE_GUIDANCE[type].summary,
  })) }, null, 2)
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
  const wantsNoFullMeals = input.tags.includes('no_full_meals')
  const allowedMinutes = getAllowedTripMinutes(input)
  const coverageBasisMinutes = getCoverageBasisMinutes(input)
  const scheduleCapacityMinutes = getScheduleCapacityMinutes(input)
  const minimumActualMinutes = coverageBasisMinutes
    ? Math.ceil(coverageBasisMinutes * getRequiredCoverageRatio(coverageBasisMinutes))
    : null
  const earlyMorningNote = getEarlyMorningPlanningNote(input)
  
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
1. 本次所有方案的 stops 只能從上方 Google Maps 候選清單挑選，不可自創、改寫 or 使用清單外地點。
2. stop.name 必須逐字複製候選清單的 name；stop.address 必須逐字複製同一筆候選的 address；若候選資料含 placeId，請原樣填入 stop.placeId。
3. 第一站（即每個 plan 的 stops[0]）必須從 FIRST_STOP_CANDIDATES_WITHIN_2KM 區塊挑選；若該區塊存在，禁止使用其他區塊作為第一站。
4. 不可使用「特色小吃」「親民餐廳」「附近餐廳」「咖啡廳」「景點」這類空泛名稱。
5. 若候選清單沒有適合的地點，也不要補入清單外地點；請改用清單內較接近需求的地點組合。
`.trim()
    : `
- 警告：目前無法取得起點附近的即時地點清單。
- 指示：不要使用「附近餐廳」「湖畔咖啡館」「在地小吃店」這類泛稱或不確定存在的地點；若缺少即時候選，仍只能使用能明確指出真實名稱與地址、且你能確定營業時段適合的地點。
`.trim()

  return `你是台灣在地行程規劃 AI。請依使用者輸入產生 ${planTypes.length} 個單日行程「骨架」方案，並回傳符合 schema 的 JSON。此階段只產生可比較的核心路線，不要產生景點 description、雨天備案或交通 label。

本次指定風格任務（體驗偏好，不是新的評分或安全門檻）：
${styleTasks}
- 各風格都以使用者的主題、興趣、體力與偏好為優先，遵守相同的合法性、餐期、營業時間、合理停留與時間容量規則。
- 候選 score 已含現有個人化結果，作為共同品質依據；不要因風格或個人化重複加分。
- 從活動用途、停留深度、交通負擔與休息節奏提供實際不同的選擇，不是只換 title、summary 或 type。同地點但不同合理停留深度也可以有體驗價值。
- 候選受限時允許相似及重用高品質地點；不要為差異硬加站、刻意繞路、壓縮有價值的原活動或任意拉長停留。

使用者輸入：
- 行程類型：${displayCategory}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 可用行程時間：${allowedMinutes ?? '未知'} 分鐘
- 可安排真實 stop 時長上限：${scheduleCapacityMinutes ?? '未知'} 分鐘（所有 stop.duration + transportSegments.duration 加總不得超過此值）
- 最低實際行程長度：${minimumActualMinutes ?? '未知'} 分鐘（所有 stop.duration + transportSegments.duration 加總）
${earlyMorningNote ? `- 凌晨時段規劃：${earlyMorningNote}` : ''}
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
1. 只產生本次指定的風格：${planTypes.join(', ')}，各一案。plan.id 與 plan.type 必須同時逐字等於該案指定風格，不可重複、缺少或回傳未請求的風格。
   - 使用者的「行程類型」是共同主題，不是 plan.type；即使行程類型為探索或美食，仍須依本次指定風格任務產生各一案。不要使用 explore-1/2/3 等別名，不可由陣列位置猜測風格，也不可只改標籤而未依指定風格規劃。
2. transportMode：若使用者有指定交通工具偏好，各方案必須使用該 transportMode；若未指定，先決定一種最適合本次行程的 transportMode，各方案必須統一。
3. 每 plan 的 transportSegments 長度 = stops.length - 1；fromStopId / toStopId 必須對應相鄰 stop 的 id。
4. stop.id 僅允許英文、數字、底線、連字號；同一 plan 內不可重複。
5. 文字長度：title 4-8 字、subtitle 8-18 字、summary 30 字內；皆繁體中文；title 不可塞入多個地名。
6. stops 不必硬塞所有類型；每個方案至少要有 main_activity。food 只有在行程涵蓋午餐/晚餐且能排進候選營業窗時才安排；ending_or_transition 只在時間足夠且真的適合作為收尾時安排。
7. totalTime 為分鐘、budget 為新台幣元、stop.duration 與 transportSegments.duration 為分鐘。
8. 若人數 ≥ 5，避開座位少、精緻小巧、不適合團體的店家或活動。
9. 早餐規則：除非使用者明確要求早餐，否則不要把早餐作為 stop 名稱、主餐或主要餐飲安排。
10. 午餐開始時間窗為 11:00-13:00（不含 13:00），晚餐為 17:00-19:00（不含 19:00）。只有在實際開始至指定結束之間，能容納至少 45 分鐘且開始落在餐窗內的用餐，才需要該餐；不能僅因一分鐘重疊就要求用餐。
    - 未勾選「不吃正餐」時，每個必要餐期需有 food stop，開始時間落在該餐窗內且停留至少 45 分鐘；不可僅靠停留跨入餐窗算完成用餐。只需要一餐就只排一餐；候選須符合完整停留的營業時間及 closing buffer。輕食/咖啡也須符合相同時間規則，不要硬塞未開門餐廳。
    - 勾選「不吃正餐」時不排正餐，可改咖啡、甜點、點心或輕食。
    - 正餐與休息用途分開考量；午晚餐優先使用正餐能力較可信且路線合理的候選，咖啡、甜點與小吃仍可保留作休息或特色體驗。${MEAL_SUITABILITY_PROMPT_RULE}
11. 時間覆蓋率：實際總分鐘數（所有 stop.duration + 所有交通段 duration）必須 >= 上方「最低實際行程長度」；totalTime 也必須等於這個實際總分鐘數。
    - 實際總分鐘數不得超過上方「可安排真實 stop 時長上限」。
    - 可用時間 > 6h 時實際結束不得明顯早於指定結束：8-12h 最多提早 90 分、12-24h 最多提早 180 分；若有「凌晨時段規劃」提示，這條只套用在 06:00 後的有效活動時段，不要求用景點填滿凌晨緩衝。
    - stops 不設硬性上限；時間越長可安排越多站，避免把單一 stop.duration 拉到不合理長度。4-8h 通常 3-5 站，8-12h 通常 4-6 站，12-16h 通常 5-7 站，16h 以上至少約 6 站，依候選營業窗調整。
12. 不要在 summary 要求使用者自行新增停靠站；回傳結果需是可直接比較的完整路線骨架。
13. 第一站距離起點必須 ≤ 2 km (若有經緯度座標時為硬性規則)。
14. 交通效率建議 (軟性規則)：相鄰站點間交通時間建議 ≤ 30 分鐘；整日累積交通時間建議 ≤ 總行程時長的 25%。
15. 規劃核心：必須以使用者提供的「起點」為地理中心點往外擴張，優先選擇附近的景點，避免跨區過遠。
16. 禁止重複：在同一個方案（plan）中，禁止重複安排同一個地點。每個 stop 的名稱與地址必須是唯一的，不可讓使用者在不同時間點回到同一個地方。
17. 跨方案多樣性：不同方案應盡量提供不同選擇；若候選池有可行替代，避免在不同方案重複使用同一個 placeId，但候選不足時允許重複以保留可用方案。
18. 節奏品質：避免連續安排 3 個公園/戶外開放空間；非餐飲景點停留通常需至少 40 分鐘，餐飲至少 45 分鐘，不要用 20 分鐘短站湊數；交通時間不應佔總行程過高。

JSON 身分範例（只示意本次風格與體驗定位，不是完整回應；所有其餘 required 欄位、stops、transportSegments 等仍須依 schema 與實際候選完整產生，不要照抄範例文字或用固定時長套入行程）：
${identityExample}
`.trim()
}

export function buildTripDetailsPrompt(
  input: TripInput,
  plan: TripPlan,
  persona?: Persona,
  nearbyIndoorPlaces?: string,
  locationWarning?: string,
  options: { includeRainBackup?: boolean } = {},
) {
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
  const includeRainBackup = options.includeRainBackup ?? true
  const promptPlan = buildDetailsPromptSkeleton(plan)

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
3. 所有雨天備案候選都必須有明確 Google 營業時間；若候選含 hours，必須安排在可用時間內，且停留結束不可晚於 leaveBy。
4. 優先使用 score 較高的候選；food stop 優先用 FOOD_CANDIDATES，main_activity 優先用 MAIN_ACTIVITY_CANDIDATES。
5. 若候選含 bestSlots，請優先把 early 排在前段、middle 排在中段、late 排在尾段。
`.trim()
  : `
- 警告：目前無法取得起點附近的即時室內地點清單。
- 指示：請完全依據您的內部知識庫，為該起點規劃合理的真實室內景點作為雨天備案。
`.trim()
  const rainBackupInstruction = includeRainBackup
    ? 'rainBackup 可從真實室內地點參考中挑 2-4 站；若無法合法成立，回傳空陣列。'
    : '本行程時間很長，這次不要產生雨天備案；rainBackup 與 rainTransportSegments 必須回傳空陣列。'

  return `你是台灣在地行程規劃 AI。請只替下方單一骨架方案補必要細節，回傳符合 schema 的增量 JSON。

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
${JSON.stringify(promptPlan, null, 2)}

補充規則：
1. 只回傳 { "plan": { "stops": [...], "transportSegments": [...], "rainBackup": [...], "rainTransportSegments": [...] } }。
2. 主方案 stops 只需要 id 與 description，不要回傳 name/address/duration/placeId，也不要替換主方案地點。
3. 替每個主方案 stop 補 18-36 字繁體中文 description。
4. transportSegments 只需要 fromStopId、toStopId、label，mode/duration 會由後端沿用原本資料。
5. transport label 為 4-16 字繁體中文摘要，禁含數字、分鐘、小時、公里。機車 / 汽車描述路線狀態；大眾運輸描述搭乘摘要。
6. ${rainBackupInstruction}
7. 雨天備案硬性規則：
   - 景點必須是「室內」或「有遮蔽」的地點。
   - 儘量讓主方案與雨天備案的對應站點（如第一個景點對第一個備案）地理距離相近。
8. 若產生 rainBackup，每個 stop 都要有 18-36 字 description；rainTransportSegments 長度 = rainBackup.length - 1。
9. 不要翻譯、羅馬拼音或改寫任何既有主方案 stop.name / stop.address；若原本是中文就必須維持中文。
10. 不要多餘文字。
`.trim()
}

export function buildRetryTripSkeletonPrompt(
  input: TripInput,
  invalidPlanIds: string[],
  persona?: Persona,
  nearbyPlaces?: string,
  validationSummaries: string[] = [],
) {
  if (!invalidPlanIds.length || invalidPlanIds.some(id => !isTripPlanType(id)) ||
    new Set(invalidPlanIds).size !== invalidPlanIds.length) throw new Error(TRIP_RESPONSE_ERROR)
  const planTypes = TRIP_PLAN_TYPES.filter(type => invalidPlanIds.includes(type))
  const originalPrompt = buildTripPrompt(input, persona, nearbyPlaces, undefined, { planTypes })
  const validationContext = validationSummaries.length > 0
    ? `\n未通過原因：\n${validationSummaries.map((summary) => `- ${summary}`).join('\n')}`
    : ''

  return `
${originalPrompt}

重要：以下指定風格仍需取得可驗收方案，請重新規劃。只回傳列出的方案 ID，不要回傳其餘已通過方案。
只產生列出的風格各一案；須按上方同一份指定風格指示重新規劃，不得拿另一種風格的行程改名交付。
請務必修正所有列出的問題：地點必須來自候選清單、能通過 Google Places 驗證、第一站 ≤ 2 km、安排時間需符合候選 hours / leaveBy，且實際總分鐘數必須達到指定時間範圍的覆蓋率。
補案的 plan.id 與 type 必須逐字等於「需重產的方案 ID」；title 不可寫「方案一 / 方案二 / 方案三」，避免和前端排序混淆。

需重產的方案 ID：${invalidPlanIds.join(', ')}
${validationContext}
`.trim()
}

function buildDetailsPromptSkeleton(plan: TripPlan) {
  return {
    id: plan.id,
    type: plan.type,
    title: plan.title,
    summary: plan.summary,
    totalTime: plan.totalTime,
    transportMode: plan.transportMode,
    stops: plan.stops.map((stop) => ({
      id: stop.id,
      name: stop.name,
      type: stop.type,
      address: stop.address,
      duration: stop.duration,
    })),
    transportSegments: plan.transportSegments.map((segment) => ({
      fromStopId: segment.fromStopId,
      toStopId: segment.toStopId,
      mode: segment.mode,
      publicTransitType: segment.publicTransitType,
      duration: segment.duration,
    })),
  }
}

export function parseTripPlanResponse(text: string): GenerateTripPlansResponse {
  const parsed = parseJsonObject(text)
  const response = normalizeTripPlanResponse(parsed)

  if (!isTripPlanResponse(response)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  response.plans = normalizeTripPlanIdentities(response.plans)

  return response
}

export function parseTripPlanSkeletonResponse(text: string): GenerateTripPlansResponse {
  const parsed = parseJsonObject(text)
  
  // 骨架版 parser 邏輯
  if (!parsed || typeof parsed !== 'object' || !('plans' in parsed) || !Array.isArray(parsed.plans)) {
    throw new Error(TRIP_RESPONSE_ERROR)
  }

  return { ...parsed, plans: normalizeTripPlanIdentities(parsed.plans) } as GenerateTripPlansResponse
}

type TripPlanDetailsPatch = {
  plan?: {
    stops?: Array<Pick<Stop, 'id'> & Partial<Pick<Stop, 'description'>>>
    transportSegments?: Array<
      Pick<TransportSegment, 'fromStopId' | 'toStopId'> &
        Partial<Pick<TransportSegment, 'label' | 'publicTransitType'>>
    >
    rainBackup?: TripPlan['rainBackup']
    rainTransportSegments?: TripPlan['rainTransportSegments']
  }
}
type TripPlanDetailsPatchPlan = NonNullable<TripPlanDetailsPatch['plan']>

export function parseTripPlanDetailsResponse(text: string, skeletonPlan: TripPlan): TripPlan {
  const parsed = parseJsonObject(text) as TripPlanDetailsPatch
  
  if (!parsed || !parsed.plan) {
    throw new Error('詳情補充回傳格式不正確。')
  }

  const detailedPlan = parsed.plan
  
  // 將骨架版的基礎資訊合併回來（以防 AI 弄亂）
  return {
    ...skeletonPlan,
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

function mergeDetailedStops(
  skeletonStops: TripPlan['stops'],
  detailedStops?: TripPlanDetailsPatchPlan['stops'],
) {
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
  detailedSegments?: TripPlanDetailsPatchPlan['transportSegments'],
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

function getCoverageBasisMinutes(input: TripInput) {
  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return null
  if (end <= start) end += 24 * 60

  if (shouldUseEarlyMorningActiveWindow(start, end)) {
    return end - EARLY_MORNING_ACTIVE_START_MINUTES
  }

  return end - start
}

function getScheduleCapacityMinutes(input: TripInput) {
  return getCoverageBasisMinutes(input)
}

function getEarlyMorningPlanningNote(input: TripInput) {
  const start = parseTimeToMinutes(input.startTime)
  let end = parseTimeToMinutes(input.endTime)

  if (start === null || end === null) return ''
  if (end <= start) end += 24 * 60
  if (start < EARLY_MORNING_ACTIVE_START_MINUTES && end <= EARLY_MORNING_ACTIVE_START_MINUTES) {
    return '整段行程落在 06:00 前的低營業密度時段；只能安排候選清單中已知在這段時間營業、且可完整停留至少 40 分鐘（餐飲至少 45 分鐘）的地點。不可安排 06:00 才開門或沒有 bestSlots 的候選。'
  }
  if (start >= EARLY_MORNING_ACTIVE_START_MINUTES || end <= EARLY_MORNING_ACTIVE_START_MINUTES) {
    return ''
  }
  if (!shouldUseEarlyMorningActiveWindow(start, end)) {
    return '行程只短暫跨到 06:00 後，06:00 後不足以排完整兩站；請以整段使用者時間窗為準，只能使用候選清單中已知在清晨/凌晨可完整停留的地點，不可自創地點或硬排未營業景點。'
  }

  return '行程橫跨凌晨與早晨，02:00-06:00 這類低營業密度時段可視為等待/休息/移動緩衝；請優先安排 06:00 後已知營業中的真實地點，不要為了塞滿凌晨而硬排未營業景點。'
}

function shouldUseEarlyMorningActiveWindow(start: number, end: number) {
  return (
    start < EARLY_MORNING_ACTIVE_START_MINUTES &&
    end > EARLY_MORNING_ACTIVE_START_MINUTES &&
    end - EARLY_MORNING_ACTIVE_START_MINUTES >= MIN_EARLY_MORNING_ACTIVE_WINDOW_MINUTES
  )
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function getRequiredCoverageRatio(allowedMinutes: number) {
  if (allowedMinutes <= 4 * 60) return 0.7
  if (allowedMinutes <= 8 * 60) return 0.75
  if (allowedMinutes <= 12 * 60) return 0.8

  return 0.7
}
