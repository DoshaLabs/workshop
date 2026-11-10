// The Knot in core's window: the default status mark on every session (when no sprite pack is
// installed) and the app's own mark in the top bar (CLAUDE.md §8). The drawing and the status
// language are in shared/knot.ts; this file runs them.
//
// There may be twenty of these at once, so they share ONE clock: it wakes only when some visible
// knot is due its next frame (an idle knot wants six a second, a working one thirty), draws
// nothing for a knot that is off screen or while the window is hidden, and under reduced motion
// draws one still frame per change. 2D canvases only: terminals need the WebGL contexts.

import { useEffect, useRef, useState } from 'react'
import { FLARE_MS, MODES, TAU, drawKnot, knotMode, knotPalette, wrapClock, type KnotMode, type KnotPalette, type KnotTheme } from '@shared/knot'
import type { SessionStatus } from '@shared/sessions'
import { useBarks } from './mascot-store'

// ── Theme colours ────────────────────────────────────────────────────────────

const KEYS: (keyof KnotTheme)[] = ['bg', 'panel', 'ink', 'muted', 'accent', 'busy', 'idle', 'blocked', 'starting', 'dead']
let palettes = new Map<KnotMode, KnotPalette>()
let theme: KnotTheme | null = null
let themeKey = ''

/** Reads the theme from the window's `--ws-*` variables; rebuilds the palettes when it changed. */
function readTheme(): void {
  const css = getComputedStyle(document.documentElement)
  const t = Object.fromEntries(KEYS.map((k) => [k, css.getPropertyValue(`--ws-${k}`).trim()])) as unknown as KnotTheme
  const key = KEYS.map((k) => t[k]).join()
  if (key === themeKey || !t.panel) return
  themeKey = key
  theme = t
  palettes = new Map()
  for (const k of knots) k.dirty = true
  wake()
}
const paletteFor = (m: KnotMode): KnotPalette | null => {
  if (!theme) return null
  let p = palettes.get(m)
  if (!p) palettes.set(m, (p = knotPalette(theme, m)))
  return p
}
// The window applies a theme by setting variables on <html> (App.tsx applyTheme), at start and on every change.
new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-dark'] })

// ── The shared clock ─────────────────────────────────────────────────────────

interface Live {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  S: number
  mode: KnotMode
  /** In loops, wrapped at P loops (where the knot closes). */
  clock: number
  size: number
  flareAt: number
  visible: boolean
  dirty: boolean
  last: number
}

const knots = new Set<Live>()
let timer = 0
let raf = 0
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const k = [...knots].find((x) => x.canvas === e.target)
    if (!k) continue
    k.visible = e.isIntersecting
    if (k.visible) k.dirty = true
  }
  wake()
})

const flaring = (k: Live, now: number): number => Math.max(0, 1 - (now - k.flareAt) / FLARE_MS)
const easing = (k: Live): boolean => Math.abs(k.size - MODES[k.mode].size) > 0.004

/** Milliseconds until this knot next needs drawing, or Infinity. */
function dueIn(k: Live, now: number): number {
  if (!k.visible) return Infinity
  if (k.dirty) return 0
  // Changing size, or flaring after a bark: smooth, about 30 frames a second, until it settles.
  if (!reduced.matches && (easing(k) || flaring(k, now) > 0)) return Math.max(0, 33 - (now - k.last))
  if (reduced.matches || MODES[k.mode].loop === 0) return Infinity
  return Math.max(0, 1000 / MODES[k.mode].fps - (now - k.last))
}

function wake(): void {
  if (raf || document.hidden) return
  const now = performance.now()
  let next = Infinity
  for (const k of knots) next = Math.min(next, dueIn(k, now))
  if (next === Infinity) return
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = 0
    raf = requestAnimationFrame(tick)
  }, next)
}

function tick(now: number): void {
  raf = 0
  for (const k of knots) if (dueIn(k, now) <= 1) draw(k, now)
  wake()
}

