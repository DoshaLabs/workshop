// Where core's window opens. The first time it fills the screen's work area (the screen less the
// menu bar and the Dock: not macOS full screen, which takes a Space of its own). After that it
// opens where it was left, unless that place is no longer mostly on a screen (a display unplugged,
// resolution changed); then it fills the screen again.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A saved rectangle as read from settings, or undefined if it is not one. */
export function cleanRect(raw: unknown): Rect | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const n = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= 100_000
  if (!n(r.x, -100_000) || !n(r.y, -100_000) || !n(r.width, 1) || !n(r.height, 1)) return undefined
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/**
 * The window's bounds: `saved` if at least three quarters of it is on one of `areas` (the
 * displays' work areas), clamped to at least `min`; else the whole of `primary`.
 */
export function placeWindow(saved: Rect | undefined, areas: Rect[], primary: Rect, min: { width: number; height: number }): Rect {
  if (saved && areas.some((a) => overlap(saved, a) >= 0.75 * saved.width * saved.height))
    return { ...saved, width: Math.max(saved.width, min.width), height: Math.max(saved.height, min.height) }
  return { ...primary }
}
