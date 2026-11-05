import { createHmac } from 'node:crypto'
import type { messagingApi } from '@line/bot-sdk'
import type { TripPlan } from '../../src/types/trip.js'

type FlexBubble = messagingApi.FlexBubble
type FlexCarousel = messagingApi.FlexCarousel

export type TripWeatherSummary = {
  temperature?: number | null
  rainProbability?: number | null
  condition?: string
}

const PLAN_THEME_COLORS: Record<string, { headerBg: string; buttonBg: string; label: string }> = {
  safe: {
    headerBg: '#D97706',
    buttonBg: '#B45309',
    label: '精選穩健 · 經典熱門',
  },
  balanced: {
    headerBg: '#2563EB',
    buttonBg: '#1D4ED8',
    label: '豐富均衡 · 步調適中',
  },
  explore: {
    headerBg: '#059669',
    buttonBg: '#047857',
    label: '特色探索 · 深度慢遊',
  },
}

function compactPlanForUrl(plan: TripPlan): TripPlan {
  return {
    ...plan,
    stops: (plan.stops || []).map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      type: s.type,
      description: (s.description || '').slice(0, 80),
      address: (s.address || '').slice(0, 60),
      lat: s.lat,
      lng: s.lng,
      googleMapsUrl: s.googleMapsUrl,
      placeId: s.placeId,
    })),
    rainBackup: (plan.rainBackup || []).map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      type: s.type,
      description: (s.description || '').slice(0, 80),
      address: (s.address || '').slice(0, 60),
      lat: s.lat,
      lng: s.lng,
      googleMapsUrl: s.googleMapsUrl,
      placeId: s.placeId,
    })),
    transportSegments: (plan.transportSegments || []).map((t) => ({
      fromStopId: t.fromStopId || '',
      toStopId: t.toStopId || '',
      mode: t.mode,
      duration: t.duration,
      label: t.label,
    })),
    rainTransportSegments: (plan.rainTransportSegments || []).map((t) => ({
      fromStopId: t.fromStopId || '',
      toStopId: t.toStopId || '',
      mode: t.mode,
      duration: t.duration,
      label: t.label,
    })),
  }
}

export function buildTripPlansFlexMessage(
  plans: TripPlan[],
  baseUrl: string = 'https://testing-cyan-seven-40.vercel.app',
  weather?: TripWeatherSummary,
): messagingApi.FlexMessage {
  const tempText =
    weather?.temperature !== undefined && weather?.temperature !== null
      ? `${weather.temperature}°C`
      : '即時氣候舒適'
  const rainText =
    weather?.rainProbability !== undefined && weather?.rainProbability !== null
      ? `降雨機率 ${weather.rainProbability}%`
      : '降雨機率 10%'
  const condText = weather?.condition || '適合戶外活動'
  const weatherLabel = `[氣象] ${tempText} · ${rainText} · ${condText}`

  const bubbles: FlexBubble[] = plans.map((plan, index) => {
    const theme = PLAN_THEME_COLORS[plan.id] || {
      headerBg: '#4F46E5',
      buttonBg: '#4338CA',
      label: `方案 ${index + 1}`,
    }

    const durationHours = Math.round((plan.totalTime || 180) / 60 * 10) / 10
    const stops = plan.stops || []

    const stopContents: messagingApi.FlexComponent[] = stops.slice(0, 4).map((stop, i) => {
      const isFood = stop.type === 'food'
      const tagText = isFood ? '[餐飲]' : `[第${i + 1}站]`
      return {
        type: 'box',
        layout: 'horizontal',
        margin: 'md',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: tagText,
            size: 'xs',
            color: '#6B7280',
            flex: 2,
          },
          {
            type: 'text',
            text: stop.name || '景點',
            size: 'xs',
            color: '#1F2937',
            weight: 'bold',
            flex: 4,
            wrap: true,
          },
          {
            type: 'text',
            text: stop.duration ? `${stop.duration}分` : '',
            size: 'xxs',
            color: '#9CA3AF',
            align: 'end',
            flex: 2,
          },
        ],
      }
    })

    const planEncoded = Buffer.from(JSON.stringify(compactPlanForUrl(plan))).toString('base64')
    const liffDetailUrl = `${baseUrl.replace(/\/$/, '')}/plans/${plan.id}?plan=${encodeURIComponent(planEncoded)}`
    const rainDataSummary = (plan.rainBackup || [])
      .slice(0, 3)
      .map((s) => `${(s.name || '室內景點').slice(0, 15)}:${s.duration || 40}`)
      .join('|')
    const rainPostbackData = `action=rain_backup&plan_id=${plan.id}&title=${encodeURIComponent((plan.title || '雨天備案').slice(0, 15))}&stops=${encodeURIComponent(rainDataSummary)}`

    const bubble: FlexBubble = {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: theme.headerBg,
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: plan.title || `方案 ${index + 1}`,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'lg',
            wrap: true,
          },
          {
            type: 'text',
            text: `${theme.label} · 約 ${durationHours} 小時`,
            color: '#FEF3C7',
            size: 'xs',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: plan.summary || '專為您當前位置規劃的即時推薦行程。',
            size: 'xs',
            color: '#4B5563',
            wrap: true,
            maxLines: 3,
          },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'md',
            backgroundColor: '#F3F4F6',
            cornerRadius: 'md',
            paddingAll: 'sm',
            contents: [
              {
                type: 'text',
                text: weatherLabel,
                size: 'xxs',
                color: '#374151',
                weight: 'bold',
                wrap: true,
              },
            ],
          },
          {
            type: 'separator',
            margin: 'lg',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: `行程路線 (共 ${stops.length} 站)`,
                size: 'xs',
                weight: 'bold',
                color: '#374151',
                margin: 'sm',
              },
              ...stopContents,
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '切換雨天備案 (室內)',
              data: rainPostbackData,
            },
          },
          {
            type: 'button',
            style: 'primary',
            color: theme.buttonBg,
            height: 'sm',
            action: {
              type: 'uri',
              label: '查看完整時間軸',
              uri: liffDetailUrl,
            },
          },
        ],
      },
    }

    return bubble
  })

  const carousel: FlexCarousel = {
    type: 'carousel',
    contents: bubbles,
  }

  return {
    type: 'flex',
    altText: `TripNeeder 為您規劃了 ${plans.length} 套即時行程方案`,
    contents: carousel,
  }
}

