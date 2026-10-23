/* This module is an application entry point that exports the router, not page components. */
/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import App from './App.tsx'

const DetailPage = lazy(() => import('./pages/DetailPage.tsx').then((module) => ({ default: module.DetailPage })))
const CommunityPage = lazy(() => import('./pages/CommunityPage.tsx').then((module) => ({ default: module.CommunityPage })))
const CommunityMySharesPage = lazy(() => import('./pages/CommunityPage.tsx').then((module) => ({ default: module.CommunityMySharesPage })))
const CommunitySharedTripRedirectPage = lazy(() => import('./pages/CommunityPage.tsx').then((module) => ({ default: module.CommunitySharedTripRedirectPage })))
const FavoritesPage = lazy(() => import('./pages/FavoritesPage.tsx').then((module) => ({ default: module.FavoritesPage })))
const HomePage = lazy(() => import('./pages/HomePage.tsx').then((module) => ({ default: module.HomePage })))
const LoginPage = lazy(() => import('./pages/LoginPage.tsx').then((module) => ({ default: module.LoginPage })))
const PersonaPage = lazy(() => import('./pages/PersonaPage.tsx').then((module) => ({ default: module.PersonaPage })))
const PointsPage = lazy(() => import('./pages/PointsPage.tsx').then((module) => ({ default: module.PointsPage })))
const RecentPage = lazy(() => import('./pages/RecentPage.tsx').then((module) => ({ default: module.RecentPage })))
const ResultsPage = lazy(() => import('./pages/ResultsPage.tsx').then((module) => ({ default: module.ResultsPage })))

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'results', element: <ResultsPage /> },
      { path: 'plans/:planId', element: <DetailPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'community', element: <CommunityPage /> },
      { path: 'community/mine', element: <CommunityMySharesPage /> },
      { path: 'community/:tripId', element: <CommunitySharedTripRedirectPage /> },
      { path: 'recent', element: <RecentPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'points', element: <PointsPage /> },
      { path: 'persona', element: <PersonaPage /> },
    ],
  },
])
