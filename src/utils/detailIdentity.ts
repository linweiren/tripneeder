export function getPlanDetailStateKey(planId: string, source: string, recordId?: string | null) {
  if (source === 'generated') return `generated:${planId}`
  if (source === 'shared') return `shared:${recordId ?? planId}:${planId}`
  return `${source}:${recordId ?? planId}`
}
