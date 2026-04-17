import type { IncomingMessage } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
  }

  if (env.OPENAI_MODEL) {
    process.env.OPENAI_MODEL = env.OPENAI_MODEL
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
      server.middlewares.use('/api/generate-trip', async (req, res) => {
        const { default: handler } = await import('./api/generate-trip')
        const body = await readRequestBody(req)

        await handler(
          {
            method: req.method,
            body,
            headers: {
              authorization: req.headers.authorization,
            },
          },
          {
            status(code) {
              res.statusCode = code
              return this
            },
            json(payload) {
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify(payload))
            },
            setHeader(name, value) {
              res.setHeader(name, value)
            },
          },
        )
      })
    },
  }
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
