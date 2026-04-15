import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import './App.css'

const navItems = [
  { to: '/', label: '行程規劃' },
  { to: '/favorites', label: '收藏' },
  { to: '/recent', label: '最近生成' },
]

function App() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="menu-area">
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

        <NavLink to="/" className="brand" aria-label="回到行程規劃">
          Tripneeder
        </NavLink>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}

export default App
