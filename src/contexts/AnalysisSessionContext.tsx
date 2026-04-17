import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { tripPlanner } from '../services/ai'
import { supabase } from '../services/auth/supabaseClient'
import { saveRecentGeneratedRecords } from '../services/tripRecords/tripRecordService'
import type { TripInput } from '../types/trip'
import {
  clearGeneratedTripFlow,
  saveGeneratedPlans,
} from '../utils/tripPlanStorage'
import {
  AnalysisSessionContext,
  type AnalysisSession,
} from './analysisSession'

const ANALYSIS_SESSION_STORAGE_KEY = 'tripneeder.analysisSession'
const ANALYSIS_SESSION_TTL_MS = 10 * 60 * 1000

export function AnalysisSessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  const requestIdRef = useRef(0)
  const [session, setSession] = useState<AnalysisSession | null>(() =>
    loadAnalysisSession(),
  )

  useEffect(() => {
    locationRef.current = location
  }, [location])

  const setAndStoreSession = useCallback((nextSession: AnalysisSession) => {
    saveAnalysisSession(nextSession)
    setSession(nextSession)
  }, [])

  const startAnalysis = useCallback(async (input: TripInput) => {
    const requestId = requestIdRef.current + 1
    const startedAt = getTimestamp()
    requestIdRef.current = requestId

    const nextSession: AnalysisSession = {
      status: 'analyzing',
      input,
      startedAt,
      updatedAt: startedAt,
      lastRoute: '/',
    }

    setAndStoreSession(nextSession)

    try {
      const { accessToken: token, userId } = await getSessionAuth()
      const response = await tripPlanner.generateTripPlans({
        input,
        accessToken: token,
      })

      if (requestId !== requestIdRef.current) {
        return
      }

      if (userId) {
        try {
          await saveRecentGeneratedRecords(response.plans, input, userId)
        } catch {
          // Recent records are already kept in localStorage as a fallback.
        }
      } else {
        saveGeneratedPlans(response.plans, input, userId)
      }

      const successSession: AnalysisSession = {
        status: 'success',
        input,
        startedAt,
        updatedAt: getTimestamp(),
        lastRoute: '/results',
      }

      setAndStoreSession(successSession)

      if (locationRef.current.pathname === '/') {
        navigate('/results')
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return
      }

      const errorSession: AnalysisSession = {
        status: 'error',
        input,
        startedAt,
        updatedAt: getTimestamp(),
        lastRoute: '/',
        error:
          error instanceof Error ? error.message : 'AI 分析失敗，請稍後再試。',
      }

      setAndStoreSession(errorSession)
    }
  }, [navigate, setAndStoreSession])

  const retryAnalysis = useCallback(async () => {
    if (!session) {
      return
    }

    await startAnalysis(session.input)
  }, [session, startAnalysis])

  const cancelAnalysis = useCallback(() => {
    requestIdRef.current += 1
    clearStoredAnalysisSession()
    clearGeneratedTripFlow()
    setSession(null)
  }, [])

  const resetAnalysisFlow = useCallback(() => {
    cancelAnalysis()
    navigate('/')
  }, [cancelAnalysis, navigate])

  const setFlowRoute = useCallback((route: string) => {
    setSession((current) => {
      if (
        !current ||
        current.status !== 'success' ||
        current.lastRoute === route ||
        isExpiredSession(current)
      ) {
        return current
      }

      const nextSession = {
        ...current,
        lastRoute: route,
        updatedAt: getTimestamp(),
      }

      saveAnalysisSession(nextSession)
      return nextSession
    })
  }, [])

  const isSessionExpired = Boolean(session && isExpiredSession(session))
  const plannerPath = useMemo(() => {
    if (!session || isSessionExpired) {
      return '/'
    }

    return session.lastRoute
  }, [isSessionExpired, session])

  const value = useMemo(
    () => ({
      session: isSessionExpired ? null : session,
      plannerPath,
      isSessionExpired,
      startAnalysis,
      retryAnalysis,
      cancelAnalysis,
      resetAnalysisFlow,
      setFlowRoute,
    }),
    [
      cancelAnalysis,
      isSessionExpired,
      plannerPath,
      resetAnalysisFlow,
      retryAnalysis,
      session,
      setFlowRoute,
      startAnalysis,
    ],
  )

  return (
    <AnalysisSessionContext.Provider value={value}>
      {children}
    </AnalysisSessionContext.Provider>
  )
}

async function getSessionAuth() {
  if (!supabase) {
    return {
      accessToken: undefined,
      userId: undefined,
    }
  }

  const { data } = await supabase.auth.getSession()

  return {
    accessToken: data.session?.access_token,
    userId: data.session?.user.id,
  }
}

function loadAnalysisSession() {
  const rawSession = sessionStorage.getItem(ANALYSIS_SESSION_STORAGE_KEY)

  if (!rawSession) {
    return null
  }

  try {
    const session = JSON.parse(rawSession) as AnalysisSession

    if (
      !isAnalysisSession(session) ||
      isExpiredSession(session) ||
      session.status === 'analyzing'
    ) {
      clearStoredAnalysisSession()
      clearGeneratedTripFlow()
      return null
    }

    return session
  } catch {
    clearStoredAnalysisSession()
    return null
  }
}

function saveAnalysisSession(session: AnalysisSession) {
  sessionStorage.setItem(ANALYSIS_SESSION_STORAGE_KEY, JSON.stringify(session))
}

function clearStoredAnalysisSession() {
  sessionStorage.removeItem(ANALYSIS_SESSION_STORAGE_KEY)
}

function isExpiredSession(session: AnalysisSession) {
  return getTimestamp() - session.startedAt > ANALYSIS_SESSION_TTL_MS
}

function getTimestamp() {
  return new Date().getTime()
}

function isAnalysisSession(value: unknown): value is AnalysisSession {
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.status === 'analyzing' ||
      value.status === 'success' ||
      value.status === 'error') &&
    isRecord(value.input) &&
    typeof value.startedAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastRoute === 'string' &&
    (typeof value.error === 'undefined' || typeof value.error === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
