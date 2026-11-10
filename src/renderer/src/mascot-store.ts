// The mascot in core's window: the active sprite pack, one clock for every sprite on screen, and
// the barks (a Leap played once). Kept out of the components so a session drawn in two places
// (its row and the focus pane's head) leaps in both, and so the clock stops when nothing is
// animating or the window is hidden.

import { useEffect, useSyncExternalStore } from 'react'
import { poseFor, runFor, runMs, tintCoat, type ActiveMascot } from '@shared/mascot'
import type { SessionStatus, SessionsState } from '@shared/sessions'

// ── The active pack ──────────────────────────────────────────────────────────

let active: ActiveMascot | null = null
let workerUrl: string | null = null
const packSubs = new Set<() => void>()

function setActive(m: ActiveMascot | null): void {
  active = m
  workerUrl = m?.worker ?? null
  // One copy of the sheet for every sprite: a CSS variable, not a data: URL in each element's style.
  const root = document.documentElement.style
  if (m) root.setProperty('--mascot-sheet', `url("${m.sheet}")`)
  else root.removeProperty('--mascot-sheet')
  root.setProperty('--mascot-sheet-worker', m ? `url("${workerUrl ?? m.sheet}")` : '')
  if (m && !m.worker) void tinted(m).then((url) => {
    if (active !== m || !url) return
    workerUrl = url
    root.setProperty('--mascot-sheet-worker', `url("${url}")`)
  })
  for (const f of packSubs) f()
}

/** The worker coat drawn from the sheet itself (a pack without a worker sheet of its own). */
async function tinted(m: ActiveMascot): Promise<string | null> {
  const img = new Image()
  img.src = m.sheet
  await img.decode().catch(() => undefined)
  if (!img.naturalWidth) return null
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, c.width, c.height)
  tintCoat(px.data, m.pack.worker?.swap)
  ctx.putImageData(px, 0, 0)
  return c.toDataURL('image/png')
}

export function useActiveMascot(): ActiveMascot | null {
  return useSyncExternalStore(
    (f) => {
      packSubs.add(f)
      return () => void packSubs.delete(f)
    },
    () => active
  )
}

// ── The clock ────────────────────────────────────────────────────────────────

type Drawer = (now: number) => void
const drawers = new Set<Drawer>()
let raf = 0
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

function tick(now: number): void {
  raf = 0
  for (const d of drawers) d(now)
  schedule()
}
function schedule(): void {
  if (raf || drawers.size === 0 || document.hidden) return
  raf = requestAnimationFrame(tick)
}
// A hidden window (minimised, another Space, the app hidden) draws nothing; it picks up where the clock is when it is back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && raf) {
    cancelAnimationFrame(raf)
    raf = 0
  } else schedule()
})

/** Calls `draw` on every animation frame while the window is visible; returns the way to stop. */
export function animate(draw: Drawer): () => void {
  drawers.add(draw)
  draw(performance.now())
  schedule()
  return () => void drawers.delete(draw)
}
export const reducedMotion = (): boolean => reduced.matches

// ── Barks ────────────────────────────────────────────────────────────────────

/** When each session's mascot last started a leap (performance.now()). */
const leaps = new Map<string, number>()
const barkSubs = new Set<(id: string) => void>()
/** Two signals this close together (a hook, then the poll agreeing) are one bark. */
const REBARK_MS = 3000

export function bark(id: string): void {
  const now = performance.now()
  if (now - (leaps.get(id) ?? -Infinity) < REBARK_MS) return
  leaps.set(id, now)
  for (const f of barkSubs) f(id)
}

/** When this session's mascot started its current leap, or null if it is not leaping. */
export function leapingSince(id: string | undefined, now: number): number | null {
  if (!id || !active) return null
  const at = leaps.get(id)
  const leap = runFor(active.pack, 'leap')
  return at !== undefined && leap && now - at < runMs(leap) ? at : null
}

export function useBarks(fn: (id: string) => void): void {
  useEffect(() => {
    barkSubs.add(fn)
    return () => void barkSubs.delete(fn)
  }, [fn])
}

/**
 * The edge detector (deck's useBark): a session leaps the moment it starts needing you, or the
 * moment a turn finishes (busy → idle). Steady states never bark, and nor does the first state
 * the window sees, so a window opening on a column of waiting sessions is quiet.
 */
const seen = new Map<string, { status: SessionStatus; needs: boolean }>()
let primed = false
function watchSessions(s: SessionsState): void {
  for (const v of s.sessions) {
    const needs = poseFor(v.status, v.attention) === 'look'
    const p = seen.get(v.id)
    seen.set(v.id, { status: v.status, needs })
    if (!primed || !p) continue
    if ((needs && !p.needs) || (p.status === 'busy' && v.status === 'idle')) bark(v.id)
  }
  primed = true
}

// Wired once, when the window first imports this module.
void window.core.mascot().then((m) => {
  if (m) setActive(m)
})
window.core.onMascot(setActive)
window.core.onBark(bark)
void window.core.sessions().then(watchSessions)
window.core.onSessions(watchSessions)
