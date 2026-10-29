import type { AnalysisSession } from '../../contexts/analysisSession'
import type { TripInput } from '../../types/trip'
import { sameGenerationInput } from './generationInput.js'

const ANALYSIS_SESSION_STORAGE_KEY = 'tripneeder.analysisSession'
const ANALYSIS_SESSION_TTL_MS = 10 * 60 * 1000

export function getGenerationId(input: TripInput, userId: string, retryId?: string) {
  const previous = loadAnalysisSession(userId)
  return retryId ?? (previous?.status !== 'success' && sameGenerationInput(previous?.input, input)
    ? previous?.generationId : undefined) ?? crypto.randomUUID()
}

export function loadAnalysisSession(userId: string) {
  try {
    const rawSession = localStorage.getItem(`${ANALYSIS_SESSION_STORAGE_KEY}.v2.${userId}`)
    if (!rawSession) return null
    const session = JSON.parse(rawSession) as AnalysisSession

    if (
      !isAnalysisSession(session) ||
      isExpiredSession(session) || session.userId !== userId
    ) {
      clearStoredAnalysisSession(userId)
      return null
    }

    return session
  } catch {
    clearStoredAnalysisSession(userId)
    return null
  }
}

export function saveAnalysisSession(session: AnalysisSession, required = false) {
  if (!session.userId) return
  try { localStorage.setItem(`${ANALYSIS_SESSION_STORAGE_KEY}.v2.${session.userId}`, JSON.stringify(session)) }
  catch { if (required) throw new Error('無法保存生成編號，請允許瀏覽器儲存後再試；本次尚未啟動付費生成。') }
}

export function clearStoredAnalysisSession(userId: string) {
  try { localStorage.removeItem(`${ANALYSIS_SESSION_STORAGE_KEY}.v2.${userId}`) } catch { /* Browser storage unavailable. */ }
}

export function isExpiredSession(session: AnalysisSession) {
  if (session.generationId) return false
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
