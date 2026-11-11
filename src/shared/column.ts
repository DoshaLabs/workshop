// The tile column's state: which tiles are turned off, the extra instances that are on, and the
// height ↕ gave each instance. Kept in core's settings (main/settings.ts), so clearing a profile's
// window storage does not reset the column. It used to live in the window's localStorage; the first
// start that finds none in settings takes what is there once (`legacyColumn`).

import { ID_RE, MAX_SPAN } from './manifest'

export interface ColumnState {
  /** Tiles whose first instance is turned off (tile ids). */
  off: string[]
  /** Second and later instances that are on: `<id>.<n>`, n 2 to 4. */
  extra: string[]
  /** Heights set with ↕, by instance, in rows (1 to MAX_SPAN; a taller one saved before is cut to it). */
  spans: Record<string, number>
  /** The tile column's order, by instance, once a tile has been dragged (shared/order.ts). */
  order?: string[]
  /**
   * The session column's order, by session id, once a session has been dragged. Absent, the column
   * is most recently active first and ⌘1–9 follow the order sessions were started; present, both
   * follow it (shared/sessions.ts shortcutOrder).
   */
  sessions?: string[]
  /** Instances popped out into a float (bridge 1.8), until put back. */
  floating?: string[]
  /**
   * Where each float was dragged to: its top-right corner's offset from the anchor's top-right (the
   * focused session's terminal, else the center column), so it follows the session as the window
   * changes. None yet = the default, FLOAT_DEFAULT.
   */
  floatAt?: Record<string, FloatAt>
}

export interface FloatAt {
  /** Pixels left of the anchor's right edge (positive = inside it). */
  dx: number
  /** Pixels below the anchor's top edge. */
  dy: number
}
/** A float's page is this square, under core's strip (FLOAT_STRIP high). */
export const FLOAT_SIZE = 200
export const FLOAT_STRIP = 26
/** Where a float starts: just inside the active session's top-right corner. */
export const FLOAT_DEFAULT: FloatAt = { dx: 16, dy: 16 }

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
    for (const [k, n] of Object.entries(r.spans as Record<string, unknown>).slice(0, LIMIT)) if (isInstance(k) && Number.isInteger(n) && (n as number) >= 1) spans[k] = Math.min(n as number, MAX_SPAN)
  // The two orders are left out until first saved, so a column without them reads as before.
  const order = Array.isArray(r.order) ? { order: list(r.order, (x): x is string => typeof x === 'string' && isInstance(x)) } : {}
  const sessions = Array.isArray(r.sessions) ? { sessions: list(r.sessions, isSessionId) } : {}
  const floating = Array.isArray(r.floating) ? { floating: list(r.floating, (x): x is string => typeof x === 'string' && isInstance(x)) } : {}
  const at: Record<string, FloatAt> = {}
  const near = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 20_000
  if (r.floatAt && typeof r.floatAt === 'object' && !Array.isArray(r.floatAt))
    for (const [k, v] of Object.entries(r.floatAt as Record<string, unknown>).slice(0, LIMIT)) {
      const o = v as Record<string, unknown> | null
      if (isInstance(k) && o && typeof o === 'object' && near(o.dx) && near(o.dy)) at[k] = { dx: Math.round(o.dx), dy: Math.round(o.dy) }
    }
  const floatAt = r.floatAt !== undefined ? { floatAt: at } : {}
  return { off: list(r.off, isId), extra: list(r.extra, isExtra), spans, ...order, ...sessions, ...floating, ...floatAt }
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

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where a float's box (strip and page, FLOAT_SIZE wide, FLOAT_STRIP + FLOAT_SIZE high) goes: its
 * top-right corner `at` from the anchor's top-right, kept wholly inside `bounds` (the window below
 * the top bar), so a float dragged off an edge, or left there by a smaller window, comes back.
 */
export function placeFloat(anchor: Rect, at: FloatAt, bounds: Rect): { left: number; top: number } {
  const w = FLOAT_SIZE
  const h = FLOAT_STRIP + FLOAT_SIZE
  const left = anchor.right - at.dx - w
  const top = anchor.top + at.dy
  return {
    left: Math.round(Math.min(Math.max(left, bounds.left), Math.max(bounds.left, bounds.right - w))),
    top: Math.round(Math.min(Math.max(top, bounds.top), Math.max(bounds.top, bounds.bottom - h)))
  }
}

/** The offset to keep for a float whose box is at `left`, `top` (the inverse of placeFloat). */
export function floatOffset(anchor: Rect, left: number, top: number): FloatAt {
  return { dx: Math.round(anchor.right - left - FLOAT_SIZE), dy: Math.round(top - anchor.top) }
}
