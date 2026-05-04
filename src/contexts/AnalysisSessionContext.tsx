import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { tripPlanner } from '../services/ai'
import { supabase } from '../services/auth/supabaseClient'
import {
  saveRecentGeneratedRecords,
  upgradeRecentGeneratedRecord,
} from '../services/tripRecords/tripRecordService'
import type { TripInput } from '../types/trip'
import {
  clearGeneratedTripFlow,
  loadGeneratedPlans,
  loadInputForDetail,
  loadLastTripInput,
  loadPlanForDetail,
  saveGeneratedPlans,
  updateDetailPlan,
  updateGeneratedPlan,
} from '../utils/tripPlanStorage'
import type { Stop, TransportSegment, TripPlan } from '../types/trip'
import {
  AnalysisSessionContext,
  type AnalysisSession,
  type PlanDetailState,
} from './analysisSession'

const ANALYSIS_SESSION_STORAGE_KEY = 'tripneeder.analysisSession'
const ANALYSIS_SESSION_TTL_MS = 10 * 60 * 1000

export function AnalysisSessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const [session, setSession] = useState<AnalysisSession | null>(() =>
    loadAnalysisSession(),
  )
  const [planDetailStates, setPlanDetailStates] = useState<
    Record<string, PlanDetailState>
  >({})
  const planDetailControllersRef = useRef<Record<string, AbortController>>({})

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

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    const nextSession: AnalysisSession = {
      status: 'analyzing',
      input,
      startedAt,
      updatedAt: startedAt,
      lastRoute: '/',
      warnings: [],
      partialPlans: [],
    }

    setAndStoreSession(nextSession)

    try {
      const { accessToken: token, userId } = await getSessionAuth()
      const response = await tripPlanner.generateTripPlans({
        input,
        accessToken: token,
        signal: controller.signal,
        onPlan: (plan) => {
          if (requestId !== requestIdRef.current) return
          setSession((current) => {
            if (!current || current.status !== 'analyzing') return current
            const nextPartial = [...(current.partialPlans ?? []), plan]
            const nextState = {
              ...current,
              partialPlans: nextPartial,
              updatedAt: getTimestamp(),
            }
            saveAnalysisSession(nextState)
            return nextState
          })
        },
        onWarning: (message) => {
          if (requestId !== requestIdRef.current) return
          setSession((current) => {
            if (!current || current.status !== 'analyzing') return current
            const currentWarnings = current.warnings ?? []
            if (currentWarnings.includes(message)) return current
            const nextState = {
              ...current,
              warnings: [...currentWarnings, message],
              updatedAt: getTimestamp(),
            }
            saveAnalysisSession(nextState)
            return nextState
          })
        },
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
        warnings: response.warnings,
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
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    Object.values(planDetailControllersRef.current).forEach((controller) => {
      controller.abort()
    })
    planDetailControllersRef.current = {}
    setPlanDetailStates({})
    clearStoredAnalysisSession()
    clearGeneratedTripFlow()
    setSession(null)
  }, [])

  const requestPlanDetails = useCallback((planId: string) => {
    if (!planId) return

    const generatedPlan = loadGeneratedPlans().find((plan) => plan.id === planId)
    const detailPlan = loadPlanForDetail(planId)
    const currentPlan = detailPlan || generatedPlan

    if (!currentPlan) {
      setPlanDetailStates((prev) => ({
        ...prev,
        [planId]: {
          status: 'error',
          error: '找不到這個方案資料，請回到最近生成後重新開啟。',
        },
      }))
      return
    }

    if (currentPlan.isDetailComplete) {
      setPlanDetailStates((prev) => {
        if (prev[planId]?.status === 'complete') {
          return prev
        }
        return { ...prev, [planId]: { status: 'complete' } }
      })
      return
    }

    const lastInput = loadLastTripInput()
    const detailInput = loadInputForDetail()
    const input = detailInput || lastInput

    if (!input) {
      setPlanDetailStates((prev) => ({
        ...prev,
        [planId]: {
          status: 'error',
          error: '找不到當初產生這個方案的偏好資料，無法自動補完整細節。',
        },
      }))
      return
    }

    const existingController = planDetailControllersRef.current[planId]
    if (existingController) {
      // Loading already in-flight; no-op. Re-subscribing consumers will pick up
      // the eventual state transition from the original fetch.
      return
    }

    const controller = new AbortController()
    planDetailControllersRef.current[planId] = controller
    setPlanDetailStates((prev) => ({
      ...prev,
      [planId]: { status: 'loading' },
    }))

    void (async () => {
      try {
        const { accessToken, userId } = await getSessionAuth()
        const response = await tripPlanner.completeTripPlanDetails({
          input,
          plan: currentPlan,
          accessToken,
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        updateGeneratedPlan(response.plan)
        updateDetailPlan(response.plan)

        setPlanDetailStates((prev) => ({
          ...prev,
          [planId]: { status: 'complete', completedAt: getTimestamp() },
        }))
        window.dispatchEvent(
          new CustomEvent('tripneeder:planDetailComplete', { detail: { planId } }),
        )

        if (userId) {
          void upgradeRecentGeneratedRecord(response.plan, input, userId).catch(() => {
            // The upgraded plan is already persisted locally; remote sync will retry later.
          })
        }
      } catch (error) {
        if (controller.signal.aborted) return

        setPlanDetailStates((prev) => ({
          ...prev,
          [planId]: {
            status: 'error',
            error:
              error instanceof Error ? error.message : '細節補充失敗，請稍後再試。',
          },
        }))
      } finally {
        if (planDetailControllersRef.current[planId] === controller) {
          delete planDetailControllersRef.current[planId]
        }
      }
    })()
  }, [])

  const getReplacementCandidates = useCallback(async () => {
    const input = loadInputForDetail() ?? loadLastTripInput()
    if (!input) throw new Error('Missing trip input')

    const response = await fetch('/api/get-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })

    if (!response.ok) {
      throw new Error('無法取得候選地點，請稍後再試。')
    }

    return response.json()
  }, [])

  const recomputeTripRoutes = useCallback(
    async (
      stops: Stop[],
      transportMode: TripPlan['transportMode'],
      transportSegments?: TransportSegment[],
    ) => {
      const response = await fetch('/api/recompute-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stops, transportMode, transportSegments }),
      })

      if (!response.ok) {
        throw new Error('交通路線重算失敗，請稍後再試。')
      }

      return response.json()
    },
    [],
  )

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
      planDetailStates,
      requestPlanDetails,
      getReplacementCandidates,
      recomputeTripRoutes,
    }),
    [
      cancelAnalysis,
      getReplacementCandidates,
      isSessionExpired,
      planDetailStates,
      plannerPath,
      recomputeTripRoutes,
      requestPlanDetails,
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
    (typeof value.error === 'undefined' || typeof value.error === 'string') &&
    (typeof value.warnings === 'undefined' ||
      (Array.isArray(value.warnings) &&
        value.warnings.every((warning) => typeof warning === 'string')))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
