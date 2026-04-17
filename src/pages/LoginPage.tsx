import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { useDialog } from '../contexts/dialog'

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
    <section className="page login-page">
      <div className="login-panel">
        <h1 className="page-title">登入 Tripneeder</h1>
        <p className="page-copy">
          登入後可以使用 AI 產生行程，並查看收藏、最近生成與點數。
        </p>

        {!isSupabaseReady ? (
          <p className="auth-config-note">
            尚未設定 Supabase。請在環境變數加入 VITE_SUPABASE_URL 與
            VITE_SUPABASE_ANON_KEY。
          </p>
        ) : null}

        <button
          className="submit-button login-provider-button"
          type="button"
          onClick={() => void handleGoogleLogin()}
          disabled={isAuthLoading || !isSupabaseReady}
        >
          使用 Google 登入
        </button>
      </div>
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
