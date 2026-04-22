import type { IncomingMessage } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

type LocalApiRequest = {
  method?: string
  body?: unknown
  headers?: { authorization?: string }
  signal?: AbortSignal
}

type LocalApiResponse = {
  status: (code: number) => LocalApiResponse
  json: (payload: unknown) => void
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => void
  end: () => void
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
  }

  if (env.OPENAI_MODEL) {
    process.env.OPENAI_MODEL = env.OPENAI_MODEL
  }

  if (env.GOOGLE_PLACES_API_KEY || env.VITE_GOOGLE_PLACES_API_KEY) {
    process.env.GOOGLE_PLACES_API_KEY =
      env.GOOGLE_PLACES_API_KEY || env.VITE_GOOGLE_PLACES_API_KEY
  }

  if (env.SUPABASE_URL) {
    process.env.SUPABASE_URL = env.SUPABASE_URL
  }

  if (env.SUPABASE_ANON_KEY) {
    process.env.SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY
  }

  return {
    plugins: [react(), localApiPlugin()],
  }
})

function localApiPlugin(): Plugin {
  return {
    name: 'tripneeder-local-api',
    configureServer(server) {
      server.middlewares.use('/api/generate-trip-details', async (req, res) => {
        const { default: handler } = await import('./api/generate-trip-details')
        await handleLocalApiRequest(req, res, handler)
      })

      server.middlewares.use('/api/generate-trip', async (req, res) => {
        const { default: handler } = await import('./api/generate-trip')
        await handleLocalApiRequest(req, res, handler)
      })

      server.middlewares.use('/api/geocode', async (req, res) => {
        const { default: handler } = await import('./api/geocode')
        await handleLocalApiRequest(req, res, handler)
      })
    },
  }
}

async function handleLocalApiRequest(
  req: IncomingMessage,
  res: {
    statusCode: number
    setHeader: (name: string, value: string) => void
    write: (chunk: string) => void
    end: (chunk?: string) => void
    writableEnded: boolean
  },
  handler: (req: LocalApiRequest, res: LocalApiResponse) => Promise<void>,
) {
  const body = await readRequestBody(req)
  const abortController = new AbortController()
  const responseAdapter = {
    status(code: number) {
      res.statusCode = code
      return responseAdapter
    },
    json(payload: unknown) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value)
    },
    write(chunk: string) {
      res.write(chunk)
    },
    end() {
      res.end()
    },
  }

  req.on('aborted', () => {
    abortController.abort()
  })

  await handler(
    {
      method: req.method,
      body,
      headers: {
        authorization: req.headers.authorization,
      },
      signal: abortController.signal,
    },
    responseAdapter,
  )
}

function readRequestBody(req: IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    req.on('error', reject)

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')

      if (!rawBody) {
        resolve(null)
        return
      }

      try {
        resolve(JSON.parse(rawBody))
      } catch {
        resolve(null)
      }
    })
  })
}
