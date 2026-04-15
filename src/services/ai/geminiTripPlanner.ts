import { aiConfig } from './config'
import type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'
import type {
  PlanType,
  Stop,
  StopType,
  TransportMode,
  TripInput,
  TripPlan,
} from '../../types/trip'

const GEMINI_API_KEY_PLACEHOLDER = '在此處填上你的api key'
const REQUIRED_GEMINI_MODEL = 'gemini-2.5-flash'
const PLAN_ORDER: PlanType[] = ['safe', 'balanced', 'explore']

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
}

export class GeminiTripPlanner implements AiTripPlanner {
  async generateTripPlans(
    request: GenerateTripPlansRequest,
  ): Promise<GenerateTripPlansResponse> {
    assertGeminiConfig()

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${aiConfig.geminiModel}:generateContent?key=${aiConfig.geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildTripPrompt(request.input) }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.7,
          },
        }),
      },
    )

    if (!response.ok) {
      throw new Error('Gemini API 呼叫失敗，請稍後再試。')
    }

    const data = (await response.json()) as GeminiResponse
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text

    if (!text) {
      throw new Error('AI 沒有回傳可解析的內容，請重新分析。')
    }

    return parseTripPlanResponse(text)
  }

  async recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse> {
    void request
    assertGeminiConfig()
    throw new Error('交通重算會在 Phase 4 前確認互動細節後實作。')
  }
}

function assertGeminiConfig() {
  if (aiConfig.geminiModel !== REQUIRED_GEMINI_MODEL) {
    throw new Error('Gemini 模型必須使用 gemini-2.5-flash。')
  }

  if (
    !aiConfig.geminiApiKey ||
    aiConfig.geminiApiKey === GEMINI_API_KEY_PLACEHOLDER
  ) {
    throw new Error('請先在專案根目錄建立 .env，並填入 Gemini API key。')
  }
}

function buildTripPrompt(input: TripInput) {
  const tags = input.tags.map((tag) => tagLabels[tag]).join('、') || '無'
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
你是台灣在地行程規劃 AI。請根據使用者輸入，產生 3 個單日行程方案。

使用者輸入：
- 行程類型：${category}
- 開始時間：${input.startTime}
- 結束時間：${input.endTime}
- 預算：${budgetLabels[input.budget]}
- 人數：${input.people}
- 限制條件：${tags}
- 起點：${location}

硬性規則：
1. 只允許回傳 JSON，不可回傳 markdown、說明文字、code block。
2. 必須回傳剛好 3 個 plans，順序固定為 safe、balanced、explore。
3. 三個方案主題相同，但風格不同：safe 保守型、balanced 平衡型、explore 探索型。
4. 先判斷一種最適合本次行程的預設交通方式，三個方案都必須使用同一種 transportMode。
5. transportMode 只能是 "scooter"、"car"、"public_transit"。
6. 每個 stop 的 transport 描述都要符合同一種 transportMode，不可混用不同交通方式。
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
          "name": "地點名稱",
          "type": "main_activity",
          "address": "完整地址或可搜尋地址",
          "duration": 90,
          "transport": "使用統一交通方式的交通描述",
          "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=..."
        }
      ],
      "rainBackup": [
        {
          "name": "雨天備案地點",
          "type": "main_activity",
          "address": "完整地址或可搜尋地址",
          "duration": 90,
          "transport": "使用統一交通方式的交通描述",
          "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=..."
        }
      ]
    }
  ]
}
`.trim()
}

function parseTripPlanResponse(text: string): GenerateTripPlansResponse {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('AI 回傳格式異常，請重新分析。')
  }

  if (!isTripPlanResponse(parsed)) {
    throw new Error('AI 回傳格式異常，請重新分析。')
  }

  const transportMode = parsed.plans[0]?.transportMode
  const hasUnifiedTransport = parsed.plans.every(
    (plan) => plan.transportMode === transportMode,
  )

  if (!hasUnifiedTransport) {
    throw new Error('AI 回傳的交通方式不一致，請重新分析。')
  }

  return {
    plans: [...parsed.plans].sort(
      (left, right) => PLAN_ORDER.indexOf(left.type) - PLAN_ORDER.indexOf(right.type),
    ),
  }
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

  return (
    isPlanType(value.type) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.subtitle === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.totalTime === 'number' &&
    typeof value.budget === 'number' &&
    isTransportMode(value.transportMode) &&
    Array.isArray(value.stops) &&
    value.stops.length >= 2 &&
    value.stops.length <= 6 &&
    value.stops.every(isStop) &&
    Array.isArray(value.rainBackup) &&
    value.rainBackup.every(isStop)
  )
}

function isStop(value: unknown): value is Stop {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.name === 'string' &&
    isStopType(value.type) &&
    typeof value.address === 'string' &&
    typeof value.duration === 'number' &&
    typeof value.transport === 'string' &&
    (typeof value.googleMapsUrl === 'undefined' ||
      typeof value.googleMapsUrl === 'string')
  )
}

function isPlanType(value: unknown): value is PlanType {
  return value === 'safe' || value === 'balanced' || value === 'explore'
}

function isTransportMode(value: unknown): value is TransportMode {
  return value === 'scooter' || value === 'car' || value === 'public_transit'
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

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
}
