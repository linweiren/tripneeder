import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(() => {
  const env = readLocalEnv()

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_OPENAI_BROWSER_CREDENTIAL': JSON.stringify(
        env.VITE_OPENAI_BROWSER_CREDENTIAL ?? env.VITE_OPENAI_API_KEY ?? '',
      ),
      'import.meta.env.VITE_OPENAI_MODEL': JSON.stringify(
        env.VITE_OPENAI_MODEL ?? 'gpt-4.1-mini',
      ),
    },
  }
})

function readLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(resolve(process.cwd(), '.env'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separatorIndex = line.indexOf('=')
          const key = line.slice(0, separatorIndex).trim()
          const value = line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '')

          return [key, value]
        }),
    )
  } catch {
    return {}
  }
}
