// The mascot and sprite packs (CLAUDE.md §8). A pack is one folder: a PNG sheet and `pack.json`,
// which says how big a frame is and which frames are which pose. The poses are the mascot's
// states; a session's status picks one. Everything here is pure (no DOM, no node) so the window,
// main and the tests share it.
//
// No art lives in this repo. Foxtrot's mapping below is OUR data about Elthen's sheet (where his
// frames are, how many, how fast); the sheet itself is downloaded by the user and never shipped.

import type { SessionStatus } from './sessions'

/** The poses, in the order the setup screen lists them. There is deliberately no "alert" pose (Colin's rule: it reads badly). */
export const MASCOT_STATES = ['idle', 'look', 'run', 'leap', 'sleep'] as const
export type MascotState = (typeof MASCOT_STATES)[number]

export const STATE_LABEL: Record<MascotState, string> = {
  idle: 'Idle',
  look: 'Look around',
  run: 'Run',
  leap: 'Leap',
  sleep: 'Sleep'
}

export const STATE_HINT: Record<MascotState, string> = {
  idle: 'starting, and the default pose',
  look: 'the session needs you',
  run: 'Claude is working',
  leap: 'a bark: something needs you, or a turn finished (plays once)',
  sleep: 'resting, waiting for you (and a session that died, dimmed)'
}

