import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import { supabase } from '../services/auth/supabaseClient'
import loginBgCorner from '../assets/mascot/login-bg-corner.webp'
import loginBgLeaves from '../assets/mascot/login-bg-leaves.png'
import loginEmblem from '../assets/mascot/login-emblem.webp'
import loginLock from '../assets/mascot/login-lock.png'

function getPendingLineBind(search?: string): { line_user_id: string; ts: string | number; sig: string } | null {
  try {
    const urlParams = new URLSearchParams(search ?? window.location.search)
    const lineUserId = urlParams.get('line_user_id')
    const ts = urlParams.get('ts')
    const sig = urlParams.get('sig')
    if (lineUserId && ts && sig) {
      return { line_user_id: lineUserId, ts, sig }
    }
  } catch {
    // ignore URL parse error
  }

  try {
    const raw = localStorage.getItem('tripneeder.pendingLineBind')
    if (raw) {
      const parsed = JSON.parse(raw) as { line_user_id?: string; ts?: string | number; sig?: string }
      if (parsed?.line_user_id) return { line_user_id: parsed.line_user_id, ts: parsed.ts || '', sig: parsed.sig || '' }
    }
  } catch {
    // ignore storage access error
  }

  try {
    const match = document.cookie.match(/(?:^|;\s*)tripneeder_pending_line=([^;]+)/)
    if (match?.[1]) {
      const decoded = decodeURIComponent(match[1])
      const parsed = JSON.parse(decoded) as { line_user_id?: string; ts?: string | number; sig?: string }
      if (parsed?.line_user_id) return { line_user_id: parsed.line_user_id, ts: parsed.ts || '', sig: parsed.sig || '' }
    }
  } catch {
    // ignore cookie parse error
  }

  return null
}

function clearPendingLineBind() {
  try {
    localStorage.removeItem('tripneeder.pendingLineBind')
    sessionStorage.removeItem('tripneeder.pendingLineUserId')
    sessionStorage.removeItem('tripneeder.pendingLineTs')
    sessionStorage.removeItem('tripneeder.pendingLineSig')
    document.cookie = 'tripneeder_pending_line=; path=/; max-age=0'
  } catch {
    // ignore cleanup error
  }
}

