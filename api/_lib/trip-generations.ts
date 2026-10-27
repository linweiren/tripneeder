import { createClient } from '@supabase/supabase-js'
import { observeEvidenceCall } from './trip-acceptance-evidence.js'
import type { GenerateTripPlansResponse } from '../../src/services/ai/types.js'
import type { TripInput } from '../../src/types/trip.js'
export { normalizeGenerationInput as generationInput } from '../../src/services/ai/generationInput.js'

export const isGenerationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export function createGenerationStore() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Generation store unavailable')
  // Never override this client's Authorization with a browser JWT.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => observeEvidenceCall('supabase', () => fetch(input, { ...init, signal: AbortSignal.timeout(10000) })) },
  })
}

export type GenerationClaim = { outcome: 'claimed' | 'running' | 'completed' | 'missing' | 'input_mismatch'
  attemptToken?: string; leaseExpiresAt?: string; response?: GenerateTripPlansResponse }

export async function claimGeneration(store: ReturnType<typeof createGenerationStore>, userId: string, id: string, input: TripInput) {
  const { data, error } = await store.rpc('claim_trip_generation', {
    p_user_id: userId, p_generation_id: id, p_request_input: input,
  })
  if (error || !data) throw new Error('Generation claim unavailable')
  return data as GenerationClaim
}

export async function readGeneration(store: ReturnType<typeof createGenerationStore>, userId: string, id: string) {
  const { data, error } = await store.from('trip_generations')
    .select('generation_id,status,lease_expires_at,response,request_input,created_at,completed_at')
    .eq('user_id', userId).eq('generation_id', id).maybeSingle()
  if (error) throw new Error('Generation status unavailable')
  if (!data) return null
  return { generationId: data.generation_id, status: data.status,
    leaseExpiresAt: data.status === 'running' ? data.lease_expires_at : undefined,
    response: data.status === 'completed' ? data.response as GenerateTripPlansResponse : undefined,
    input: data.status === 'completed' ? data.request_input as TripInput : undefined,
    retryable: data.status === 'running' ? Date.parse(data.lease_expires_at) <= Date.now() : undefined,
    createdAt: data.created_at, completedAt: data.completed_at }
}
