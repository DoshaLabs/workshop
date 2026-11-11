// The screen recorder's pure parts (main/recorder.ts has the whole story): the frame's geometry,
// the crop it films, the saved file's name, its settings and the channels its page talks on.
//
// This file must import nothing: the recorder's preload is sandboxed and must be one file, and it
// is built beside core's own preload, so a module both of them import would become a shared chunk
// that neither could require.

/** The frame's margin around the filmed rectangle (the border you drag by), and its toolbar's height. */
export const REC_PAD = 14
export const REC_BAR = 46
/** The filmed rectangle's aspect (width / height): 9:16, Reels and Stories. */
export const ASPECT = 9 / 16
/** The smallest filmed rectangle, in screen points. */
export const MIN_H = 420
/** The file's size and frame rate. */
export const OUT_W = 1080
export const OUT_H = 1920
export const FPS = 30
/** Seconds counted down before a take starts. */
export const COUNTDOWN = 3

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A coordinate for Electron: Math.round(-0.3) is -0, which V8 does not count as an int32, and
 * setPosition throws "conversion failure" in main (deck found it with a drag to the screen's edge).
 */
export const int = (n: number): number => Math.round(n) | 0

/** The window around a filmed rectangle of height h: the border on every side, the toolbar under it. */
export function windowFor(x: number, y: number, h: number): Rect {
  const height = Math.round(h)
  return { x: int(x), y: int(y), width: Math.round(height * ASPECT) + 2 * REC_PAD, height: height + 2 * REC_PAD + REC_BAR }
}

/** The tallest filmed rectangle a display's work area holds. */
const maxH = (area: Rect): number => area.height - 2 * REC_PAD - REC_BAR

/** Where the frame first opens: centred on the work area, its filmed rectangle 80% of the area's height. */
export function firstFrame(area: Rect): Rect {
  const h = Math.max(MIN_H, Math.round(area.height * 0.8) - 2 * REC_PAD - REC_BAR)
  const w = windowFor(0, 0, h)
  return { ...w, x: int(area.x + (area.width - w.width) / 2), y: int(area.y + (area.height - w.height) / 2) }
}

/** The corner handle dragged: a new filmed height, kept between MIN_H and the display, the top-left corner staying put. */
export function resized(b: Rect, height: number, area: Rect): Rect {
  const want = Number.isFinite(height) ? height : MIN_H
  return windowFor(b.x, b.y, Math.min(Math.max(MIN_H, want), Math.max(MIN_H, maxH(area))))
}

/**
 * What a take films. `reel`: the 9:16 frame you drag anywhere, at 1080 × 1920. `center`: exactly
 * workshop's center column (the focused session, the launcher, a pane), at its own size on the
 * screen, the frame following it; its bar sits above the column, in the window's top bar, where
 * there is room (the column's foot is often the screen's).
 */
export type RecFit = 'reel' | 'center'

/** The filmed rectangle on the screen, from the window's own bounds (the bar under it, or above it for `center`). */
export function innerOf(win: Rect, fit: RecFit = 'reel'): Rect {
  const top = fit === 'center' ? REC_BAR : 0
  return { x: win.x + REC_PAD, y: win.y + REC_PAD + top, width: win.width - 2 * REC_PAD, height: win.height - 2 * REC_PAD - REC_BAR }
}

/** The frame's window around a filmed rectangle `column` (screen points), its bar above it: `center`'s. */
export function centerWindow(column: Rect): Rect {
  return { x: int(column.x - REC_PAD), y: int(column.y - REC_PAD - REC_BAR), width: Math.round(column.width) + 2 * REC_PAD, height: Math.round(column.height) + 2 * REC_PAD + REC_BAR }
}

/**
 * The file's size: 1080 × 1920 for a reel; for `center`, the column in the display's own pixels
 * (sharp on a Retina screen), each side even (H.264 wants it), at most 4096 on the long side.
 */
export function outSize(fit: RecFit, inner: Rect, scale: number): { w: number; h: number } {
  if (fit === 'reel') return { w: OUT_W, h: OUT_H }
  const k = Math.min(Math.max(1, scale || 1), 4096 / Math.max(1, inner.width, inner.height))
  const even = (n: number): number => Math.max(2, 2 * Math.round((n * k) / 2))
  return { w: even(inner.width), h: even(inner.height) }
}

/**
 * The part of a captured display's video that is under the filmed rectangle now, in video pixels,
 * kept inside the video (a frame half off the screen films the half that is on it). Null before
 * the video has a size.
 */
export function cropOf(inner: Rect, display: Rect, videoW: number, videoH: number): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!videoW || !videoH || !display.width || !display.height) return null
  const kx = videoW / display.width
  const ky = videoH / display.height
  const sx = Math.min(Math.max(0, (inner.x - display.x) * kx), videoW - 1)
  const sy = Math.min(Math.max(0, (inner.y - display.y) * ky), videoH - 1)
  return { sx, sy, sw: Math.max(1, Math.min(inner.width * kx, videoW - sx)), sh: Math.max(1, Math.min(inner.height * ky, videoH - sy)) }
}