export function LoginPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthLoading, isSupabaseReady, signInWithGoogle } = useAuth()
  const dialog = useDialog()
  const redirectTo = getRedirectPath(location.state)

  const pendingBind = useMemo(() => getPendingLineBind(location.search), [location.search])
  const [bindStatus, setBindStatus] = useState<'idle' | 'binding' | 'success' | 'error'>('idle')
  const [bindError, setBindError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const hasTriggeredBindRef = useRef(false)

  // Capture params on mount if not yet saved
  useEffect(() => {
    if (pendingBind) {
      const payload = JSON.stringify(pendingBind)
      try {
        localStorage.setItem('tripneeder.pendingLineBind', payload)
        document.cookie = `tripneeder_pending_line=${encodeURIComponent(payload)}; path=/; max-age=900; SameSite=Lax`
      } catch {
        // ignore storage write error
      }
    }
  }, [pendingBind])

  // Execute binding once user is authenticated
  useEffect(() => {
    if (!user || !pendingBind?.line_user_id || hasTriggeredBindRef.current) {
      return
    }

    hasTriggeredBindRef.current = true

    void (async () => {
      try {
        let token = ''
        for (let i = 0; i < 6; i++) {
          const { data } = (await supabase?.auth.getSession()) || {}
          if (data?.session?.access_token) {
            token = data.session.access_token
            break
          }
          await new Promise((r) => setTimeout(r, 350))
        }

        if (!token) {
          hasTriggeredBindRef.current = false
          setBindStatus('error')
          setBindError('無法取得 Google 登入授權憑證，請重新登入後再試。')
          return
        }

        const res = await fetch('/api/bind-line', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            line_user_id: pendingBind.line_user_id,
            ts: pendingBind.ts,
            sig: pendingBind.sig,
          }),
        })

        const resData = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        clearPendingLineBind()

        if (res.ok) {
          setBindStatus('success')
        } else {
          setBindStatus('error')
          setBindError(
            resData.error ||
            '綁定失敗，請確認連結是否過期，並從 LINE 重新發送「開始排行程」取得最新連結。'
          )
        }
      } catch (err) {
        clearPendingLineBind()
        setBindStatus('error')
        setBindError(err instanceof Error ? err.message : '連線伺服器失敗，請稍後再試。')
      }
    })()
  }, [user, pendingBind, retryCount])

  async function handleGoogleLogin() {
    try {
      const p = getPendingLineBind()
      if (p) {
        const payload = JSON.stringify(p)
        try {
          localStorage.setItem('tripneeder.pendingLineBind', payload)
          document.cookie = `tripneeder_pending_line=${encodeURIComponent(payload)}; path=/; max-age=900; SameSite=Lax`
        } catch {
          // ignore storage write error
        }
      }
      await signInWithGoogle(`${window.location.origin}/login`)
    } catch (error) {
      void dialog.alert({
        title: '登入無法啟動',
        message:
          error instanceof Error
            ? error.message
            : '目前無法連線到登入服務，請稍後再試。',
      })
    }
  }

  // If user is already logged in AND has pending bind:
  if (user && pendingBind?.line_user_id) {
    return (
      <section className="login-page">
        <main className="login-main" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', textAlign: 'center', padding: '1.5rem' }}>
          <div style={{ backgroundColor: '#FFFFFF', borderRadius: '1.25rem', padding: '2rem', maxWidth: '420px', width: '100%', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)', border: '1px solid #E5E7EB' }}>
            {bindStatus === 'idle' || bindStatus === 'binding' ? (
              <>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#1F2937', marginBottom: '1rem' }}>
                  正在完成 LINE 帳號綁定
                </h2>
                <p style={{ color: '#4B5563', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                  已確認 Google 登入帳號：<br />
                  <strong style={{ color: '#111827' }}>{user.email}</strong>
                </p>
                <p style={{ color: '#6B7280', fontSize: '0.85rem' }}>
                  系統正在為您安全綁定 LINE 官方帳號，請稍候...
                </p>
              </>
            ) : bindStatus === 'success' ? (
              <>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem', color: '#059669', fontWeight: 700 }}>
                  ✓
                </div>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#059669', marginBottom: '0.75rem' }}>
                  LINE 帳號綁定成功
                </h2>
                <p style={{ color: '#4B5563', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  您的 Google 帳號已成功與 LINE 綁定！<br />
                  現在請返回 LINE 官方帳號，點擊「開始排行程」即可開始規劃。
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/', { replace: true })}
                  style={{ width: '100%', backgroundColor: '#059669', color: '#FFFFFF', padding: '0.85rem', borderRadius: '0.5rem', border: 'none', fontWeight: 600, fontSize: '1rem', cursor: 'pointer' }}
                >
                  前往首頁
                </button>
              </>
            ) : bindStatus === 'error' ? (
              <>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem', color: '#DC2626', fontWeight: 700 }}>
                  ✕
                </div>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#DC2626', marginBottom: '0.75rem' }}>
                  LINE 帳號綁定失敗
                </h2>
                <p style={{ color: '#DC2626', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: '1.5rem', backgroundColor: '#FEF2F2', padding: '0.75rem', borderRadius: '0.5rem' }}>
                  {bindError}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    hasTriggeredBindRef.current = false
                    setBindStatus('binding')
                    setRetryCount((c) => c + 1)
                  }}
                  style={{ width: '100%', backgroundColor: '#1F2937', color: '#FFFFFF', padding: '0.85rem', borderRadius: '0.5rem', border: 'none', fontWeight: 600, fontSize: '1rem', cursor: 'pointer' }}
                >
                  重新嘗試綁定
                </button>
              </>
            ) : null}
          </div>
        </main>
      </section>
    )
  }

  // If already logged in and NO pending bind, go to homepage
  if (user && !pendingBind?.line_user_id) {
    return <Navigate to={redirectTo} replace />
  }

  return (
    <section className="login-page">
      <main className="login-main">
        <img
          className="login-bg-leaves"
          src={loginBgLeaves}
          alt=""
          aria-hidden="true"
        />

        <section className="login-card" aria-labelledby="login-title">
          <img
            className="login-emblem"
            src={loginEmblem}
            alt=""
            aria-hidden="true"
            width="512"
            height="512"
            decoding="async"
            loading="eager"
          />

          <h1 id="login-title">登入 TripNeeder</h1>

          <div className="login-divider" aria-hidden="true">
            <span />
            <i />
            <span />
          </div>

          <p>
            {pendingBind?.line_user_id ? (
              <>
                即將為您的 LINE 帳號完成綁定，
                <br />
                請登入 Google 帳號以啟用行程規劃服務。
              </>
            ) : (
              <>
                登入後即可使用 AI 產生行程，
                <br />
                並查看收藏、最近生成與點數。
              </>
            )}
          </p>

          {!isSupabaseReady ? (
            <p className="auth-config-note">
              尚未設定 Supabase 登入服務，請確認 VITE_SUPABASE_URL 與
              VITE_SUPABASE_ANON_KEY。
            </p>
          ) : null}

          <button
            className="login-google-button"
            type="button"
            onClick={() => void handleGoogleLogin()}
            disabled={isAuthLoading || !isSupabaseReady}
          >
            <span className="login-google-mark" aria-hidden="true">
              G
            </span>
            <span>使用 Google 登入</span>
          </button>
        </section>

        <div className="login-security-note">
          <img
            className="login-lock-icon"
            src={loginLock}
            alt=""
            aria-hidden="true"
          />
          <span>登入安全保護中，您的資料將受到保護</span>
        </div>

        <img
          className="login-bg-corner"
          src={loginBgCorner}
          alt=""
          aria-hidden="true"
          width="1000"
          height="1000"
          decoding="async"
          loading="eager"
        />
      </main>
    </section>
  )
}

function getRedirectPath(state: unknown) {
  if (
    typeof state === 'object' &&
    state !== null &&
    'from' in state &&
    typeof state.from === 'string'
  ) {
    return state.from
  }

  return '/'
}
