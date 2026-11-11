// The Knot: workshop's default status mark and the app's own mark (CLAUDE.md §8, Colin, 10 Nov
// 2026). A (2,5) torus knot, the cinquefoil (Colin's choice, 10 Nov 2026, over the first (3,4)), turning in 3D, drawn on a small 2D canvas with its strands sorted back
// to front and a bright pulse riding the strand. Workshop's own version of the "AlgoGlyph" in
// Colin's Cura app (there a (3,5) knot); nothing here is shared with Cura.
//
// Everything in this file is pure: the curve, the status language (size, speed, colours) and the
// colour maths, so the tests can draw it into a recording context and check every colour it uses
// against every theme.

import type { SessionStatus } from './sessions'

export const TAU = Math.PI * 2
/** Turns of the tube round the torus, and of the knot round its axis: the (2,5) torus knot, one strand (gcd 1). */
export const P = 2
export const Q = 5

// ── The status language ──────────────────────────────────────────────────────

/** What a Knot is showing. Sessions map onto these with `knotMode`; the app's mark uses `work` and `rest`. */
export type KnotMode = 'work' | 'rest' | 'needs' | 'start' | 'dead'

export interface ModeLook {
  /** Radius, as a share of full size. Inactive knots are smaller, inside the same box. */
  size: number
  /** Seconds per loop (one turn of tilt and pulse); 0 holds still. */
  loop: number
  /** Frames a second at most: 30 for every moving knot (Colin, 10 Nov 2026), so none steps. */
  fps: number
}

/**
 * The table in CLAUDE.md §8 and the phase 2 notes. Size and speed say how active a session is;
 * colour says what it wants (needs-you is the theme's "blocked" colour, as the dot was, so it
 * does not rely on speed alone).
 */
export const MODES: Record<KnotMode, ModeLook> = {
  work: { size: 1, loop: 2.4, fps: 30 },
  needs: { size: 0.92, loop: 7, fps: 30 },
  start: { size: 0.86, loop: 5, fps: 30 },
  // At rest the knot stands as tall as Foxtrot does in deck (see BOX). deck's own fox swings
  // from 56–60 px awake to 44 asleep, about this much; speed and colour carry the rest.
  rest: { size: 0.8, loop: 22, fps: 30 },
  dead: { size: 0.8, loop: 0, fps: 0 }
}

/**
 * The Knot's square box, in CSS pixels, where core draws it. Measured against deck (Colin, 10 Nov
 * 2026: "the knot takes up the same height as foxtrot"; docs/progress/2026-11-10-bar.md): Foxtrot
 * stands 15 sheet pixels tall, drawn at 1× in a session's head (15 px) and at 4× in deck's 88 px
 * top bar (60 px). A resting knot draws about 0.63 of its box tall, so 24 gives it his 15 px in a
 * head (no taller than the head had it), and the bar's whole height, 88, gives it 55 px turning
 * between 50 and 60. Working, it is a quarter taller again; a flare just fills the box.
 */
export const BOX = { head: 24, mark: 88 } as const

export function knotMode(status: SessionStatus, attention: boolean): KnotMode {
  if (status === 'dead') return 'dead'
  if (attention || status === 'blocked') return 'needs'
  if (status === 'busy') return 'work'
  if (status === 'starting') return 'start'
  return 'rest'
}

/** How long a call for attention's flare lasts, in ms: the pulse spreads and brightens, and the knot swells a little, once. */
export const FLARE_MS = 900

// ── The curve ────────────────────────────────────────────────────────────────

/** Turn about y, then tilt about x. */
function rot(x: number, y: number, z: number, ay: number, ax: number): [number, number, number] {
  const c = Math.cos(ay)
  const s = Math.sin(ay)
  const x1 = x * c + z * s
  const z1 = -x * s + z * c
  const c2 = Math.cos(ax)
  const s2 = Math.sin(ax)
  return [x1, y * c2 - z1 * s2, y * s2 + z1 * c2]
}

