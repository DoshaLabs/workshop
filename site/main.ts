// The project page's two live pieces, both the app's own code: Deep Space's sky (cosmos.ts, the
// wall behind core's window) and the Knot (shared/knot.ts, the mark on every session), drawn here
// large as the hero and small in the five states a session can be in.

import './style.css'
import { FLARE_MS, MODES, P, TAU, drawKnot, knotPalette, segsFor, wrapClock, type KnotCtx, type KnotMode, type KnotPalette } from '@shared/knot'
import { COSMOS_ID, themeById } from '@shared/themes'
import { syncCosmos } from '../src/renderer/src/cosmos'

syncCosmos(COSMOS_ID)

const space = themeById(COSMOS_ID).dark
const palettes = new Map<KnotMode, KnotPalette>()
const paletteFor = (m: KnotMode): KnotPalette => {
  let p = palettes.get(m)
  if (!p) palettes.set(m, (p = knotPalette(space, m)))
  return p
}

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

interface Live {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  mode: KnotMode
  /** In loops, wrapped at P loops, where the knot closes. */
  clock: number
  flareAt: number
  visible: boolean
  last: number
  S: number
  /** Overrides the mode's speed and frame rate (the hero). */
  look?: { size: number; loop: number; fps: number }
}

const knots: Live[] = []

function add(canvas: HTMLCanvasElement, mode: KnotMode, start: number, look?: Live['look']): Live | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const k: Live = { canvas, ctx, mode, clock: wrapClock(start), flareAt: -1e9, visible: true, last: 0, S: 0, look }
  knots.push(k)
  return k
}

function draw(k: Live, now: number): void {
  const look = k.look ?? MODES[k.mode]
  const S = k.canvas.clientWidth
  if (!S) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.round(S * dpr)
  if (k.canvas.width !== px) k.canvas.width = k.canvas.height = px
  k.S = S
  const flare = reduced.matches ? 0 : Math.max(0, 1 - (now - k.flareAt) / FLARE_MS)
  // The app's still phase (Knot.tsx): where the strands read clearly.
  const ph = (reduced.matches || look.loop === 0 ? 1.1 : k.clock) * TAU
  k.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  k.ctx.clearRect(0, 0, S, S)
  drawKnot(large(k.ctx, S), { S, ph, palette: paletteFor(k.mode), size: look.size, flare, segs: Math.max(segsFor(S), Math.round(S * 0.6)) })
}

/**
 * The strand's width grows with the box, tuned for the app's 24 to 88 px. Drawn far larger, as
 * the hero is, that is a fat tube, so above the app's sizes the width is scaled back: the same
 * drawing, a finer line.
 */
function large(ctx: CanvasRenderingContext2D, S: number): KnotCtx {
  const f = S <= 120 ? 1 : Math.max(0.5, 120 / S + 0.35)
  if (f === 1) return ctx
  return {
    get strokeStyle() {
      return ctx.strokeStyle
    },
    set strokeStyle(v) {
      ctx.strokeStyle = v
    },
    get lineWidth() {
      return ctx.lineWidth / f
    },
    set lineWidth(v) {
      ctx.lineWidth = v * f
    },
    get lineCap() {
      return ctx.lineCap
    },
    set lineCap(v) {
      ctx.lineCap = v
    },
    beginPath: () => ctx.beginPath(),
    moveTo: (x, y) => ctx.moveTo(x, y),
    lineTo: (x, y) => ctx.lineTo(x, y),
    stroke: () => ctx.stroke()
  }
}

let raf = 0
function tick(now: number): void {
  raf = 0
  for (const k of knots) {
    if (!k.visible) {
      k.last = 0
      continue
    }
    const look = k.look ?? MODES[k.mode]
    const flaring = now - k.flareAt < FLARE_MS
    // Each knot at its own frame rate, as in the app (30 a second while it moves).
    const fps = flaring ? 30 : look.fps
    if (k.last && fps && now - k.last < 1000 / fps - 2) continue
    if (!fps && k.last && !flaring) continue
    const dt = k.last ? Math.min(0.25, (now - k.last) / 1000) : 0
    k.last = now
    if (look.loop > 0) k.clock = wrapClock(k.clock + dt / look.loop)
    draw(k, now)
  }
  if (!reduced.matches && !document.hidden) raf = requestAnimationFrame(tick)
}
function start(): void {
  if (raf) return
  if (reduced.matches) {
    for (const k of knots) draw(k, performance.now())
    return
  }
  raf = requestAnimationFrame(tick)
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const k = knots.find((x) => x.canvas === e.target)
    if (k) k.visible = e.isIntersecting
  }
})

// The hero: the app's mark, full size, but slower than a working session (2.4 s a loop is too busy
// for a page people read; Colin, 10 Nov 2026) and at every frame the display can show.
const hero = document.querySelector<HTMLCanvasElement>('#hero-knot')
if (hero) add(hero, 'work', 0, { size: MODES.work.size, loop: 8, fps: 120 })

// The five states, each a button: pressing one flares it, as a call for attention does in the app.
for (const el of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  const canvas = el.querySelector('canvas')
  const mode = el.dataset.mode as KnotMode
  if (!canvas || !(mode in MODES)) continue
  const k = add(canvas, mode, Math.random() * P)
  if (!k) continue
  el.addEventListener('click', () => {
    k.flareAt = performance.now()
    k.last = 0
    start()
  })
}

for (const k of knots) io.observe(k.canvas)
document.addEventListener('visibilitychange', () => {
  for (const k of knots) k.last = 0
  start()
})
reduced.addEventListener('change', start)
window.addEventListener('resize', () => {
  for (const k of knots) draw(k, performance.now())
})
start()
