import { requireAuthenticatedUser } from './_lib/authenticated-user.js'
import { createGenerationStore, isGenerationId, readGeneration } from './_lib/trip-generations.js'

type Request = { method?: string; url?: string; query?: Record<string, string | string[] | undefined>; headers?: { authorization?: string } }
type Response = { status: (code: number) => Response; json: (body: unknown) => void; end: () => void; setHeader: (name: string, value: string) => void }

export default async function handler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }
  const auth = await requireAuthenticatedUser(req.headers?.authorization, res)
  if (!auth) return
  const params = new URL(req.url || '/', 'http://local.invalid').searchParams
  const id = req.query?.generationId ?? params.get('generationId')
  const offsetValue = req.query?.offset ?? params.get('offset') ?? '0'
  if ((id !== null && id !== undefined && !isGenerationId(id)) || typeof offsetValue !== 'string'
    || !/^\d{1,7}$/.test(offsetValue)) { res.status(400).json({ error: '無效的生成查詢。' }); return }
  try {
    const store = createGenerationStore()
    if (isGenerationId(id)) {
      const generation = await readGeneration(store, auth.userId, id)
      if (!generation) { res.status(404).json({ error: '找不到這筆生成。' }); return }
      res.status(200).json(generation)
      return
    }
    const offset = Number(offsetValue)
    const { data, error } = await store.from('trip_generations')
      .select('generation_id,created_at,completed_at,charged_points')
      .eq('user_id', auth.userId).eq('status', 'completed')
      .order('created_at', { ascending: false }).order('generation_id', { ascending: false }).range(offset, offset + 19)
    if (error) throw error
    res.status(200).json({ generations: data, nextOffset: data.length === 20 ? offset + 20 : null })
  } catch {
    res.status(503).json({ error: '付款狀態暫時無法確認，請稍後查詢原生成紀錄。' })
  }
}