/**
 * The knot at phase `ph` as `segs + 1` points in its own units (x, y on screen, z toward the
 * viewer; the radius is at most about 2). The tilt, colours and pulse repeat every loop (2π), but
 * the spin (`ph / P`) turns only half way round in one, and the knot matches itself
 * only every Qth of a turn, so a single loop does not close. P loops do: the spin has then made
 * one whole turn, the tilt and pulse P whole loops. A Knot's clock therefore wraps at P loops,
 * which `wrapClock` does, and never jumps.
 */
export function knotPoints(ph: number, segs: number): [number, number, number][] {
  const ay = 0.35 * Math.sin(ph)
  const ax = 0.5 + 0.2 * Math.cos(ph)
  const sz = ph / P
  const cz = Math.cos(sz)
  const sn = Math.sin(sz)
  const pts: [number, number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const th = (i / segs) * TAU
    const r = 1.25 + 0.55 * Math.cos(Q * th)
    const x0 = r * Math.cos(P * th)
    const y0 = r * Math.sin(P * th)
    pts.push(rot(x0 * cz - y0 * sn, x0 * sn + y0 * cz, 0.55 * Math.sin(Q * th), ay, ax))
  }
  return pts
}

/** A clock in loops, kept inside one whole cycle (P loops), where the knot closes exactly. */
export const wrapClock = (loops: number): number => ((loops % P) + P) % P

// ── Colour ───────────────────────────────────────────────────────────────────

export type RGB = [number, number, number]

export function parseColor(s: string): RGB | null {
  const t = s.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(t)
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as RGB
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t)
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(Math.min(255, v))) as RGB
  return null
}

export const hex = (c: RGB): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB

/** WCAG relative luminance. */
export function luminance([r, g, b]: RGB): number {
  const f = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The ratio every colour the Knot draws with must reach against the surfaces it sits on (WCAG's for graphics). */
export const MIN_CONTRAST = 3

/**
 * `c`, moved toward `ink` just far enough to reach `min` against every surface. The ink is the
 * theme's text colour, which reads on all of them; a theme whose ink itself fell short would get
 * the ink.
 */
export function ensureContrast(c: RGB, surfaces: RGB[], ink: RGB, min = MIN_CONTRAST): RGB {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const x = mix(c, ink, Math.min(1, t))
    if (surfaces.every((s) => contrast(x, s) >= min)) return x
  }
  return ink
}

/** The theme colours a Knot is drawn from (CSS variables `--ws-*`, or a ThemeVariant's fields). */
export interface KnotTheme {
  bg: string
  panel: string
  ink: string
  muted: string
  accent: string
  busy: string
  idle: string
  blocked: string
  starting: string
  dead: string
}

/** The strand's gradient for each mode, as theme colour names: it runs out and back, so it loops. */
const STOPS: Record<KnotMode, (keyof KnotTheme)[]> = {
  work: ['accent', 'busy', 'accent'],
  rest: ['accent', 'starting', 'accent'],
  start: ['starting', 'accent', 'starting'],
  needs: ['blocked', 'busy', 'blocked'],
  dead: ['dead', 'muted', 'dead']
}

export const SHADES = 24
/** Depth bands, near to far. Far strands are pulled toward the surface, never made see-through (which washed out on light themes). */
export const DEPTHS = [0, 0.2, 0.4]

export interface KnotPalette {
  /** [shade][depth band] → CSS colour; every one meets MIN_CONTRAST against every surface. */
  strand: string[][]
  /** The pulse's core, per shade: the strand colour pushed toward the ink. */
  pulse: string[]
}

/**
 * The colours one mode draws with on a theme, each checked against the surfaces the Knot sits on:
 * the panel (session heads) and the window's background (the top bar). A colour that falls short
 * is moved toward the ink until it does not.
 */
export function knotPalette(theme: KnotTheme, mode: KnotMode): KnotPalette {
  const get = (k: keyof KnotTheme): RGB => parseColor(theme[k]) ?? [128, 128, 128]
  const surfaces = [get('panel'), get('bg')]
  const ink = get('ink')
  const panel = get('panel')
  const stops = STOPS[mode].map(get)
  const strand: string[][] = []
  const pulse: string[] = []
  for (let i = 0; i < SHADES; i++) {
    const f = (i / SHADES) * (stops.length - 1)
    const k = Math.min(stops.length - 2, Math.floor(f))
    const base = mix(stops[k], stops[k + 1], f - k)
    strand.push(DEPTHS.map((d) => hex(ensureContrast(mix(base, panel, d), surfaces, ink))))
    pulse.push(hex(ensureContrast(mix(base, ink, 0.55), surfaces, ink)))
  }
  return { strand, pulse }
}

// ── Drawing ──────────────────────────────────────────────────────────────────

/** The few canvas calls the Knot makes, so a test can record them. */
export interface KnotCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
}

