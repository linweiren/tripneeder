import { messagingApi } from '@line/bot-sdk'
import { requireAuthenticatedUser } from './_lib/authenticated-user.js'
import { createGenerationStore } from './_lib/trip-generations.js'
import { createBindingNonce, lineConfig, verifyBindingLink } from './_lib/line-security.js'
import { consumeApiRateLimit } from './_lib/request-guards.js'

type Request = { method?: string; headers?: { authorization?: string }; body?: unknown }
type Response = Parameters<typeof requireAuthenticatedUser>[1]

export default async function handler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method ?? '')) { res.status(405).json({ error: 'Method not allowed' }); return }
  const auth = await requireAuthenticatedUser(req.headers?.authorization, res)
  if (!auth) return
  try {
    const config = lineConfig()
    const store = createGenerationStore()
    if (req.method === 'GET') {
      const { data, error } = await store.from('profiles').select('line_user_id').eq('id', auth.userId).maybeSingle()
      if (error) throw error
      res.status(200).json({ linked: Boolean(data?.line_user_id) }); return
    }
    let body: Record<string, unknown>
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body } catch { res.status(400).json({ error: '無效的請求資料。' }); return }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: '無效的請求資料。' }); return }
    if (!['begin', 'unbind'].includes(String(body.action))) { res.status(400).json({ error: '無效的操作。' }); return }
    if (await consumeApiRateLimit(`line-binding:${auth.userId}`, 6, 60000) !== 'allowed') { res.status(429).json({ error: '操作過於頻繁，請稍後再試。' }); return }
    if (body.action === 'unbind') {
      const { data, error } = await store.rpc('unbind_line_user', { p_user_id: auth.userId })
      if (error || data?.success !== true) throw new Error('Unbind failed')
      res.status(200).json({ success: true }); return
    }
    if (!verifyBindingLink(body.line_user_id, body.ts, body.sig, config.secret)) { res.status(403).json({ error: '綁定連結無效或已過期，請從 LINE 取得新連結。' }); return }
    const lineId = body.line_user_id as string
    const profile = await store.from('profiles').select('id').eq('id', auth.userId).maybeSingle()
    if (profile.error || !profile.data) { res.status(409).json({ error: '請先完成會員資料初始化，再取得新的綁定連結。' }); return }
    const client = new messagingApi.MessagingApiClient({ channelAccessToken: config.accessToken })
    const { linkToken } = await client.issueLinkToken(lineId)
    if (!linkToken) throw new Error('Link token unavailable')
    const nonce = createBindingNonce(auth.userId, lineId, config.secret)
    const url = new URL('https://access.line.me/dialog/bot/accountLink')
    url.searchParams.set('linkToken', linkToken); url.searchParams.set('nonce', nonce)
    res.status(200).json({ url: url.href })
  } catch {
    res.status(503).json({ error: 'LINE 連接服務暫時無法使用，請稍後從 LINE 重新取得連結。' })
  }
}
