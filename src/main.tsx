import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App.tsx'
import { DetailPage } from './pages/DetailPage.tsx'
import { FavoritesPage } from './pages/FavoritesPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { RecentPage } from './pages/RecentPage.tsx'
import { ResultsPage } from './pages/ResultsPage.tsx'
import './index.css'

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'results', element: <ResultsPage /> },
      { path: 'plans/:planId', element: <DetailPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'recent', element: <RecentPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}
