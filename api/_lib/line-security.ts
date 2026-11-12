import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createGenerationStore } from './trip-generations.js'

export function lineConfig() {
  const secret = process.env.LINE_CHANNEL_SECRET
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const baseUrl = process.env.LINE_APP_URL
  if (!secret || !accessToken || !baseUrl || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('LINE configuration unavailable')
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid LINE app origin')
  return { secret, accessToken, baseUrl: url.origin }
}

export const isLineUserId = (id: unknown): id is string => typeof id === 'string' && /^U[0-9a-f]{32}$/.test(id)

export function bindingSignature(lineId: string, ts: number, secret: string) {
  return createHmac('sha256', secret).update(`bind-v1:${lineId}:${ts}`).digest('hex')
}

export function confirmationSignature(lineId: string, ownerId: string, requestId: string, at: string) {
  return createHmac('sha256', lineConfig().secret).update(`trip-owner-v1:${lineId}:${ownerId}:${requestId}:${at}`).digest('base64url')
}

export function verifyBindingLink(lineId: unknown, ts: unknown, sig: unknown, secret: string) {
  const timestamp = Number(ts)
  if (!isLineUserId(lineId) || !Number.isSafeInteger(timestamp) || timestamp > Date.now() || Date.now() - timestamp > 600000 || typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig)) return false
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(bindingSignature(lineId, timestamp, secret), 'hex'))
}

// Encrypted authenticated nonce contains no readable account IDs. A durable RPC bucket
// consumes it once; it expires before that bucket can reset. No new database objects.
export function createBindingNonce(userId: string, lineId: string, secret: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(`line-link-v1:${secret}`).digest(), iv)
  const payload = JSON.stringify([userId, lineId, Date.now() + 600000])
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function readBindingNonce(nonce: string, lineId: string, secret: string) {
  if (!/^[A-Za-z0-9_-]{10,255}$/.test(nonce)) throw new Error('Invalid nonce')
  const bytes = Buffer.from(nonce, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(`line-link-v1:${secret}`).digest(), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  const [userId, expectedLineId, expires] = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
  if (!/^[a-f0-9-]{36}$/.test(userId) || expectedLineId !== lineId || !Number.isSafeInteger(expires) || expires <= Date.now()) throw new Error('Invalid nonce')
  return userId as string
}

export async function claimBindingNonce(nonce: string) {
  const { data, error } = await createGenerationStore().rpc('consume_api_rate_limit', {
    p_bucket_key: createHash('sha256').update(`line-link-once:${nonce}`).digest('hex'), p_max_requests: 1, p_window_seconds: 3600,
  })
  if (error || typeof data !== 'boolean') throw new Error('Nonce store unavailable')
  return data
}

export async function getLineProfile(lineId: string) {
  if (!isLineUserId(lineId)) throw new Error('Invalid LINE ID')
  const { data, error } = await createGenerationStore().rpc('get_line_user_profile', { p_line_user_id: lineId })
  if (error) throw new Error('LINE profile unavailable')
  if (data === null) return null
  if (!data || typeof data.id !== 'string' || !Number.isInteger(data.points_balance) || data.points_balance < 0) throw new Error('Invalid LINE profile')
  return data as { id: string; points_balance: number }
}

export async function completeLineBinding(lineId: string, nonce: string) {
  const userId = readBindingNonce(nonce, lineId, lineConfig().secret)
  if (!await claimBindingNonce(nonce)) return false
  const { data, error } = await createGenerationStore().rpc('bind_line_user', { p_user_id: userId, p_line_user_id: lineId })
  if (error || data?.success !== true) throw new Error('Binding rejected; request a new link')
  return true
}

export function lineGenerationId(eventId: string) {
  if (!eventId || eventId.length > 200) throw new Error('Missing event identity')
  const h = createHash('sha256').update(`tripneeder-line:${eventId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
