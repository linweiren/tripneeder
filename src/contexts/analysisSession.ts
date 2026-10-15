import { createContext, useContext } from 'react'
import type { Stop, TransportSegment, TripPlan, TripInput } from '../types/trip'
import type { PartialTripPlan } from '../services/ai/types'
import type { NearbyPlaceCandidates } from '../../api/_lib/google-places'

export type AnalysisSessionStatus = 'analyzing' | 'success' | 'error'

export type AnalysisSession = {
  status: AnalysisSessionStatus
  input: TripInput
  startedAt: number
  updatedAt: number
  lastRoute: string
  error?: string
  warnings?: string[]
  partialPlans?: PartialTripPlan[]
}

export type PlanDetailStatus = 'loading' | 'complete' | 'error'
export type PlanDetailSource = 'generated' | 'recent' | 'favorites'

export type PlanDetailRequestOptions = {
  source?: PlanDetailSource
  recordId?: string | null
}

export type PlanDetailState = {
  status: PlanDetailStatus
  error?: string
  completedAt?: number
}

export type AnalysisSessionContextValue = {
  session: AnalysisSession | null
  plannerPath: string
  isSessionExpired: boolean
  startAnalysis: (input: TripInput) => Promise<void>
  retryAnalysis: () => Promise<void>
  cancelAnalysis: () => void
  resetAnalysisFlow: () => void
  setFlowRoute: (route: string) => void
  planDetailStates: Record<string, PlanDetailState>
  requestPlanDetails: (planId: string, options?: PlanDetailRequestOptions) => void
  getReplacementCandidates: (input?: TripInput | null) => Promise<NearbyPlaceCandidates>
  recomputeTripRoutes: (
    stops: Stop[],
    transportMode: TripPlan['transportMode'],
    transportSegments?: TransportSegment[],
  ) => Promise<{
    transportSegments: TransportSegment[]
    totalTime: number
    routesFailed: boolean
  }>
}

export const AnalysisSessionContext =
  createContext<AnalysisSessionContextValue | null>(null)

export function useAnalysisSession() {
  const context = useContext(AnalysisSessionContext)

  if (!context) {
    throw new Error('useAnalysisSession must be used inside AnalysisSessionProvider')
  }

  return context
}
