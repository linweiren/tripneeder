import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  AnalysisSessionProvider,
} from './contexts/AnalysisSessionContext'
import { AuthProvider } from './contexts/AuthContext'
import { DialogProvider } from './contexts/DialogContext'
import { useAnalysisSession } from './contexts/analysisSession'
import { useAuth } from './contexts/auth'
import './App.css'

const navItems = [
  { to: '/favorites', label: '收藏' },
  { to: '/recent', label: '最近生成' },
  { to: '/points', label: '點數管理' },
]

function App() {
  return (
    <AuthProvider>
      <AnalysisSessionProvider>
        <DialogProvider>
          <AppLayout />
        </DialogProvider>
      </AnalysisSessionProvider>
    </AuthProvider>
  )
}

function AppLayout() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuAreaRef = useRef<HTMLDivElement | null>(null)
  const { plannerPath } = useAnalysisSession()
  const { user, isAuthLoading, signOut } = useAuth()
  const navigate = useNavigate()

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
          Tripneeder
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