export interface KnotDraw {
  /** The box's side in CSS pixels. */
  S: number
  /** Phase, radians: `clock (in loops) × 2π`. */
  ph: number
  palette: KnotPalette
  /** Radius as a share of full size (MODES[..].size, eased). */
  size: number
  /** 0 to 1: a call for attention's flare, fading. */
  flare?: number
  /** Segments of the strand: far fewer than a big glyph needs at this size. */
  segs?: number
}

/** Segments for a box of side S: about three per pixel of side, at least 48. */
export const segsFor = (S: number): number => Math.max(48, Math.min(160, Math.round(S * 3)))

/**
 * Draws the Knot. The strand thins with the radius, but only part of the way and never below a
 * pixel: at full width a small (inactive) knot's strands ran together into a blob, and scaled
 * all the way they would thin to nothing.
 */
export function drawKnot(ctx: KnotCtx, { S, ph, palette, size, flare = 0, segs = segsFor(S) }: KnotDraw): void {
  const c = S / 2
  // The knot's reach is about 2.1 units; full size leaves a pixel's margin in the box.
  const sc = (S / 2 / 2.2) * size * (1 + 0.12 * flare)
  const lw = Math.max(1, (S / 16) * (0.4 + 0.6 * size))
  const pts = knotPoints(ph, segs).map(([x, y, z]) => [c + x * sc, c + y * sc, z] as const)
  const order = Array.from({ length: segs }, (_, i) => i).sort((a, b) => pts[a][2] - pts[b][2])
  const head = (((ph / TAU) % 1) + 1) % 1
  const reach = 0.82 - 0.3 * flare
  const shift = ph / TAU
  ctx.lineCap = 'round'
  for (const j of order) {
    const f = j / segs
    const depth = Math.max(0, Math.min(1, (pts[j][2] + 1.8) / 3.6))
    const d = (f - head + 1) % 1
    const glow = d > reach ? ((d - reach) / (1 - reach)) ** 2 : 0
    const shade = Math.floor(((((f * 2 + shift) % 1) + 1) % 1) * SHADES) % SHADES
    const band = depth > 0.62 ? 0 : depth > 0.32 ? 1 : 2
    ctx.strokeStyle = palette.strand[shade][band]
    ctx.lineWidth = Math.max(1, lw * (0.75 + 0.45 * depth) * (1 + glow * (0.7 + 0.6 * flare)))
    ctx.beginPath()
    ctx.moveTo(pts[j][0], pts[j][1])
    ctx.lineTo(pts[j + 1][0], pts[j + 1][1])
    ctx.stroke()
    if (glow > 0.55) {
      ctx.strokeStyle = palette.pulse[shade]
      ctx.lineWidth = Math.max(1, lw * 0.55)
      ctx.beginPath()
      ctx.moveTo(pts[j][0], pts[j][1])
      ctx.lineTo(pts[j + 1][0], pts[j + 1][1])
      ctx.stroke()
    }
  }
}
