// The trusted tier's wire: the messages between core (main/backend.ts) and a built-in tile's
// backend (main/backend-host.ts, which runs the tile's backend.mjs), and the rules both sides keep.
// No electron here, so the unit tests run it as it ships. CLAUDE.md §5 "Two trust tiers".
//
// core → backend   { type: 'call', id, op, body }        one request; `id` is core's, answered once
//                  { type: 'sessions', sessions }         on start, and on every change
// backend → core   { type: 'ready', ops }                 the tile's module has loaded and registered `ops`
//                  { type: 'reply', id, ok: true, result } | { type: 'reply', id, ok: false, error }
//                  { type: 'fatal', error }               it could not start; it exits next
//
// Bodies and results are plain JSON. The backend is never sent a session's token, the door's port
// or WORKSHOP_AUTH: what it knows of the sessions is the list below, and it cannot type into one.

/** A session as a backend sees it: enough to find its repository, nothing to act as it. */
export interface BackendSession {
  id: string
  name: string
  /** The folder the session started in. */
  folder: string
  /** The project it belongs to: the repository's root, shared by its worktrees (main/project.ts). */
  root: string
}

export type ToBackend = { type: 'call'; id: number; op: string; body: unknown } | { type: 'sessions'; sessions: BackendSession[] }
export type FromBackend =
  | { type: 'ready'; ops: string[] }
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'fatal'; error: string }

/** The most a page may send in one call. */
export const BODY_MAX = 1024 * 1024
/** The most a backend may answer with (a diff can be large; a page should still page through it). */
export const RESULT_MAX = 8 * 1024 * 1024
const ERROR_MAX = 1000

/**
 * A value as plain JSON, checked: what crosses between a page and a backend is data, never a
 * function, a class or a cycle. Returns the copy, or throws with what was wrong.
 */
export function plainJson(value: unknown, max: number, what: string): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value === undefined ? null : value)
  } catch (err) {
    throw new Error(`${what} is not JSON (${(err as Error).message})`)
  }
  if (json === undefined) throw new Error(`${what} is not JSON`)
  if (json.length > max) throw new Error(`${what} is over ${Math.round(max / 1024)} KB`)
  return JSON.parse(json)
}

/** One message from a backend, checked; null for anything that is not one of ours. */
export function readFromBackend(m: unknown): FromBackend | null {
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  if (r.type === 'ready') return { type: 'ready', ops: Array.isArray(r.ops) ? r.ops.filter((o): o is string => typeof o === 'string') : [] }
  if (r.type === 'fatal') return { type: 'fatal', error: String(r.error ?? 'failed').slice(0, ERROR_MAX) }
  if (r.type === 'reply' && typeof r.id === 'number') {
    return r.ok === true ? { type: 'reply', id: r.id, ok: true, result: r.result } : { type: 'reply', id: r.id, ok: false, error: String(r.error ?? 'failed').slice(0, ERROR_MAX) }
  }
  return null
}

/**
 * When a backend that died is started again: soon at first, then later, then not at all. A run
 * that lasted `STABLE_MS` was not crashing on start, so the count begins again after it.
 */
export const RESTART_DELAYS = [1000, 3000, 10_000]
export const STABLE_MS = 60_000

/** The delay before restart number `crashes` (1-based), or null to give up. */
export function restartDelay(crashes: number, delays: number[] = RESTART_DELAYS): number | null {
  return crashes >= 1 && crashes <= delays.length ? delays[crashes - 1] : null
}

/**
 * The environment a backend gets: not core's (which may hold a session's WORKSHOP_AUTH when core
 * itself runs inside a session, or keys the user exported for something else), only what a
 * program like git or gh needs to find itself, the user's config and the ssh agent. PATH is the
 * login shell's (main/env.ts), so a Homebrew git or gh is found as in Terminal. Nothing named
 * WORKSHOP_ ever passes.
 */
export const BACKEND_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'] as const

export function backendEnv(from: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of BACKEND_ENV) {
    const v = from[k]
    if (typeof v === 'string' && v !== '') env[k] = v
  }
  env.LANG ||= 'en_US.UTF-8'
  return env
}

/** What a tile's backend.mjs is handed: its default export is called with this once, at start. */
export interface BackendKit {
  /** Answer `op` from the page: `fn(body)` returns (or resolves to) plain JSON, or throws. */
  handle(op: string, fn: (body: unknown) => unknown): void
  /** The sessions as last told (empty until the first list arrives). */
  sessions(): BackendSession[]
  /** Called with every new list. Returns a function that stops it. */
  onSessions(fn: (list: BackendSession[]) => void): () => void
}

/**
 * The backend's side of the wire, without the process: `post` sends a message to core, `receive`
 * takes one from it. backend-host.ts plugs these into process.parentPort; the tests call them.
 */
export function createKit(post: (m: FromBackend) => void): { kit: BackendKit; receive(m: unknown): Promise<void>; ready(): void } {
  const handlers = new Map<string, (body: unknown) => unknown>()
  const subs = new Set<(list: BackendSession[]) => void>()
  let list: BackendSession[] = []
  const kit: BackendKit = {
    handle(op, fn) {
      if (typeof op !== 'string' || !op) throw new TypeError('handle(op, fn): op is a string')
      if (typeof fn !== 'function') throw new TypeError('handle(op, fn): fn is a function')
      handlers.set(op, fn)
    },
    sessions: () => list.map((s) => ({ ...s })),
    onSessions(fn) {
      subs.add(fn)
      return () => void subs.delete(fn)
    }
  }
  return {
    kit,
    ready: () => post({ type: 'ready', ops: [...handlers.keys()] }),
    async receive(m) {
      if (!m || typeof m !== 'object') return
      const msg = m as Partial<ToBackend> & Record<string, unknown>
      if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
        list = msg.sessions as BackendSession[]
        for (const fn of subs) {
          try {
            fn(kit.sessions())
          } catch (err) {
            console.error('[backend] onSessions:', err)
          }
        }
        return
      }
      if (msg.type !== 'call' || typeof msg.id !== 'number' || typeof msg.op !== 'string') return
      const id = msg.id
      const fn = handlers.get(msg.op)
      if (!fn) return post({ type: 'reply', id, ok: false, error: `the backend has no handler for "${msg.op}"` })
      try {
        const result = plainJson(await fn(msg.body), RESULT_MAX, 'the answer')
        post({ type: 'reply', id, ok: true, result })
      } catch (err) {
        post({ type: 'reply', id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX) })
      }
    }
  }
}
