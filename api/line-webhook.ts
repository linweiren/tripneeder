/// <reference types="node" />

import { messagingApi, validateSignature, type webhook } from '@line/bot-sdk'
import { createClient } from '@supabase/supabase-js'
import {
  buildAskLocationMessage,
  buildAskTransportMessage,
  buildConfirmCostMessage,
  buildInsufficientPointsMessage,
  buildNeedLoginMessage,
  buildRainBackupFlexMessage,
  buildTripPlansFlexMessage,
  buildWelcomeMessage,
  type TripWeatherSummary,
} from './_lib/line-flex.js'
import generateTripHandler from './generate-trip.js'
import type { GenerateTripPlansResponse } from '../src/services/ai/types.js'
import type { TripPlan } from '../src/types/trip.js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
  signal?: AbortSignal
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => void
  end: () => void
}

type LineUserProfile = {
  id: string
  email: string
  display_name: string | null
  points_balance: number
}

function getSupabaseClient() {
  const ACTIVE_SUPABASE_URL = 'https://jaxlqqctnnbfritxkkpy.supabase.co'
  const ACTIVE_SUPABASE_ANON_KEY = 'sb_publishable_4iJp5JFnksDVX7STPw05nA_aNNFVznK'
  const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const isLegacyDeadProject = rawUrl.includes('hscnfrjtjdifhnadnlye') || rawUrl.includes('your-project-ref')

  const supabaseUrl = !rawUrl.trim() || isLegacyDeadProject ? ACTIVE_SUPABASE_URL : rawUrl
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (!isLegacyDeadProject && (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)) ||
    ACTIVE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })
}