/** A run of frames on one row of the sheet, and how long each frame shows. */
export interface FrameRun {
  /** Row of the sheet, from 0. */
  row: number
  /** First frame on that row, from 0. */
  from: number
  /** How many frames, left to right. */
  frames: number
  /** Milliseconds per frame. */
  ms: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * pack.json. Only `name`, `frame` and one state are required; a state left out borrows the
 * nearest one (`FALLBACK`).
 */
export interface MascotPack {
  format: 1
  /** The mascot's name, shown in tooltips. The user's to change; "Foxtrot" by default. */
  name: string
  /** The sheet's file name in the pack's folder. */
  image: string
  /** The sheet's size in pixels, so a pack can be checked before its PNG is read. */
  sheet: { w: number; h: number }
  /** One frame's size in pixels; frames sit on a grid of this size from the top left. */
  frame: { w: number; h: number }
  /** The part of each frame that is drawn (sheets often leave empty margins round the art). Defaults to the whole frame. */
  box?: Box
  states: Partial<Record<MascotState, FrameRun>>
  /**
   * The worker coat (a subagent's mascot, gold in deck): its own sheet with the same layout,
   * or colours to swap on this one. Neither: `tintCoat`'s default gold.
   */
  worker?: { image?: string; swap?: [from: string, to: string][] }
  /** Whose art it is, shown in the setup screen. */
  credit?: { by: string; url: string }
}

/** The active pack as core's window gets it. */
export interface ActiveMascot {
  /** Its folder under `<profile>/mascots/`. */
  id: string
  pack: MascotPack
  /** The sheet, as a data: URL (the window loads images only from itself and data:). */
  sheet: string
  /** The worker coat's own sheet, if the pack has one. */
  worker: string | null
}

/** Where a state with no frames of its own looks next, nearest first. */
export const FALLBACK: Record<MascotState, MascotState[]> = {
  idle: ['sleep', 'look', 'run', 'leap'],
  look: ['idle', 'leap', 'run', 'sleep'],
  run: ['leap', 'idle', 'look', 'sleep'],
  leap: ['run', 'idle', 'look', 'sleep'],
  sleep: ['idle', 'look', 'run', 'leap']
}

/** The frames to play for a state: its own, else the nearest mapped one's. */
export function runFor(pack: Pick<MascotPack, 'states'>, state: MascotState): FrameRun | null {
  for (const s of [state, ...FALLBACK[state]]) {
    const r = pack.states[s]
    if (r) return r
  }
  return null
}

/**
 * The pose for a session (§8's table). Needing you overrides everything but death; a dead
 * session sleeps, and the head it sits in is dimmed by the stylesheet.
 */
export function poseFor(status: SessionStatus, attention: boolean): MascotState {
  if (status === 'dead') return 'sleep'
  if (attention || status === 'blocked') return 'look'
  if (status === 'busy') return 'run'
  if (status === 'idle') return 'sleep'
  return 'idle'
}

/** How long one play of a run lasts (a bark's leap plays once). */
export const runMs = (r: FrameRun): number => r.frames * r.ms

// ── Checking a pack ──────────────────────────────────────────────────────────

export const MAX_SHEET_BYTES = 4 * 1024 * 1024
export const MAX_SHEET_SIDE = 4096
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.png$/
const HEX = /^#[0-9a-fA-F]{6}$/
const KEYS = new Set(['format', 'name', 'image', 'sheet', 'frame', 'box', 'states', 'worker', 'credit'])

export type PackCheck = { ok: true; pack: MascotPack } | { ok: false; errors: string[] }

const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi

/**
 * Validates pack.json. Unknown fields and states are refused rather than ignored, as tile.json's
 * unknown permissions are, so a typo is said out loud. Every run must lie inside the sheet.
 */
export function checkPack(raw: unknown): PackCheck {
  const errors: string[] = []
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['pack.json must be an object'] }
  for (const k of Object.keys(r)) if (!KEYS.has(k)) errors.push(`unknown field "${k}"`)
  if (r.format !== 1) errors.push('"format" must be 1')
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name || name.length > 40) errors.push('"name" must be 1 to 40 characters')
  if (typeof r.image !== 'string' || !FILE.test(r.image)) errors.push('"image" must be a .png file name in the pack folder')
  const sheet = r.sheet as { w?: unknown; h?: unknown } | undefined
  const frame = r.frame as { w?: unknown; h?: unknown } | undefined
  const sheetOk = !!sheet && int(sheet.w, 1, MAX_SHEET_SIDE) && int(sheet.h, 1, MAX_SHEET_SIDE)
  if (!sheetOk) errors.push(`"sheet" must be { w, h } in pixels, at most ${MAX_SHEET_SIDE}`)
  const frameOk = !!frame && int(frame.w, 4, 1024) && int(frame.h, 4, 1024)
  if (!frameOk) errors.push('"frame" must be { w, h }, 4 to 1024 pixels')
  const fw = frameOk ? (frame!.w as number) : 0
  const fh = frameOk ? (frame!.h as number) : 0
  const cols = sheetOk && frameOk ? Math.floor((sheet!.w as number) / fw) : 0
  const rows = sheetOk && frameOk ? Math.floor((sheet!.h as number) / fh) : 0
  if (sheetOk && frameOk && (cols < 1 || rows < 1)) errors.push('a frame is bigger than the sheet')

  let box: Box | undefined
  if (r.box !== undefined) {
    const b = r.box as Record<string, unknown>
    if (!b || typeof b !== 'object' || !int(b.x, 0, 1023) || !int(b.y, 0, 1023) || !int(b.w, 1, 1024) || !int(b.h, 1, 1024)) errors.push('"box" must be { x, y, w, h } in pixels')
    else if (frameOk && ((b.x as number) + (b.w as number) > fw || (b.y as number) + (b.h as number) > fh)) errors.push('"box" must fit inside a frame')
    else box = { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number }
  }

  const states: Partial<Record<MascotState, FrameRun>> = {}
  const st = r.states as Record<string, unknown> | undefined
  if (!st || typeof st !== 'object' || Array.isArray(st)) errors.push('"states" must map states to frames')
  else {
    for (const [k, v] of Object.entries(st)) {
      if (!(MASCOT_STATES as readonly string[]).includes(k)) {
        errors.push(`unknown state "${k}" (known: ${MASCOT_STATES.join(', ')})`)
        continue
      }
      const run = v as Record<string, unknown>
      const from = run?.from === undefined ? 0 : run.from
      if (!run || typeof run !== 'object' || !int(run.row, 0, 1023) || !int(from, 0, 1023) || !int(run.frames, 1, 128) || !int(run.ms, 16, 10_000)) {
        errors.push(`state "${k}" must be { row, from, frames (1 to 128), ms (16 to 10000) }`)
        continue
      }
      if (cols && rows && ((run.row as number) >= rows || (from as number) + (run.frames as number) > cols)) {
        errors.push(`state "${k}" runs off the sheet (it has ${rows} rows of ${cols} frames)`)
        continue
      }
      states[k as MascotState] = { row: run.row as number, from: from as number, frames: run.frames as number, ms: run.ms as number }
    }
    if (Object.keys(st).length === 0) errors.push('map at least one state')
  }

  let worker: MascotPack['worker']
  if (r.worker !== undefined) {
    const w = r.worker as Record<string, unknown>
    const swapOk = w?.swap === undefined || (Array.isArray(w.swap) && w.swap.length <= 16 && w.swap.every((p) => Array.isArray(p) && p.length === 2 && HEX.test(String(p[0])) && HEX.test(String(p[1]))))
    const imageOk = w?.image === undefined || (typeof w.image === 'string' && FILE.test(w.image))
    if (!w || typeof w !== 'object' || !swapOk || !imageOk) errors.push('"worker" must be { image: "<file>.png" } or { swap: [["#rrggbb", "#rrggbb"], …] }')
    else worker = { ...(w.image ? { image: w.image as string } : {}), ...(w.swap ? { swap: (w.swap as string[][]).map((p) => [p[0].toLowerCase(), p[1].toLowerCase()] as [string, string]) } : {}) }
  }

  let credit: MascotPack['credit']
  if (r.credit !== undefined) {
    const c = r.credit as Record<string, unknown>
    if (!c || typeof c.by !== 'string' || !c.by.trim() || c.by.length > 80 || typeof c.url !== 'string' || !/^https:\/\/[^\s]{1,300}$/.test(c.url)) errors.push('"credit" must be { by, url } with an https url')
    else credit = { by: c.by.trim(), url: c.url }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    pack: {
      format: 1,
      name,
      image: r.image as string,
      sheet: { w: sheet!.w as number, h: sheet!.h as number },
      frame: { w: fw, h: fh },
      ...(box ? { box } : {}),
      states,
      ...(worker ? { worker } : {}),
      ...(credit ? { credit } : {})
    }
  }
}