export function buildRainBackupFlexMessage(
  plan: TripPlan,
  baseUrl: string = 'https://testing-cyan-seven-40.vercel.app',
  weather?: TripWeatherSummary,
): messagingApi.FlexMessage {
  const rainStops = plan.rainBackup || []
  const planEncoded = Buffer.from(JSON.stringify(compactPlanForUrl(plan))).toString('base64')
  const rainDetailUrl = `${baseUrl.replace(/\/$/, '')}/plans/${plan.id}?plan=${encodeURIComponent(planEncoded)}`
  const rainProbText =
    weather?.rainProbability !== undefined && weather?.rainProbability !== null
      ? `預測降雨機率 ${weather.rainProbability}%`
      : '降雨警戒模式'

  const stopContents: messagingApi.FlexComponent[] =
    rainStops.length > 0
      ? rainStops.map((stop, i) => ({
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: `[室內${i + 1}]`,
              size: 'xs',
              color: '#0284C7',
              flex: 2,
            },
            {
              type: 'text',
              text: stop.name || '室內景點',
              size: 'xs',
              color: '#1F2937',
              weight: 'bold',
              flex: 4,
              wrap: true,
            },
            {
              type: 'text',
              text: stop.duration ? `${stop.duration}分` : '',
              size: 'xxs',
              color: '#9CA3AF',
              align: 'end',
              flex: 2,
            },
          ],
        }))
      : [
          {
            type: 'text',
            text: '此方案原已為室內行程，或周邊無額外雨備景點。',
            size: 'xs',
            color: '#6B7280',
            wrap: true,
          },
        ]

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0284C7',
      paddingAll: 'lg',
      contents: [
        {
          type: 'text',
          text: `${plan.title} · 雨天備案`,
          weight: 'bold',
          color: '#FFFFFF',
          size: 'lg',
          wrap: true,
        },
        {
          type: 'text',
          text: '全室內站點推薦 · 免淋雨路線',
          color: '#E0F2FE',
          size: 'xs',
          margin: 'xs',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'none',
          backgroundColor: '#E0F2FE',
          cornerRadius: 'md',
          paddingAll: 'sm',
          contents: [
            {
              type: 'text',
              text: `[雨備指南] ${rainProbText} · 路線全面避雨 · 室內舒適活動`,
              size: 'xxs',
              color: '#0369A1',
              weight: 'bold',
              wrap: true,
            },
          ],
        },
        {
          type: 'text',
          text: `室內替代路線 (共 ${rainStops.length} 站)`,
          size: 'xs',
          weight: 'bold',
          color: '#374151',
          margin: 'md',
        },
        {
          type: 'separator',
          margin: 'sm',
        },
        ...stopContents,
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'lg',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#0284C7',
          height: 'sm',
          action: {
            type: 'uri',
            label: '開啟網頁看完整時間軸',
            uri: rainDetailUrl,
          },
        },
      ],
    },
  }

  return {
    type: 'flex',
    altText: `${plan.title} 的雨天備案行程`,
    contents: bubble,
  }
}

export function buildWelcomeMessage(): messagingApi.TextMessage {
  return {
    type: 'text',
    text: '您好，我是 TripNeeder 行程助理。\n\n請選擇預計停留時長並分享您的位置，系統將為您規劃 3 套即時行程方案。\n\n請先選擇預計時長：',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '2 小時 (快速微旅行)',
            text: '2小時',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '3 小時 (標準探索)',
            text: '3小時',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '6 小時 (半日慢遊)',
            text: '6小時',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '10 小時 (玩一整天)',
            text: '10小時',
          },
        },
      ],
    },
  }
}