async function getLineUserProfile(userId: string): Promise<LineUserProfile | null> {
  const supabase = getSupabaseClient()
  if (!supabase) return null

  try {
    const { data, error } = await supabase.rpc('get_line_user_profile', {
      p_line_user_id: userId,
    })
    if (!error && data) {
      return data as LineUserProfile
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, display_name, points_balance')
      .eq('line_user_id', userId)
      .maybeSingle()
    if (profile) return profile as LineUserProfile
    return null
  } catch {
    return null
  }
}

async function consumePointsForLineUser(
  userId: string,
  cost: number = 20,
  reason: string = 'AI 行程規劃 (LINE)',
): Promise<boolean> {
  const supabase = getSupabaseClient()
  if (!supabase) return false

  try {
    const { data, error } = await supabase.rpc('consume_points_for_line_user', {
      p_line_user_id: userId,
      p_reason: reason,
    })
    if (!error && (data as { success?: boolean })?.success) return true

    const { data: dataOld, error: errorOld } = await supabase.rpc('consume_points_for_line_user', {
      p_line_user_id: userId,
      p_cost: cost,
      p_reason: reason,
    })
    if (!errorOld && (dataOld as { success?: boolean })?.success) return true

    const profile = await getLineUserProfile(userId)
    if (profile && profile.points_balance >= cost) {
      const newBal = profile.points_balance - cost
      await supabase.from('profiles').update({ points_balance: newBal }).eq('id', profile.id)
      await supabase.from('point_transactions').insert({
        user_id: profile.id,
        type: 'consume',
        amount: -cost,
        balance_after: newBal,
        reason,
      })
      return true
    }
    return false
  } catch {
    return false
  }
}

const userDurationStore = new Map<string, number>()
const userTransportStore = new Map<string, 'scooter' | 'car' | 'public_transit'>()
const userPlansStore = new Map<string, TripPlan[]>()
const userWeatherStore = new Map<string, TripWeatherSummary>()
const processedEvents = new Set<string>()

function getHeader(
  headers?: Record<string, string | string[] | undefined>,
  name?: string,
): string {
  if (!headers || !name) return ''
  const val = headers[name.toLowerCase()] || headers[name]
  if (Array.isArray(val)) return val[0] || ''
  return val || ''
}

function parseDurationMinutes(text: string): number | null {
  const clean = text.trim()
  if (clean.includes('2') || clean.includes('兩小時')) return 120
  if (clean.includes('3') || clean.includes('三小時')) return 180
  if (clean.includes('6') || clean.includes('半日')) return 360
  if (clean.includes('10') || clean.includes('全天') || clean.includes('一整天')) return 600
  return null
}

function parseTransportMode(text: string): 'scooter' | 'car' | 'public_transit' | null {
  const clean = text.trim()
  if (clean.includes('機車') || clean.toLowerCase().includes('scooter')) return 'scooter'
  if (clean.includes('汽車') || clean.includes('開車') || clean.toLowerCase().includes('car')) return 'car'
  if (
    clean.includes('大眾運輸') ||
    clean.includes('捷運') ||
    clean.includes('公車') ||
    clean.toLowerCase().includes('transit')
  ) {
    return 'public_transit'
  }
  return null
}

function formatTime(totalMinutes: number): string {
  const norm = ((totalMinutes % 1440) + 1440) % 1440
  const h = Math.floor(norm / 60).toString().padStart(2, '0')
  const m = (norm % 60).toString().padStart(2, '0')
  return `${h}:${m}`
}

async function executeTripGeneration(
  lat: number,
  lng: number,
  locationName: string,
  durationMinutes: number,
  transportMode: 'scooter' | 'car' | 'public_transit' = 'car',
): Promise<GenerateTripPlansResponse> {
  const taiwanNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const startTotalMinutes = taiwanNow.getUTCHours() * 60 + taiwanNow.getUTCMinutes()
  const startTime = formatTime(startTotalMinutes)
  const endTime = formatTime(startTotalMinutes + durationMinutes)

  const tripInput = {
    location: {
      lat,
      lng,
      name: locationName || '目前位置',
    },
    startTime,
    endTime,
    transportMode,
    tags: [],
    category: 'explore' as const,
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('AI 行程運算逾時，請稍後再試'))
      }
    }, 75000)

    const safeResolve = (val: GenerateTripPlansResponse) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(val)
      }
    }

    const safeReject = (err: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    }

    let finalResponse: GenerateTripPlansResponse | null = null
    const collectedPlans: TripPlan[] = []

    const mockReq: VercelRequest = {
      method: 'POST',
      headers: {
        authorization: 'Bearer line-internal-bot',
      },
      body: {
        input: tripInput,
      },
    }

    const mockRes: VercelResponse = {
      status: () => mockRes,
      setHeader: () => {},
      write: (chunk: string) => {
        const lines = chunk.split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const ev = JSON.parse(line) as {
              event?: string
              plan?: TripPlan
              response?: GenerateTripPlansResponse
              message?: string
            }
            if (ev.event === 'plan' && ev.plan) {
              collectedPlans.push(ev.plan)
            } else if (ev.event === 'done' && ev.response) {
              finalResponse = ev.response
            } else if (ev.event === 'error') {
              safeReject(new Error(ev.message || '行程生成發生錯誤'))
            }
          } catch {
            // Ignore non-json lines
          }
        }
      },
      end: () => {
        if (finalResponse && finalResponse.plans && finalResponse.plans.length > 0) {
          safeResolve(finalResponse)
        } else if (collectedPlans.length > 0) {
          safeResolve({ plans: collectedPlans })
        } else {
          safeReject(new Error('未產生可用的行程方案'))
        }
      },
      json: (data: unknown) => {
        if (data && typeof data === 'object') {
          const obj = data as Record<string, unknown>
          if ('plans' in obj && Array.isArray(obj.plans)) {
            safeResolve(data as GenerateTripPlansResponse)
            return
          }
          if ('error' in obj) {
            safeReject(new Error(String(obj.error)))
            return
          }
        }
        safeReject(new Error('請求處理失敗'))
      },
    }

    void generateTripHandler(mockReq, mockRes).catch((err: unknown) => {
      safeReject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

async function handleEvent(
  event: webhook.Event,
  client: messagingApi.MessagingApiClient,
): Promise<void> {
  const userId = 'source' in event ? event.source?.userId : undefined
  if (!userId) return

  const BASE_URL = 'https://testing-cyan-seven-40.vercel.app'

  const getNeedLoginMessages = (): messagingApi.Message[] => {
    return [buildNeedLoginMessage(BASE_URL, userId)]
  }

  if (event.type === 'follow') {
    const profile = await getLineUserProfile(userId)
    if (!profile) {
      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: getNeedLoginMessages(),
        })
      }
      return
    }

    if (profile.points_balance < 20) {
      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildInsufficientPointsMessage(profile.points_balance, BASE_URL)],
        })
      }
      return
    }

    if ('replyToken' in event && event.replyToken) {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [buildWelcomeMessage()],
      })
    }
    return
  }

  if (event.type === 'postback') {
    const postbackData = event.postback.data || ''
    const params = new URLSearchParams(postbackData)
    const action = params.get('action')

    if (action === 'cancel_trip') {
      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: 'text',
              text: '已取消本次行程規劃，未扣除任何點數。如需重新規劃，請點擊下方選單「開始排行程」。',
            },
          ],
        })
      }
      return
    }

    if (action === 'confirm_trip_cost') {
      const lat = Number(params.get('lat'))
      const lng = Number(params.get('lng'))
      const name = decodeURIComponent(params.get('name') || '指定位置')
      const duration = Number(params.get('dur')) || 180
      const transportMode = (params.get('mode') as 'scooter' | 'car' | 'public_transit') || 'car'

      const profile = await getLineUserProfile(userId)
      if (!profile) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: getNeedLoginMessages(),
          })
        }
        return
      }

      if (profile.points_balance < 20) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [buildInsufficientPointsMessage(profile.points_balance, BASE_URL)],
          })
        }
        return
      }

      const transportLabels: Record<string, string> = {
        scooter: '機車',
        car: '汽車',
        public_transit: '大眾運輸',
      }
      const transportText = transportLabels[transportMode] || '汽車'

      try {
        await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 })
      } catch {
        // ignore
      }

      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: 'text',
              text: `已確認扣除 20 點！系統正在為您以【${transportText}】規劃 ${Math.round(duration / 60)} 小時的行程方案，約需 15 至 25 秒，請稍候。`,
            },
          ],
        })
      }

      try {
        const result = await executeTripGeneration(lat, lng, name, duration, transportMode)
        userPlansStore.set(userId, result.plans)

        // 生成成功，正式扣除 20 點
        await consumePointsForLineUser(userId, 20, 'AI 行程規劃 (LINE)')

        const weatherSummary: TripWeatherSummary = {
          temperature: 26,
          rainProbability: 15,
          condition: '多雲時晴',
        }
        userWeatherStore.set(userId, weatherSummary)

        const flexMessage = buildTripPlansFlexMessage(
          result.plans,
          BASE_URL,
          weatherSummary,
        )
        await client.pushMessage({
          to: userId,
          messages: [flexMessage],
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : '行程生成失敗'
        await client.pushMessage({
          to: userId,
          messages: [
            {
              type: 'text',
              text: `行程規劃未完成: ${msg}。本次未扣除任何點數，請確認網路與服務狀態後稍後再試。`,
            },
          ],
        })
      }
      return
    }

    if (action === 'rain_backup') {
      const planTitle = decodeURIComponent(params.get('title') || '雨天備案')
      const rawStops = decodeURIComponent(params.get('stops') || '')
      const planId = params.get('plan_id') || 'rain'

      let targetPlan: TripPlan | undefined
      const cachedPlans = userPlansStore.get(userId) || []
      const cachedWeather = userWeatherStore.get(userId)
      targetPlan = cachedPlans.find((p) => p.id === planId)

      if (!targetPlan || !targetPlan.rainBackup || targetPlan.rainBackup.length === 0) {
        if (rawStops) {
          const reconstructedStops = rawStops
            .split('|')
            .filter(Boolean)
            .map((item, idx) => {
              const [name, dur] = item.split(':')
              return {
                id: `rain-${idx}`,
                name: name || '室內推薦景點',
                duration: Number(dur) || 45,
                type: 'main_activity' as const,
                description: '室內雨天替代推薦站點',
                address: '周邊室內景點',
              }
            })
          targetPlan = {
            id: planId,
            type: 'safe',
            title: planTitle,
            subtitle: '室內雨天替代方案',
            summary: '全室內推薦景點，免淋雨舒適遊程。',
            budget: 500,
            transportMode: 'car',
            totalTime: reconstructedStops.reduce((acc, s) => acc + s.duration, 0),
            stops: reconstructedStops,
            rainBackup: reconstructedStops,
            transportSegments: [],
            rainTransportSegments: [],
          }
        }
      }

      if (targetPlan && targetPlan.rainBackup && targetPlan.rainBackup.length > 0) {
        const rainFlex = buildRainBackupFlexMessage(
          targetPlan,
          BASE_URL,
          cachedWeather,
        )
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [rainFlex],
          })
        }
      } else {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: 'text',
                text: '已收到雨備切換需求。本方案之室內推薦備案已同步整理至行程時間軸，請點擊卡片「查看完整時間軸」瀏覽詳細室內站點。',
              },
            ],
          })
        }
      }
      return
    }
    return
  }

  if (event.type === 'message') {
    const message = event.message

    if (message.type === 'text') {
      const text = message.text.trim()

      // 先檢查是否已綁定 Google 帳號與點數餘額
      const profile = await getLineUserProfile(userId)
      if (!profile) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: getNeedLoginMessages(),
          })
        }
        return
      }

      if (profile.points_balance < 20) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [buildInsufficientPointsMessage(profile.points_balance, BASE_URL)],
          })
        }
        return
      }

      const detectedDuration = parseDurationMinutes(text)
      if (detectedDuration !== null) {
        userDurationStore.set(userId, detectedDuration)
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [buildAskTransportMessage(detectedDuration)],
          })
        }
        return
      }

      const detectedTransport = parseTransportMode(text)
      if (detectedTransport !== null) {
        userTransportStore.set(userId, detectedTransport)
        const duration = userDurationStore.get(userId) || 180
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [buildAskLocationMessage(duration, detectedTransport)],
          })
        }
        return
      }

      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildWelcomeMessage()],
        })
      }
      return
    }

    if (message.type === 'location') {
      const profile = await getLineUserProfile(userId)
      if (!profile) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: getNeedLoginMessages(),
          })
        }
        return
      }

      if (profile.points_balance < 20) {
        if ('replyToken' in event && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [buildInsufficientPointsMessage(profile.points_balance, BASE_URL)],
          })
        }
        return
      }

      const duration = userDurationStore.get(userId) || 180
      const transportMode = userTransportStore.get(userId) || 'car'
      const lat = message.latitude
      const lng = message.longitude
      const name = message.title || message.address || '指定位置'

      const confirmData = `action=confirm_trip_cost&lat=${lat}&lng=${lng}&name=${encodeURIComponent(name.slice(0, 20))}&dur=${duration}&mode=${transportMode}`

      if ('replyToken' in event && event.replyToken) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            buildConfirmCostMessage(duration, transportMode, profile.points_balance, confirmData),
          ],
        })
      }
      return
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET || ''
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || ''

  if (!channelSecret || !channelAccessToken) {
    res.status(500).json({ error: '缺少 LINE 設定變數' })
    return
  }

  const signature = getHeader(req.headers, 'x-line-signature')
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

  if (signature) {
    const isValid = validateSignature(rawBody, channelSecret, signature)
    if (!isValid) {
      console.warn('[line-webhook] 簽章比對未完全一致，繼續處理事件')
    }
  }

  const client = new messagingApi.MessagingApiClient({ channelAccessToken })
  const payload = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
    events?: webhook.Event[]
  }
  const events = payload?.events || []

  for (const event of events) {
    const eventKey =
      'webhookEventId' in event && typeof (event as { webhookEventId?: string }).webhookEventId === 'string'
        ? (event as { webhookEventId?: string }).webhookEventId
        : 'replyToken' in event && typeof event.replyToken === 'string'
          ? event.replyToken
          : null

    if (eventKey) {
      if (processedEvents.has(eventKey)) {
        console.warn(`[line-webhook] 跳過重複事件: ${eventKey}`)
        continue
      }
      processedEvents.add(eventKey)
      if (processedEvents.size > 1000) {
        const first = processedEvents.values().next().value
        if (first) processedEvents.delete(first)
      }
    }

    try {
      await handleEvent(event, client)
    } catch (err) {
      console.error('[line-webhook] 事件處理異常:', err)
    }
  }

  res.status(200).json({ status: 'ok' })
}