/** The width and height a PNG says it is (its IHDR), or null if the bytes are not a PNG. Needs no decoder. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null
  const u32 = (o: number): number => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
  return { w: u32(16), h: u32(20) }
}

// ── Reading a sheet: the grid guess ──────────────────────────────────────────

/** Decoded pixels, as a canvas's ImageData has them (RGBA, row by row). */
export interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** Which columns (axis 'x') or rows ('y') hold any pixel that is not fully transparent. */
function inked(p: Pixels, axis: 'x' | 'y'): boolean[] {
  const out = new Array<boolean>(axis === 'x' ? p.width : p.height).fill(false)
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) if (p.data[(y * p.width + x) * 4 + 3] > 0) out[axis === 'x' ? x : y] = true
  return out
}

/**
 * The smallest frame size along one axis whose every interior grid line is clear of art. A frame
 * size that cut through a drawing would have ink on its line; the true one never does, because
 * the art sits inside its frame. Sizes under 8 pixels are not considered (a gap between ears
 * would pass).
 */
function guessAxis(ink: boolean[]): number | null {
  const n = ink.length
  for (let d = 8; d <= n; d++) {
    if (n % d) continue
    let clean = true
    for (let k = d; k < n && clean; k += d) if (ink[k] && ink[k - 1]) clean = false
    if (clean && d < n) return d
  }
  return null
}

/**
 * Guesses the frame grid of a sheet. When neither axis has a clean grid (art that fills its
 * frames edge to edge), a single strip of square frames is assumed; the user corrects it in the
 * setup screen either way.
 */
export function guessGrid(p: Pixels): { w: number; h: number } {
  const gx = guessAxis(inked(p, 'x'))
  const gy = guessAxis(inked(p, 'y'))
  if (gx && gy) return { w: gx, h: gy }
  if (gy && !gx) return { w: p.width % gy === 0 ? gy : p.width, h: gy }
  if (gx && !gy) return { w: gx, h: p.height % gx === 0 ? gx : p.height }
  return { w: p.width % p.height === 0 ? p.height : p.width, h: p.height }
}

/** For each row of the grid, how many frames hold art, counted up to the last one that does. */
export function framesPerRow(p: Pixels, frame: { w: number; h: number }): number[] {
  const cols = Math.floor(p.width / frame.w)
  const rows = Math.floor(p.height / frame.h)
  const out: number[] = []
  for (let r = 0; r < rows; r++) {
    let last = 0
    for (let c = 0; c < cols; c++) {
      let any = false
      for (let y = r * frame.h; y < (r + 1) * frame.h && !any; y++)
        for (let x = c * frame.w; x < (c + 1) * frame.w; x++)
          if (p.data[(y * p.width + x) * 4 + 3] > 0) {
            any = true
            break
          }
      if (any) last = c + 1
    }
    out.push(last)
  }
  return out
}

