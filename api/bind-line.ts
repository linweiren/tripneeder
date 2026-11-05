import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

type VercelRequest = {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
}

type VercelResponse = {
  status: (code: number) => VercelResponse
  json: (body: unknown) => void
  setHeader: (name: string, value: string) => void
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const authHeader = req.headers?.authorization
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader
  const accessToken = token?.startsWith('Bearer ') ? token.slice(7).trim() : ''

  if (!accessToken) {
    res.status(401).json({ error: '請先登入 Google 帳號' })
    return
  }

  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
    line_user_id?: string
    ts?: number | string
    sig?: string
    action?: 'bind' | 'unbind'
  }

  const lineUserId = body?.line_user_id?.trim()
  const action = body?.action || 'bind'

  const ACTIVE_SUPABASE_URL = 'https://jaxlqqctnnbfritxkkpy.supabase.co'
  const ACTIVE_SUPABASE_ANON_KEY = 'sb_publishable_4iJp5JFnksDVX7STPw05nA_aNNFVznK'
  const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  const isLegacyDeadProject = rawUrl.includes('hscnfrjtjdifhnadnlye') || rawUrl.includes('your-project-ref')

  const supabaseUrl = !rawUrl.trim() || isLegacyDeadProject ? ACTIVE_SUPABASE_URL : rawUrl
  const supabaseAnonKey =
    !isLegacyDeadProject && (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)
      ? (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '')
      : ACTIVE_SUPABASE_ANON_KEY
  const supabaseServiceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    supabaseAnonKey

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: 'Supabase 環境變數未設定' })
    return
  }

  // 使用用戶 Token 驗證真實身分
  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  })
  const { data: userData, error: authError } = await authClient.auth.getUser(accessToken)

  if (authError || !userData?.user) {
    res.status(401).json({ error: '無效的使用者憑證，請重新登入 Google 帳號' })
    return
  }

  const userId = userData.user.id

  // 使用特權 Client 操作已限制 service_role 的 RPC
  const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  try {
    if (action === 'unbind') {
      let unbindResult = await adminClient.rpc('unbind_line_user', {
        p_user_id: userId,
      })
      if (unbindResult.error) {
        const fallback = await userClient.rpc('unbind_line_user')
        if (!fallback.error) unbindResult = fallback
      }

      if (unbindResult.error) {
        res.status(400).json({ error: unbindResult.error.message || '解除綁定失敗' })
        return
      }
      res.status(200).json({ success: true, message: '已成功解除 LINE 帳號綁定' })
      return
    }

    if (!lineUserId) {
      res.status(400).json({ error: '缺少 LINE 使用者識別碼' })
      return
    }

    const secret = process.env.LINE_CHANNEL_SECRET || 'tripneeder-line-secret'
    const reqTs = Number(body.ts)
    const sig = body.sig || ''

    if (!reqTs || Math.abs(Date.now() - reqTs) > 15 * 60 * 1000) {
      res.status(400).json({ error: '綁定連結已逾時失效，請重新在 LINE 點擊「開始排行程」取得最新連結。' })
      return
    }

    const expectedSig = createHmac('sha256', secret).update(`${lineUserId}:${reqTs}`).digest('hex')
    if (expectedSig !== sig) {
      res.status(403).json({ error: '無效的綁定簽章，請使用由 TripNeeder 官方帳號發送的專屬連結。' })
      return
    }

    let bindResult = await adminClient.rpc('bind_line_user', {
      p_user_id: userId,
      p_line_user_id: lineUserId,
    })
    if (bindResult.error) {
      const fallback1 = await userClient.rpc('bind_line_user', {
        p_user_id: userId,
        p_line_user_id: lineUserId,
      })
      if (!fallback1.error) {
        bindResult = fallback1
      } else {
        const fallback2 = await userClient.rpc('bind_line_user', {
          p_line_user_id: lineUserId,
        })
        if (!fallback2.error) bindResult = fallback2
      }
    }

    if (bindResult.error) {
      const errMsg = bindResult.error.message || '綁定失敗'
      if (errMsg.includes('permission denied') || errMsg.includes('Invalid API key') || errMsg.includes('JWT')) {
        res.status(500).json({ error: `資料庫金鑰需更新 (${errMsg})：請在 Vercel 環境變數將 SUPABASE_SERVICE_ROLE_KEY 更新為組長目前 Supabase (jaxlqqctnnbfritxkkpy) 的 service_role 金鑰。` })
        return
      }
      res.status(400).json({ error: errMsg })
      return
    }

    res.status(200).json({ success: true, message: '成功綁定 LINE 帳號' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '伺服器處理失敗' })
  }
}
