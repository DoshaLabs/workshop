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

/**
 * Dev mode (src/main/devmode.ts): core's window loaded from the repo the app was built from,
 * rebuilt on every save. `unavailable` = an app not built from a checkout (or `npm run dev`, which
 * is live already); `starting` until the first build; `on` with `error` while the last save failed
 * to build (the last good page stays); `error` when the watcher could not start or stopped.
 */
export interface DevMode {
  state: 'unavailable' | 'off' | 'starting' | 'on' | 'error'
  repo?: string
  /** When the window was last rebuilt (epoch ms). */
  builtAt?: number
  error?: string
}

/** One line of scripts/devmode.mjs's output: a build finished, one failed (and why), or neither. */
export function devModeLine(line: string): { built: true } | { failed: string } | null {
  if (line.startsWith('WORKSHOP_DEVMODE_BUILT')) return { built: true }
  if (line.startsWith('WORKSHOP_DEVMODE_ERROR')) return { failed: line.slice('WORKSHOP_DEVMODE_ERROR'.length).trim() || 'the build failed' }
  return null
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
