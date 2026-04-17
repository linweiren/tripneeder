import { createContext, useContext } from 'react'
import type { TripInput } from '../types/trip'

export type AnalysisSessionStatus = 'analyzing' | 'success' | 'error'

export type AnalysisSession = {
  status: AnalysisSessionStatus
  input: TripInput
  startedAt: number
  updatedAt: number
  lastRoute: string
  error?: string
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
