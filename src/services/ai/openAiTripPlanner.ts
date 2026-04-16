import { aiConfig } from './config'
import { buildTripPrompt, parseTripPlanResponse } from './tripPlanPrompt'
import type {
  AiTripPlanner,
  GenerateTripPlansRequest,
  GenerateTripPlansResponse,
  RecalculateTransportRequest,
  RecalculateTransportResponse,
} from './types'

const OPENAI_API_KEY_PLACEHOLDER = '在此處填上你的openai api key'

export class OpenAiTripPlanner implements AiTripPlanner {
  async generateTripPlans(
    request: GenerateTripPlansRequest,
  ): Promise<GenerateTripPlansResponse> {
    assertOpenAiConfig()
    const text = await requestTripPlans(request)

    return parseTripPlanResponse(text)
  }

  async recalculateTransport(
    request: RecalculateTransportRequest,
  ): Promise<RecalculateTransportResponse> {
    void request
    assertOpenAiConfig()
    throw new Error('交通重算會在後續確認互動細節後實作。')
  }
}

async function requestTripPlans(request: GenerateTripPlansRequest) {
  const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.openAiModel,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: buildTripPrompt(request.input),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'trip_plan_response',
            schema: tripPlanResponseSchema,
            strict: false,
          },
        },
      }),
    })

  if (!response.ok) {
    throw new Error(await buildOpenAiErrorMessage(response))
  }

  const data = (await response.json()) as OpenAiResponse
  const text = extractOpenAiText(data)

  if (!text) {
    throw new Error('OpenAI 沒有回傳可解析的內容，請重新分析。')
  }

  return text
}

function assertOpenAiConfig() {
  if (
    !aiConfig.openAiApiKey ||
    aiConfig.openAiApiKey === OPENAI_API_KEY_PLACEHOLDER
  ) {
    throw new Error(
      '請先在專案根目錄 .env 填入 VITE_OPENAI_BROWSER_CREDENTIAL。',
    )
  }

  if (!aiConfig.openAiModel) {
    throw new Error('請先在 .env 設定 VITE_OPENAI_MODEL。')
  }
}

async function buildOpenAiErrorMessage(response: Response) {
  const detail = await readOpenAiErrorDetail(response)

  if (response.status === 401) {
    return 'OpenAI API key 無法通過驗證，請確認 .env 的 VITE_OPENAI_BROWSER_CREDENTIAL。'
  }

  if (response.status === 429) {
    return detail
      ? `OpenAI 額度或請求量暫時受限：${detail}`
      : 'OpenAI 額度或請求量暫時受限，請確認帳戶額度或稍後再試。'
  }

  return detail
    ? `OpenAI API 呼叫失敗：${detail}`
    : 'OpenAI API 呼叫失敗，請稍後再試。'
}

async function readOpenAiErrorDetail(response: Response) {
  try {
    const data = (await response.json()) as OpenAiErrorResponse

    return data.error?.message ?? ''
  } catch {
    return ''
  }
}

function extractOpenAiText(data: OpenAiResponse) {
  if (typeof data.output_text === 'string') {
    return data.output_text
  }

  for (const output of data.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text
      }
    }
  }

  return ''
}

const stopSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'name', 'type', 'description', 'address', 'duration'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: {
      type: 'string',
      enum: ['main_activity', 'food', 'ending_or_transition'],
    },
    description: { type: 'string' },
    address: { type: 'string' },
    duration: { type: 'number' },
    googleMapsUrl: { type: 'string' },
  },
}

const transportSegmentSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['fromStopId', 'toStopId', 'mode', 'duration', 'label'],
  properties: {
    fromStopId: { type: 'string' },
    toStopId: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['scooter', 'car', 'public_transit'],
    },
    publicTransitType: {
      type: 'string',
      enum: ['bus', 'metro', 'train', 'walk', 'mixed'],
    },
    duration: { type: 'number' },
    label: { type: 'string' },
  },
}

const tripPlanResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plans'],
  properties: {
    plans: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: true,
        required: [
          'id',
          'type',
          'title',
          'subtitle',
          'summary',
          'totalTime',
          'budget',
          'transportMode',
          'stops',
          'transportSegments',
          'rainBackup',
          'rainTransportSegments',
        ],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['safe', 'balanced', 'explore'] },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          summary: { type: 'string' },
          totalTime: { type: 'number' },
          budget: { type: 'number' },
          transportMode: {
            type: 'string',
            enum: ['scooter', 'car', 'public_transit'],
          },
          stops: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: stopSchema,
          },
          transportSegments: {
            type: 'array',
            items: transportSegmentSchema,
          },
          rainBackup: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: stopSchema,
          },
          rainTransportSegments: {
            type: 'array',
            items: transportSegmentSchema,
          },
        },
      },
    },
  },
}

type OpenAiResponse = {
  output_text?: string
  output?: Array<{
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
}

type OpenAiErrorResponse = {
  error?: {
    message?: string
  }
}