const two = (n: number): string => String(n).padStart(2, '0')

/**
 * A take's file name: "workshop 2026-11-10 14.03.22.mp4", in local time (dots, because Finder shows a
 * colon as a slash). A name already taken gets " 2", " 3"… so two takes in one second both survive.
 */
export function takeName(d: Date, ext: string, taken: (name: string) => boolean = () => false): string {
  const safe = /^[a-z0-9]{2,4}$/.test(ext) ? ext : 'webm'
  const stem = `workshop ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`
  let name = `${stem}.${safe}`
  for (let n = 2; taken(name) && n < 100; n++) name = `${stem} ${n}.${safe}`
  return name
}

/** A take's length as the bar shows it: 0:07, 12:41, 1:02:03. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** What the recorder remembers between takes, in core's settings. */
export interface RecPrefs {
  /** The Mac's own sound, through BlackHole. */
  sound: boolean
  /** The microphone mixed in. */
  mic: boolean
  /** Instagram's safe zones drawn in the frame (never while filming). */
  guides: boolean
  /** The 9:16 frame, or the center column. */
  fit: RecFit
}

export const REC_DEFAULTS: RecPrefs = { sound: true, mic: false, guides: true, fit: 'reel' }

/** Drops anything that is not what its field holds, field by field, over `base`. */
export function cleanPrefs(raw: unknown, base: RecPrefs = REC_DEFAULTS): RecPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (k: 'sound' | 'mic' | 'guides'): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : base[k])
  const fit: RecFit = r.fit === 'reel' || r.fit === 'center' ? r.fit : (base.fit ?? 'reel')
  return { sound: pick('sound'), mic: pick('mic'), guides: pick('guides'), fit }
}

export type RecPhase = 'idle' | 'countdown' | 'recording' | 'saving' | 'saved' | 'error'
const PHASES: RecPhase[] = ['idle', 'countdown', 'recording', 'saving', 'saved', 'error']
export const isPhase = (p: unknown): p is RecPhase => PHASES.includes(p as RecPhase)

/** What the top bar's button shows. */
export interface RecState {
  open: boolean
  phase: RecPhase
  /** When the take started filming (ms since the epoch), while recording; else 0. */
  since: number
}

/** The display a take films, as main hands it to the page. `stub`: a smoke run, which films a test pattern, never the screen. */
export interface RecSource {
  id: string
  bounds: Rect
  scale: number
  stub?: boolean
}

/** What the recorder's page gets at load: core's theme variables and the remembered settings. */
export interface RecHello {
  vars: Record<string, string>
  prefs: RecPrefs
}

/**
 * The channels between main and the recorder's own page. The preload (src/preload/recorder.ts)
 * spells them out again rather than importing this (see the top of this file); smoke drives every
 * one of them, so a drift fails there.
 */
export const REC = {
  hello: 'ws:rec:hello',
  setPrefs: 'ws:rec:set-prefs',
  passThrough: 'ws:rec:pass-through', // send
  move: 'ws:rec:move', // send
  resize: 'ws:rec:resize', // send
  close: 'ws:rec:close', // send
  phase: 'ws:rec:phase', // send
  source: 'ws:rec:source',
  audioOn: 'ws:rec:audio-on',
  audioOff: 'ws:rec:audio-off',
  begin: 'ws:rec:begin',
  chunk: 'ws:rec:chunk',
  end: 'ws:rec:end',
  reveal: 'ws:rec:reveal', // send
  play: 'ws:rec:play', // send
  // main → page
  closeAsked: 'ws:rec:close-asked',
  theme: 'ws:rec:theme'
} as const
