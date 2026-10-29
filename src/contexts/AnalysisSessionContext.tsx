import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { tripPlanner } from '../services/ai'
import { useAuth } from './auth'
import { getPaidGeneration } from '../services/ai/proxyTripPlanner'
import { loadAnalysisSession, saveAnalysisSession, clearStoredAnalysisSession, isExpiredSession, getGenerationId } from '../services/ai/generationSessionStorage'
import { supabase } from '../services/auth/supabaseClient'
import { upsertGenerationPreview } from '../services/ai/generationPreview.js'
import {
  saveRecentGeneratedRecords,
  updateStoredTripRecordById,
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
  type PlanDetailRequestOptions,
  type PlanDetailSource,
  type PlanDetailState,
} from './analysisSession'

export function AnalysisSessionProvider({ children }: { children: ReactNode }) {
  const { user, isAuthLoading } = useAuth()
  const ownerId = user?.id
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const [session, setSession] = useState<AnalysisSession | null>(null)
  const restoredOwnerRef = useRef<string | null>(null)
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

  const startAnalysis = useCallback(async (input: TripInput, retryId?: string) => {
    const requestId = requestIdRef.current + 1
    const startedAt = getTimestamp()
    requestIdRef.current = requestId

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    let nextSession: AnalysisSession = {
      status: 'analyzing',
      input,
      startedAt,
      updatedAt: startedAt,
      lastRoute: '/',
      warnings: [],
      partialPlans: [],
    }

    setSession(nextSession)

    try {
      const { accessToken: token, userId } = await getSessionAuth()
      if (!token || !userId) throw new Error('請登入後繼續。')
      if (requestId !== requestIdRef.current) return
      const generationId = getGenerationId(input, userId, retryId)
      nextSession = { ...nextSession, generationId, userId }
      // Failure to persist must stop BEFORE the paid request.
      saveAnalysisSession(nextSession, true)
      setSession(nextSession)
      const response = await tripPlanner.generateTripPlans({
        generationId,
        input,
        accessToken: token,
        signal: controller.signal,
        onPreview: (preview) => {
          if (requestId !== requestIdRef.current) return
          setSession(current => {
            if (!current || current.status !== 'analyzing') return current
            const nextState = { ...current, previews: upsertGenerationPreview(current.previews ?? [], preview), updatedAt: getTimestamp() }
            saveAnalysisSession(nextState)
            return nextState
          })
        },
        onProgress: (style) => {
          if (requestId !== requestIdRef.current) return
          setSession((current) => {
            if (!current || current.status !== 'analyzing') return current
            const progressStyles = Array.from(new Set([...(current.progressStyles ?? []), style]))
            const nextState = {
              ...current,
              progressStyles,
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
      if (requestId !== requestIdRef.current) return

      const successSession: AnalysisSession = {
        generationId: nextSession.generationId,
        userId: nextSession.userId,
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
        generationId: nextSession.generationId,
        userId: nextSession.userId,
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

  useEffect(() => {
    if (isAuthLoading) return
    if (restoredOwnerRef.current === (ownerId ?? '')) return
    restoredOwnerRef.current = ownerId ?? ''
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    setSession(null)
    if (!ownerId) return
    const saved = loadAnalysisSession(ownerId)
    if (!saved) return
    if (saved.status === 'analyzing' && saved.generationId) void startAnalysis(saved.input, saved.generationId)
    else setSession(saved)
  }, [isAuthLoading, ownerId, startAnalysis])

  const retryAnalysis = useCallback(async () => {
    if (!session) {
      return
    }

    await startAnalysis(session.input, session.generationId)
  }, [session, startAnalysis])

  const restorePaidGeneration = useCallback(async (id: string) => {
    const requestId = ++requestIdRef.current
    abortControllerRef.current?.abort()
    const { accessToken, userId } = await getSessionAuth()
    if (!userId || !accessToken) throw new Error('請先登入。')
    const saved = await getPaidGeneration(id, accessToken)
    if (requestId !== requestIdRef.current) return
    if (saved.status !== 'completed' || !saved.response || !saved.input) throw new Error('這筆行程尚未扣點完成。')
    saveGeneratedPlans(saved.response.plans, saved.input, userId)
    setAndStoreSession({ generationId: id, userId, input: saved.input, status: 'success',
      startedAt: getTimestamp(), updatedAt: getTimestamp(), lastRoute: '/results', warnings: saved.response.warnings })
    navigate('/results')
  }, [navigate, setAndStoreSession])

  const cancelAnalysis = useCallback(() => {
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    Object.values(planDetailControllersRef.current).forEach((controller) => {
      controller.abort()
    })
    planDetailControllersRef.current = {}
    setPlanDetailStates({})
    if (ownerId) clearStoredAnalysisSession(ownerId)
    clearGeneratedTripFlow()
    setSession(null)
  }, [ownerId])

  const requestPlanDetails = useCallback((planId: string, options?: PlanDetailRequestOptions) => {
    if (!planId) return

    const source = options?.source ?? 'generated'
    const stateKey = getPlanDetailStateKey(planId, source, options?.recordId)
    const generatedPlan = loadGeneratedPlans().find((plan) => plan.id === planId)
    const detailPlan = loadPlanForDetail(planId)
    const currentPlan = source === 'generated' ? generatedPlan : detailPlan

    if (!currentPlan) {
      setPlanDetailStates((prev) => ({
        ...prev,
        [stateKey]: {
          status: 'error',
          error: '找不到這個方案資料，請回到最近生成後重新開啟。',
        },
      }))
      return
    }

    if (currentPlan.isDetailComplete) {
      setPlanDetailStates((prev) => {
        if (prev[stateKey]?.status === 'complete') {
          return prev
        }
        return { ...prev, [stateKey]: { status: 'complete' } }
      })
      return
    }

    const lastInput = loadLastTripInput()
    const detailInput = loadInputForDetail()
    const input = source === 'generated' ? lastInput : detailInput

    if (!input) {
      setPlanDetailStates((prev) => ({
        ...prev,
        [stateKey]: {
          status: 'error',
          error: '找不到當初產生這個方案的偏好資料，無法自動補完整細節。',
        },
      }))
      return
    }

    const existingController = planDetailControllersRef.current[stateKey]
    if (existingController) {
      // Loading already in-flight; no-op. Re-subscribing consumers will pick up
      // the eventual state transition from the original fetch.
      return
    }

    const controller = new AbortController()
    planDetailControllersRef.current[stateKey] = controller
    setPlanDetailStates((prev) => ({
      ...prev,
      [stateKey]: { status: 'loading' },
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

        if (source === 'generated') {
          updateGeneratedPlan(response.plan)
        } else {
          updateDetailPlan(response.plan)
        }

        setPlanDetailStates((prev) => ({
          ...prev,
          [stateKey]: { status: 'complete', completedAt: getTimestamp() },
        }))
        window.dispatchEvent(
          new CustomEvent('tripneeder:planDetailComplete', {
            detail: { planId, source, stateKey },
          }),
        )

        if (userId) {
          if (source === 'generated') {
            void upgradeRecentGeneratedRecord(response.plan, input, userId).catch(() => {
              // The upgraded plan is already persisted locally; remote sync will retry later.
            })
          } else if (options?.recordId) {
            const recordKind = source === 'recent' ? 'recent' : 'favorite'
            void updateStoredTripRecordById(
              recordKind,
              options.recordId,
              response.plan,
              input,
              userId,
            ).catch(() => {
              // The upgraded stored record is already reflected in the detail view.
            })
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return

        setPlanDetailStates((prev) => ({
          ...prev,
          [stateKey]: {
            status: 'error',
            error:
              error instanceof Error ? error.message : '細節補充失敗，請稍後再試。',
          },
        }))
      } finally {
        if (planDetailControllersRef.current[stateKey] === controller) {
          delete planDetailControllersRef.current[stateKey]
        }
      }
    })()
  }, [])

  const getReplacementCandidates = useCallback(async (requestInput?: TripInput | null) => {
    const input = requestInput ?? loadLastTripInput()
    if (!input) throw new Error('Missing trip input')

    const { accessToken } = await getSessionAuth()
    const response = await fetch('/api/get-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
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
      const { accessToken } = await getSessionAuth()
      const response = await fetch('/api/recompute-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
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

  const visibleSession = session?.userId && session.userId !== ownerId ? null : session
  const isSessionExpired = Boolean(visibleSession && isExpiredSession(visibleSession))
  const plannerPath = useMemo(() => {
    if (!visibleSession || isSessionExpired) {
      return '/'
    }

    return visibleSession.lastRoute
  }, [isSessionExpired, visibleSession])

  const value = useMemo(
    () => ({
      session: isSessionExpired ? null : visibleSession,
      plannerPath,
      isSessionExpired,
      startAnalysis,
      retryAnalysis,
      restorePaidGeneration,
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
      restorePaidGeneration,
      visibleSession,
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

function getPlanDetailStateKey(
  planId: string,
  source: PlanDetailSource,
  recordId?: string | null,
) {
  return source === 'generated'
    ? `generated:${planId}`
    : `${source}:${recordId ?? planId}`
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

function getTimestamp() { return Date.now() }