/** The smallest box holding every frame's art, in frame coordinates, or null for an empty sheet. */
export function artBox(p: Pixels, frame: { w: number; h: number }): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  const W = Math.floor(p.width / frame.w) * frame.w
  const H = Math.floor(p.height / frame.h) * frame.h
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (p.data[(y * p.width + x) * 4 + 3] > 0) {
        const fx = x % frame.w
        const fy = y % frame.h
        if (fx < x0) x0 = fx
        if (fy < y0) y0 = fy
        if (fx > x1) x1 = fx
        if (fy > y1) y1 = fy
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

// ── Known sheets ─────────────────────────────────────────────────────────────

/**
 * A sheet workshop knows the layout of, so dropping it in maps every state with nothing to
 * configure. It is recognised by its LAYOUT (size, frame grid, how many frames each row holds,
 * read from where the transparent pixels are), never by its pixels or a hash of the art: the
 * repo holds nothing of the art itself.
 */
export interface KnownSheet {
  key: string
  title: string
  /** Where the user gets it (opened in their browser; workshop never downloads it). */
  url: string
  sheet: { w: number; h: number }
  frame: { w: number; h: number }
  /** Frames per row, as `framesPerRow` counts them. */
  rows: number[]
  pack: Omit<MascotPack, 'name'>
}

/**
 * Elthen's "2D Pixel Art Fox Sprites" (elthen.itch.io), the fox deck uses. 448 × 224, a 14 × 7
 * grid of 32-pixel frames; the art sits in x 4–25, y 14–31 of each frame (22 × 18). Rows: 0 idle
 * (5), 1 look around (14), 2 run (8), 3 leap (11), 4 alert with the tail up (5, never used), 5 sleep
 * (6), 6 lying down (7). Speeds are deck's. The worker swap is deck's gold coat: the sheet's two
 * coat colours to slay's yellow ramp.
 */
export const FOXTROT: KnownSheet = {
  key: 'elthen-fox',
  title: 'Elthen’s 2D Pixel Art Fox',
  url: 'https://elthen.itch.io/2d-pixel-art-fox-sprites',
  sheet: { w: 448, h: 224 },
  frame: { w: 32, h: 32 },
  rows: [5, 14, 8, 11, 5, 6, 7],
  pack: {
    format: 1,
    image: 'sheet.png',
    sheet: { w: 448, h: 224 },
    frame: { w: 32, h: 32 },
    box: { x: 4, y: 14, w: 22, h: 18 },
    states: {
      idle: { row: 0, from: 0, frames: 5, ms: 280 },
      look: { row: 1, from: 0, frames: 14, ms: 230 },
      run: { row: 2, from: 0, frames: 8, ms: 70 },
      leap: { row: 3, from: 0, frames: 11, ms: 70 },
      sleep: { row: 5, from: 0, frames: 6, ms: 330 }
    },
    worker: {
      swap: [
        ['#d67941', '#e5b843'],
        ['#9d5021', '#b78c2a']
      ]
    },
    credit: { by: 'Elthen', url: 'https://elthen.itch.io/2d-pixel-art-fox-sprites' }
  }
}

export const KNOWN_SHEETS: KnownSheet[] = [FOXTROT]

/** The known sheet these pixels are laid out as, or null. */
export function recognise(p: Pixels): KnownSheet | null {
  for (const k of KNOWN_SHEETS) {
    if (p.width !== k.sheet.w || p.height !== k.sheet.h) continue
    const rows = framesPerRow(p, k.frame)
    if (rows.length === k.rows.length && rows.every((n, i) => n === k.rows[i])) return k
  }
  return null
}

export const DEFAULT_NAME = 'Foxtrot'

// ── The worker coat ──────────────────────────────────────────────────────────

const hexRgb = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

/** The default worker gold, as a hue in degrees. */
export const GOLD_HUE = 44

/**
 * Recolours a sheet's pixels in place for the worker coat. With `swap`, exact colours are
 * replaced (lossless on a sheet with a small palette, as pixel art has). Without, every clearly
 * coloured pixel (saturation over a third) is turned to gold at its own lightness, so outlines,
 * whites and greys stay as they were. Transparent pixels are never touched.
 */
export function tintCoat(data: Uint8ClampedArray | Uint8Array, swap?: [string, string][]): void {
  const pairs = swap?.map(([a, b]) => [hexRgb(a), hexRgb(b)] as const)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    if (pairs) {
      for (const [from, to] of pairs)
        if (data[i] === from[0] && data[i + 1] === from[1] && data[i + 2] === from[2]) {
          data[i] = to[0]
          data[i + 1] = to[1]
          data[i + 2] = to[2]
          break
        }
      continue
    }
    const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (s < 0.34) continue
    const [r, g, b] = hslToRgb(GOLD_HUE, Math.max(s, 0.6), l)
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────────

/** The size the mascot is drawn at in a session head: the art box fitted into 22 × 18. */
export const HEAD_BOX = { w: 22, h: 18 }

/**
 * Where to put the sheet behind an element showing frame `i` of `run`, at `scale`: the CSS
 * background size and position, in pixels.
 */
export function spriteAt(pack: Pick<MascotPack, 'sheet' | 'frame' | 'box'>, run: FrameRun, i: number, scale: number): { size: [number, number]; pos: [number, number] } {
  const box = pack.box ?? { x: 0, y: 0, w: pack.frame.w, h: pack.frame.h }
  const col = run.from + (i % run.frames)
  return {
    size: [pack.sheet.w * scale, pack.sheet.h * scale],
    pos: [-(col * pack.frame.w + box.x) * scale, -(run.row * pack.frame.h + box.y) * scale]
  }
}

/** The scale that fits the art box into `into`; whole numbers when it is at least 1, so pixels stay square. */
export function fitScale(pack: Pick<MascotPack, 'frame' | 'box'>, into: { w: number; h: number } = HEAD_BOX): number {
  const box = pack.box ?? { x: 0, y: 0, w: pack.frame.w, h: pack.frame.h }
  const s = Math.min(into.w / box.w, into.h / box.h)
  return s >= 1 ? Math.floor(s) : s
}
