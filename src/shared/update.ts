// "Install update" (src/main/updates.ts): what the top bar's button shows.

/**
 * Whether the repo the packaged app was built from has changed since: `available` = the top
 * bar's "Install update"; `building` / `installing` while it runs; `error` keeps the reason until
 * the source changes again. Always `none` under `npm run dev` and in smoke runs.
 */
export interface AppUpdate {
  state: 'none' | 'available' | 'building' | 'installing' | 'error'
  fingerprint?: string
  repo?: string
  /** When the running app was built (epoch ms). */
  builtAt?: number
  startedAt?: number
  error?: string
}

/** out/build-info.json, written by scripts/stamp.mjs during `npm run dist`. */
export interface BuildInfo {
  repo: string
  fingerprint: string
  builtAt: number
}

/** A build-info.json's text, if it is one this app can update from; null otherwise (dev, or a broken file). */
export function parseBuildInfo(text: string): BuildInfo | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { repo, fingerprint, builtAt } = raw as Record<string, unknown>
  if (typeof repo !== 'string' || !repo.startsWith('/')) return null
  if (typeof fingerprint !== 'string' || !fingerprint) return null
  return { repo, fingerprint, builtAt: typeof builtAt === 'number' ? builtAt : 0 }
}
