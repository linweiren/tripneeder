import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Resolve ordinary repositories and worktree gitdir/commondir pointers without
// starting a subprocess. Packed refs are common in CI checkouts.
export function readGitRevision(cwd = process.cwd()): string {
  try {
    const marker = join(cwd, '.git')
    const gitDir = statSync(marker).isDirectory() ? marker : resolve(cwd, readFileSync(marker, 'utf8').trim().replace(/^gitdir:\s*/, ''))
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[a-f0-9]{40}$/i.test(head)) return head
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1]
    if (!ref) return 'unknown'
    let commonDir = gitDir
    try { commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()) } catch { /* ordinary repository */ }
    for (const dir of [gitDir, commonDir]) {
      try {
        const value = readFileSync(join(dir, ref), 'utf8').trim()
        if (/^[a-f0-9]{40}$/i.test(value)) return value
      } catch { /* try shared/packed refs */ }
      try {
        for (const line of readFileSync(join(dir, 'packed-refs'), 'utf8').split(/\r?\n/)) {
          const [value, name] = line.split(' ')
          if (name === ref && /^[a-f0-9]{40}$/i.test(value)) return value
        }
      } catch { /* no packed refs */ }
    }
    return 'unknown'
  } catch { return 'unknown' }
}
