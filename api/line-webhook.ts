/// <reference types="node" />

import { messagingApi, validateSignature, type webhook } from '@line/bot-sdk'
import { completeLineBinding, confirmationSignature, getLineProfile, lineConfig, lineGenerationId } from './_lib/line-security.js'
import { createGenerationStore, isGenerationId, readGeneration } from './_lib/trip-generations.js'
import { consumeApiRateLimit } from './_lib/request-guards.js'
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
import { generateTripForLine } from './generate-trip.js'
import type { GenerateTripPlansResponse } from '../src/services/ai/types.js'
import type { TripPlan } from '../src/types/trip.js'

type VercelRequest = {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
  signal?: AbortSignal
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => void
  end: () => void
}

const getLineUserProfile = getLineProfile

const userDurationStore = new Map<string, number>()
const userTransportStore = new Map<string, 'scooter' | 'car' | 'public_transit'>()


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
  transportMode: 'scooter' | 'car' | 'public_transit',
  lineId: string,
  eventId: string,
  eventTime: number,
  ownerId: string,
): Promise<GenerateTripPlansResponse> {
  const taiwanNow = new Date(eventTime + 8 * 60 * 60 * 1000)
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
    }, 290000)

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


    const mockReq: VercelRequest = {
      method: 'POST',

      body: {
        input: tripInput,
        generationId: eventId,
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
            if (ev.event === 'done' && ev.response) {
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

    void generateTripForLine(mockReq, mockRes, lineId, ownerId).catch((err: unknown) => {
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

  const { baseUrl: BASE_URL } = lineConfig()

  if (event.type === 'accountLink') {
    if (event.link.result !== 'ok') return
    const linked = await completeLineBinding(userId, event.link.nonce)
    if (linked && event.replyToken) await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '帳號連接完成！請點擊「開始排行程」。' }] })
    return
  }

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
    if (!event.replyToken) return
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

    if (action === 'configure_trip') {
      const profile = await getLineUserProfile(userId)
      if (!profile) return
      params.set('action', 'confirm_trip_cost')
      await client.replyMessage({ replyToken: event.replyToken, messages: [buildConfirmCostMessage(Number(params.get('dur')), params.get('mode') || 'car', profile.points_balance, params.toString())] })
      return
    }
    if (action === 'confirm_trip_cost') {
      const lat = Number(params.get('lat'))
      const lng = Number(params.get('lng'))
      const name = params.get('name') || '指定位置'
      const duration = Number(params.get('dur'))
      const requestId = params.get('request') || ''
      const requestedAt = Number(params.get('at'))
      if (!isGenerationId(requestId) || !Number.isFinite(requestedAt) || requestedAt > event.timestamp || ![120,180,360,600].includes(duration) || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('無效的行程確認，請重新分享位置')
      const transportMode = params.get('mode') as 'scooter' | 'car' | 'public_transit'
      if (!['scooter','car','public_transit'].includes(transportMode)) throw new Error('無效的交通方式')

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

      const transportLabels: Record<string, string> = {
        scooter: '機車',
        car: '汽車',
        public_transit: '大眾運輸',
      }
      if (params.get('owner_sig') !== confirmationSignature(userId, profile.id, requestId, String(requestedAt))) throw new Error('帳號連接已變更，請重新分享位置並確認行程')
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
              text: `已確認本次費用為 20 點；生成與保存成功後才會扣點。系統正在為您以【${transportText}】規劃 ${Math.round(duration / 60)} 小時的行程方案，約需 15 至 25 秒，請稍候。`,
            },
          ],
        })
      }

      try {
        const result = await executeTripGeneration(lat, lng, name, duration, transportMode, userId, requestId, requestedAt, profile.id)

        // The shared generation pipeline commits snapshot, balance and ledger atomically.
        const currentProfile = await getLineUserProfile(userId)
        if (currentProfile?.id !== profile.id) throw new Error('帳號連接已變更，請登入網站查看已完成行程')

        const weatherSummary: TripWeatherSummary = { condition: '天氣請至網站查看即時預報' }

        const flexMessage = buildTripPlansFlexMessage(
          result.plans,
          BASE_URL,
          weatherSummary,
          requestId,
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
              text: `行程處理未完成：${msg}。若扣點狀態待確認，請至網站查看已完成行程；請勿重複確認新行程。`,
            },
          ],
        })
      }
      return
    }

    if (action === 'rain_backup') {
      const profile = await getLineUserProfile(userId)
      const id = params.get('generation_id')
      if (!profile || !isGenerationId(id)) return
      const saved = await readGeneration(createGenerationStore(), profile.id, id)
      const plan = saved?.response?.plans.find(p => p.id === params.get('plan_id'))
      if (!plan) throw new Error('找不到此帳號的已完成行程')
      await client.replyMessage({ replyToken: event.replyToken, messages: [buildRainBackupFlexMessage(plan, BASE_URL, undefined, id)] })
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

      const requestId = lineGenerationId(userId + ':' + event.webhookEventId)
      const ownerSig = confirmationSignature(userId, profile.id, requestId, String(event.timestamp))
      const confirmData = `action=confirm_trip_cost&request=${requestId}&at=${event.timestamp}&lat=${lat}&lng=${lng}&dur=${duration}&mode=${transportMode}&owner_sig=${ownerSig}`

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

// Vercel Node request streams are read before accessing its parsed body getter.
export async function readRawLineBody(req: VercelRequest): Promise<Buffer> {
  if (req[Symbol.asyncIterator]) {
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > 1048576) throw new Error('Payload too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  if (typeof req.body === 'string' && Buffer.byteLength(req.body) <= 1048576) return Buffer.from(req.body)
  if (Buffer.isBuffer(req.body) && req.body.length <= 1048576) return req.body
  throw new Error('Raw request body required')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  let config: ReturnType<typeof lineConfig>
  try { config = lineConfig() } catch { res.status(503).json({ error: 'LINE service unavailable' }); return }
  const signature = getHeader(req.headers, 'x-line-signature')
  if (!signature) { res.status(401).json({ error: 'Invalid signature' }); return }
  let raw: Buffer
  try { raw = await readRawLineBody(req) } catch { res.status(400).json({ error: 'Raw body unavailable or too large' }); return }
  if (!validateSignature(raw, config.secret, signature)) { res.status(401).json({ error: 'Invalid signature' }); return }
  let events: webhook.Event[]
  try {
    const payload = JSON.parse(raw.toString('utf8'))
    if (!Array.isArray(payload.events) || payload.events.length > 100) throw new Error('Invalid events')
    events = payload.events
  } catch { res.status(400).json({ error: 'Invalid payload' }); return }
  const client = new messagingApi.MessagingApiClient({ channelAccessToken: config.accessToken })
  try {
    for (const event of events) {
      if (!event || typeof event !== 'object' || !event.source || event.source.type !== 'user') continue
      if (event.type !== 'accountLink' && await consumeApiRateLimit('line-event:' + event.source.userId, 30, 60000) !== 'allowed') continue
      await handleEvent(event, client)
    }
  } catch {
    res.status(503).json({ error: 'Event processing incomplete' }); return
  }
  res.status(200).json({ status: 'ok' })
}