export function buildAskTransportMessage(durationMinutes: number): messagingApi.TextMessage {
  const hours = Math.round(durationMinutes / 60)
  return {
    type: 'text',
    text: `已設定遊玩時間為【${hours} 小時】。\n\n請選擇您的「交通方式」：`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '機車 (靈活快捷)',
            text: '機車',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '汽車 (舒適遮雨)',
            text: '汽車',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '大眾運輸 (捷運/公車)',
            text: '大眾運輸',
          },
        },
      ],
    },
  }
}

export function buildAskLocationMessage(
  durationMinutes: number,
  transportMode: string = 'car',
): messagingApi.TextMessage {
  const hours = Math.round(durationMinutes / 60)
  const transportLabels: Record<string, string> = {
    scooter: '機車',
    car: '汽車',
    public_transit: '大眾運輸',
  }
  const transportText = transportLabels[transportMode] || '汽車'
  return {
    type: 'text',
    text: `已設定時長【${hours} 小時】、交通【${transportText}】。\n\n請點擊下方按鈕分享「目前位置」，系統將依您的位置搜尋周邊推薦景點。`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'location',
            label: '分享目前位置',
          },
        },
      ],
    },
  }
}

export function buildNeedLoginUrl(
  baseUrl: string = 'https://testing-cyan-seven-40.vercel.app',
  lineUserId: string,
): string {
  const secret = process.env.LINE_CHANNEL_SECRET || 'tripneeder-line-secret'
  const ts = Date.now()
  const sig = createHmac('sha256', secret).update(`${lineUserId}:${ts}`).digest('hex')
  return `${baseUrl.replace(/\/$/, '')}/login?line_user_id=${encodeURIComponent(lineUserId)}&ts=${ts}&sig=${sig}&openExternalBrowser=1`
}

export function buildNeedLoginMessage(
  baseUrl: string = 'https://testing-cyan-seven-40.vercel.app',
  lineUserId: string,
): messagingApi.FlexMessage {
  const loginUrl = buildNeedLoginUrl(baseUrl, lineUserId)

  return {
    type: 'flex',
    altText: '請先登入 Google 帳號以啟用 TripNeeder 行程規劃',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1E293B',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: 'TripNeeder 會員綁定',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '歡迎使用 TripNeeder 即時行程規劃。',
            weight: 'bold',
            size: 'sm',
            color: '#1F2937',
          },
          {
            type: 'text',
            text: '為了確保您的行程紀錄、偏好設定與點數安全，系統要求先綁定 Google 帳號。完成一次綁定後，往後在 LINE 使用將永久無需重複登入。',
            size: 'xs',
            color: '#4B5563',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#059669',
            height: 'sm',
            action: {
              type: 'uri',
              label: '前往登入 Google 帳號',
              uri: loginUrl,
            },
          },
        ],
      },
    },
  }
}

export function buildInsufficientPointsMessage(
  balance: number,
  baseUrl: string = 'https://testing-cyan-seven-40.vercel.app',
): messagingApi.FlexMessage {
  const pointsUrl = `${baseUrl.replace(/\/$/, '')}/points`

  return {
    type: 'flex',
    altText: `點數不足提醒（目前剩餘 ${balance} 點）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#DC2626',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: '點數不足提醒',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `目前剩餘點數：${balance} 點`,
            weight: 'bold',
            size: 'sm',
            color: '#DC2626',
          },
          {
            type: 'text',
            text: '每次產生 3 套 AI 即時行程方案需要 20 點。請前往點數中心查看明細或補充點數後再出發。',
            size: 'xs',
            color: '#4B5563',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#DC2626',
            height: 'sm',
            action: {
              type: 'uri',
              label: '開啟點數管理中心',
              uri: pointsUrl,
            },
          },
        ],
      },
    },
  }
}

export function buildConfirmCostMessage(
  durationMinutes: number,
  transportMode: string,
  balance: number,
  confirmPostbackData: string,
): messagingApi.TextMessage {
  const hours = Math.round(durationMinutes / 60)
  const transportLabels: Record<string, string> = {
    scooter: '機車',
    car: '汽車',
    public_transit: '大眾運輸',
  }
  const transportText = transportLabels[transportMode] || '汽車'

  return {
    type: 'text',
    text: `已確認規劃條件：\n- 時長：${hours} 小時\n- 交通：${transportText}\n- 目前帳號餘額：${balance} 點\n- 本次規劃預計扣除：20 點\n\n請確認是否開始為您生成行程？`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '確認扣 20 點開始規劃',
            data: confirmPostbackData,
            displayText: '確認扣 20 點開始規劃',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '取消規劃',
            data: 'action=cancel_trip',
            displayText: '取消規劃',
          },
        },
      ],
    },
  }
}
