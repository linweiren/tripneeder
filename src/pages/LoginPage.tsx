import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'
import loginBgCorner from '../assets/mascot/login-bg-corner.png'
import loginBgLeaves from '../assets/mascot/login-bg-leaves.png'
import loginEmblem from '../assets/mascot/login-emblem.png'
import loginLock from '../assets/mascot/login-lock.png'

export function LoginPage() {
  const location = useLocation()
  const { user, isAuthLoading, isSupabaseReady, signInWithGoogle } = useAuth()
  const dialog = useDialog()
  const redirectTo = getRedirectPath(location.state)

  async function handleGoogleLogin() {
    try {
      await signInWithGoogle()
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

  if (user) {
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
          />

          <h1 id="login-title">登入 TripNeeder</h1>

          <div className="login-divider" aria-hidden="true">
            <span />
            <i />
            <span />
          </div>

          <p>
            登入後即可使用 AI 產生行程，
            <br />
            並查看收藏、最近生成與點數。
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