function draw(k: Live, now: number): void {
  const look = MODES[k.mode]
  const dt = k.last ? Math.min(0.25, (now - k.last) / 1000) : 0
  k.last = now
  const still = reduced.matches
  if (!still && look.loop > 0) k.clock = wrapClock(k.clock + dt / look.loop)
  // Ease toward the mode's size over a few hundred ms (no snap), in the same box so nothing in the head shifts.
  const target = look.size
  k.size = still ? target : k.size + (target - k.size) * (1 - Math.exp(-dt / 0.12))
  if (Math.abs(k.size - target) < 0.004) k.size = target
  k.dirty = false
  const palette = paletteFor(k.mode)
  if (!palette) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.round(k.S * dpr)
  if (k.canvas.width !== px) k.canvas.width = k.canvas.height = px
  k.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  k.ctx.clearRect(0, 0, k.S, k.S)
  // A still knot (dead, or reduced motion) shows a phase where its strands read clearly.
  drawKnot(k.ctx, { S: k.S, ph: (still || look.loop === 0 ? 1.1 : k.clock) * TAU, palette, size: k.size, flare: still ? 0 : flaring(k, now) })
  // For the smoke checks: a bark's flare was drawn on this canvas.
  if (flaring(k, now) > 0) k.canvas.dataset.flare = '1'
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    window.clearTimeout(timer)
    timer = 0
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  } else {
    for (const k of knots) k.last = 0
    wake()
  }
})
reduced.addEventListener('change', () => {
  for (const k of knots) k.dirty = true
  wake()
})


// ── Components ───────────────────────────────────────────────────────────────

/**
 * One Knot in a square box of `size` CSS pixels. `barkId`: flare when that session barks; `'*'`
 * flares on any bark (the app's mark). Without a 2D canvas it falls back to the status dot.
 */
export function KnotCanvas({ mode, size, barkId, status, className = '', title }: { mode: KnotMode; size: number; barkId?: string; status?: SessionStatus; className?: string; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const live = useRef<Live | null>(null)
  const [noCanvas, setNoCanvas] = useState(false)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) {
      setNoCanvas(true)
      return
    }
    const k: Live = { canvas, ctx, S: size, mode, clock: Math.random() * 3, size: MODES[mode].size, flareAt: -Infinity, visible: true, dirty: true, last: 0 }
    live.current = k
    knots.add(k)
    io.observe(canvas)
    if (!themeKey) readTheme()
    wake()
    return () => {
      io.unobserve(canvas)
      knots.delete(k)
      live.current = null
    }
    // The knot is made once per canvas; mode and size changes are applied below without restarting its clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const k = live.current
    if (!k) return
    k.mode = mode
    k.S = size
    k.dirty = true
    wake()
  }, [mode, size])

  useBarks((id) => {
    const k = live.current
    if (!k || !barkId || (barkId !== '*' && barkId !== id)) return
    k.flareAt = performance.now()
    k.dirty = true
    wake()
  })

  if (noCanvas) return <span className={`dot ${status ?? 'idle'}`} />
  return <canvas ref={ref} className={`knot ${mode} ${className}`} data-mode={mode} style={{ width: size, height: size }} role="img" aria-label={title} title={title} />
}

const LABEL: Record<KnotMode, string> = {
  work: 'working',
  rest: 'resting',
  start: 'starting',
  needs: 'needs you',
  dead: 'exited'
}

/** A session's status as a Knot. */
export function SessionKnot({ id, status, attention }: { id?: string; status: SessionStatus; attention: boolean }) {
  const mode = knotMode(status, attention)
  return <KnotCanvas mode={mode} size={24} barkId={id} status={status} className={`session-knot ${status}`} title={LABEL[mode]} />
}

/** The app's mark, top left beside the window's buttons: full size and fast while any session works. */
export function AppMark({ working }: { working: boolean }) {
  return (
    <div className="app-mark" aria-hidden="true">
      <KnotCanvas mode={working ? 'work' : 'rest'} size={44} barkId="*" title={working ? 'A session is working' : 'No session is working'} />
    </div>
  )
}
