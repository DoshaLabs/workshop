// The tile column's state: which tiles are turned off, the extra instances that are on, and the
// height ↕ gave each instance. Kept in core's settings (main/settings.ts), so clearing a profile's
// window storage does not reset the column. It used to live in the window's localStorage; the first
// start that finds none in settings takes what is there once (`legacyColumn`).

import { ID_RE } from './manifest'

export interface ColumnState {
  /** Tiles whose first instance is turned off (tile ids). */
  off: string[]
  /** Second and later instances that are on: `<id>.<n>`, n 2 to 4. */
  extra: string[]
  /** Heights set with ↕, by instance, in rows (1 to 4). */
  spans: Record<string, number>
  /** The tile column's order, by instance, once a tile has been dragged (shared/order.ts). */
  order?: string[]
  /**
   * The session column's order, by session id, once a session has been dragged. Absent, the column
   * is most recently active first and ⌘1–9 follow the order sessions were started; present, both
   * follow it (shared/sessions.ts shortcutOrder).
   */
  sessions?: string[]
}

export const EMPTY_COLUMN: ColumnState = { off: [], extra: [], spans: {} }
/** The keys the window used to keep the column under. */
export const LEGACY_KEYS = { off: 'workshop.off', extra: 'workshop.extra', spans: 'workshop.span' } as const

const LIMIT = 200
const isId = (x: unknown): x is string => typeof x === 'string' && ID_RE.test(x)
const isExtra = (x: unknown): x is string => typeof x === 'string' && /^(.+)\.([2-4])$/.test(x) && ID_RE.test(x.replace(/\.[2-4]$/, ''))
const isInstance = (x: string): boolean => isId(x) || isExtra(x)
const isSessionId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{6}$/.test(x)

/** Only well-formed entries, deduplicated and capped; null if `raw` is not a column at all. */
export function cleanColumn(raw: unknown): ColumnState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const list = (v: unknown, ok: (x: unknown) => x is string): string[] => (Array.isArray(v) ? [...new Set(v.filter(ok))].slice(0, LIMIT) : [])
  const spans: Record<string, number> = {}
  if (r.spans && typeof r.spans === 'object' && !Array.isArray(r.spans))
    for (const [k, n] of Object.entries(r.spans as Record<string, unknown>).slice(0, LIMIT)) if (isInstance(k) && Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 4) spans[k] = n as number
  // The two orders are left out until first saved, so a column without them reads as before.
  const order = Array.isArray(r.order) ? { order: list(r.order, (x): x is string => typeof x === 'string' && isInstance(x)) } : {}
  const sessions = Array.isArray(r.sessions) ? { sessions: list(r.sessions, isSessionId) } : {}
  return { off: list(r.off, isId), extra: list(r.extra, isExtra), spans, ...order, ...sessions }
}

/**
 * Where a new profile's tile column starts: Wikipedia at the top right, the rest after it in the
 * catalog's order (which is the folders' names, so it would otherwise come last).
 */
export const DEFAULT_ORDER: readonly string[] = ['wikipedia']

/**
 * The column a profile starts with when settings has never held one: what the window's old
 * localStorage kept, if anything (an existing profile, left as it was), else a new profile's,
 * Wikipedia first.
 */
export function firstColumn(legacy: ColumnState): ColumnState {
  const used = legacy.off.length > 0 || legacy.extra.length > 0 || Object.keys(legacy.spans).length > 0 || legacy.order !== undefined
  return used ? legacy : { ...legacy, order: [...DEFAULT_ORDER] }
}

/** What the window's localStorage held before the column moved into settings (bad JSON reads as nothing). */
export function legacyColumn(get: (key: string) => string | null): ColumnState {
  const read = (key: string): unknown => {
    try {
      return JSON.parse(get(key) ?? 'null')
    } catch {
      return null
    }
  }
  return cleanColumn({ off: read(LEGACY_KEYS.off), extra: read(LEGACY_KEYS.extra), spans: read(LEGACY_KEYS.spans) }) ?? EMPTY_COLUMN
}
