// The brand clip: workshop's mark for a Reel or a Story, made rather than filmed. Deep Space's sky
// (cosmos.ts's Sky, its nebulae drawn smaller than the window's so the stars show round them and
// the flight held near the middle), the Knot turning as it does while a session works, and the
// word "workshop" under it, centred as one. Drawn into its own 1080 × 1920 canvas on a clock: the
// recorder shows that canvas inside its frame as the preview and records it as it is, so no screen
// is captured and no Screen Recording permission is asked for. The sound is the take's as ever.

import { Sky } from '../cosmos'
import { MODES, TAU, drawKnot, fineLine, knotPalette, wrapClock } from '@shared/knot'
import { OUT_H, OUT_W, FPS } from '@shared/recorder'
import { COSMOS_ID, themeById } from '@shared/themes'
import words from '../../../../scripts/wordmark.json'

const space = themeById(COSMOS_ID).dark
/** The Knot's box, the word's width, and the gap between them, against the frame's width. */
const KNOT = 0.56
const WORD = 0.6
const GAP = 0.06

export class Brand {
  readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  // Smaller clouds than the window's and larger, more stars: a phone shows this frame small, and
  // the stars are what show it moving (Colin, 11 Nov 2026: "we should also see stars floating by").
  private readonly sky = new Sky({ nebula: 0.3, steer: 0.35, star: 2.2, count: 1100 })
  private readonly word = new Path2D(words.word.d)
  private readonly palette = knotPalette(space, 'work')
  private clock = 0
  private timer = 0
  private last = 0

  constructor() {
    this.canvas.width = OUT_W
    this.canvas.height = OUT_H
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.sky.resize(OUT_W, OUT_H, 1)
  }

  /** Runs while the brand fit is chosen: the preview, and what a take records. */
  start(): void {
    if (this.timer) return
    this.last = performance.now()
    this.frame()
    this.timer = window.setInterval(() => this.frame(), 1000 / FPS)
  }

  stop(): void {
    window.clearInterval(this.timer)
    this.timer = 0
  }

  private frame(): void {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.clock = wrapClock(this.clock + dt / MODES.work.loop)
    const { ctx } = this
    const W = OUT_W
    const H = OUT_H

    this.sky.draw(dt)
    this.sky.paint(ctx, W, H)

    // The Knot over the word, the pair centred on the frame.
    const S = Math.round(W * KNOT)
    const w = words.word
    const ws = (W * WORD) / w.advance
    const wordH = (w.ascender - w.descender) * ws
    const total = S + W * GAP + wordH
    const top = (H - total) / 2
    ctx.save()
    ctx.translate((W - S) / 2, top)
    drawKnot(fineLine(ctx, S), { S, ph: this.clock * TAU, palette: this.palette, size: MODES.work.size })
    ctx.restore()

    // The word in its own units (the font's: baseline at 0, up is negative), so its gradient, white
    // at the top of the letters to Deep Space's ink at the baseline (the banner's), is in them too.
    const baseline = top + S + W * GAP + w.ascender * ws
    ctx.save()
    ctx.setTransform(ws, 0, 0, ws, (W - w.advance * ws) / 2, baseline)
    const ink = ctx.createLinearGradient(0, -w.ascender * 0.72, 0, 0)
    ink.addColorStop(0, '#ffffff')
    ink.addColorStop(1, space.ink)
    ctx.fillStyle = ink
    ctx.fill(this.word)
    ctx.restore()
  }
}
