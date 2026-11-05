import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  AnalysisSessionProvider,
} from './contexts/AnalysisSessionContext'
import { AuthProvider } from './contexts/AuthContext'
import { DialogProvider } from './contexts/DialogContext'
import { useAnalysisSession } from './contexts/analysisSession'
import { useAuth } from './contexts/auth'
import mascotMain from './assets/mascot/mascot-main.webp'
import './App.css'

const navItems = [
  { to: '/persona', label: '個性化設定' },
  { to: '/favorites', label: '收藏' },
  { to: '/community', label: '旅人分享' },
  { to: '/recent', label: '最近生成' },
  { to: '/points', label: '點數管理' },
]

function App() {
  const [isSplashVisible, setIsSplashVisible] = useState(true)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIsSplashVisible(false)
    }, 1500)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <AuthProvider>
      <AnalysisSessionProvider>
        <DialogProvider>
          {isSplashVisible ? <SplashScreen /> : <AppLayout />}
        </DialogProvider>
      </AnalysisSessionProvider>
    </AuthProvider>
  )
}

function SplashScreen() {
  return (
    <main className="splash-screen" aria-label="TripNeeder 開機畫面">
      <div className="splash-stage">
        <img
          className="splash-mascot"
          src={mascotMain}
          alt="TripNeeder 奶油白旅行貓吉祥物"
          width="640"
          height="640"
          decoding="async"
          loading="eager"
        />
        <div className="splash-wordmark" aria-label="TripNeeder">
          TripNeeder
        </div>
        <div className="splash-progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </main>
  )
}

function getPendingLineBind(): { line_user_id: string; ts: string | number; sig: string } | null {
  try {
    const urlParams = new URLSearchParams(window.location.search)
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

function AppLayout() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuAreaRef = useRef<HTMLDivElement | null>(null)
  const { plannerPath } = useAnalysisSession()
  const { user, isAuthLoading, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // 1. Intercept LINE binding parameters and save to localStorage + Cookie
  useEffect(() => {
    const pending = getPendingLineBind()
    if (pending) {
      const payload = JSON.stringify(pending)
      try {
        localStorage.setItem('tripneeder.pendingLineBind', payload)
        document.cookie = `tripneeder_pending_line=${encodeURIComponent(payload)}; path=/; max-age=900; SameSite=Lax`
      } catch {
        // ignore storage write error
      }
    }
  }, [location.search])

  // 2. If on root route '/' (or any route other than /login) but has pending LINE bind, navigate to /login
  useEffect(() => {
    if (location.pathname === '/login') return
    const pending = getPendingLineBind()
    if (pending?.line_user_id) {
      navigate('/login', { replace: true })
    }
  }, [location.pathname, navigate])

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  useEffect(() => {
    if (!isMenuOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        menuAreaRef.current?.contains(event.target)
      ) {
        return
      }

      setIsMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isMenuOpen])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="menu-area" ref={menuAreaRef}>
          <button
            className="menu-button"
            type="button"
            aria-label={isMenuOpen ? '關閉選單' : '開啟選單'}
            aria-expanded={isMenuOpen}
            aria-controls="main-menu"
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            <span />
            <span />
            <span />
          </button>

          {isMenuOpen ? (
            <nav id="main-menu" className="app-nav" aria-label="主要導覽">
              <NavLink
                to={plannerPath}
                className={({ isActive }) =>
                  isActive ? 'nav-link nav-link-active' : 'nav-link'
                }
                onClick={() => setIsMenuOpen(false)}
              >
                行程規劃
              </NavLink>
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? 'nav-link nav-link-active' : 'nav-link'
                  }
                  onClick={() => setIsMenuOpen(false)}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          ) : null}
        </div>

        <NavLink to={plannerPath} className="brand" aria-label="回到行程規劃">
          TripNeeder
        </NavLink>

        <div className="auth-actions">
          {user ? (
            <button
              className="auth-button"
              type="button"
              onClick={() => void handleSignOut()}
            >
              登出
            </button>
          ) : (
            <NavLink
              className="auth-button auth-link"
              to="/login"
              aria-disabled={isAuthLoading}
            >
              登入
            </NavLink>
          )}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

    </div>
  )
}

export default App
