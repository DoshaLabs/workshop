// The file viewer's rules (main/viewer.ts serves, renderer/src/FileViewer.tsx draws): which files
// are shown in the lightbox rather than the preview pane, and how a file with no telling name is
// recognised. Pure, so test/viewer.test.ts checks it on its own.
//
// Text and markdown stay in the preview pane, where they can be edited. What a person reads but
// cannot edit as text (a picture, a PDF, a web page, a film, a sound) opens in the lightbox. A
// binary that is none of these is never drawn: the viewer says so and offers its Mac app.

export type ViewKind = 'image' | 'pdf' | 'html' | 'video' | 'audio'

/** The scheme the viewer's files are served on: `view://<grant>/<name>`, each grant its own origin. */
export const VIEW_SCHEME = 'view'

const EXT: Record<string, [ViewKind, string]> = {
  png: ['image', 'image/png'],
  apng: ['image', 'image/apng'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  jfif: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  pdf: ['pdf', 'application/pdf'],
  html: ['html', 'text/html'],
  htm: ['html', 'text/html'],
  xhtml: ['html', 'application/xhtml+xml'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  wav: ['audio', 'audio/wav'],
  flac: ['audio', 'audio/flac'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg']
}

const extOf = (name: string): string => {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** What the viewer makes of a file by its name, or null (text for the pane, or unknown). */
export function viewKindOf(name: string): ViewKind | null {
  return EXT[extOf(name)]?.[0] ?? null
}

/** The type to serve a file as: by its name, else by what its first bytes said (`sniffed`). */
export function mimeOf(name: string, sniffed?: ViewKind | null): string {
  const byName = EXT[extOf(name)]
  if (byName) return byName[1]
  if (sniffed === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

/** A file whose name says nothing, recognised by its first bytes: the formats a session writes most. */
export function sniffKind(head: Uint8Array): { kind: ViewKind; mime: string } | null {
  const at = (i: number, ...b: number[]): boolean => b.every((x, j) => head[i + j] === x)
  const ascii = (i: number, s: string): boolean => at(i, ...[...s].map((c) => c.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', mime: 'image/gif' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' }
  if (ascii(0, '%PDF-')) return { kind: 'pdf', mime: 'application/pdf' }
  return null
}

/**
 * Whether a web page at `file` may load the files in its folder (Colin, 12 Nov 2026): only when it
 * is at or below an open session's start folder or project root. Elsewhere (Downloads, the Desktop)
 * it gets the page alone, so a stranger's page cannot read its neighbours and send them out. A
 * session started in the home folder or at `/` makes nothing a project. All paths real (symlinks resolved).
 */
export function pageGetsFolder(file: string, folders: string[], home: string): boolean {
  const dir = file.replace(/\/[^/]*$/, '') || '/'
  if (dir === '/' || dir === home) return false
  return folders.some((f) => {
    const root = f.replace(/\/+$/, '')
    if (!root || root === home) return false
    return dir === root || dir.startsWith(root + '/')
  })
}

/** What the window gets for a file it asked to view. */
export type ViewDoc =
  | { path: string; name: string; kind: ViewKind; url: string; size: number }
  | { path: string; name: string; kind: 'refused'; note: string; missing?: boolean }

/**
 * A picture's caption, when a tile handed the picture over (`workshop.viewer.show`, bridge 1.9): its
 * text (wrapped) and a smaller source line beneath, both drawn under a crop only if the user ticks it.
 */
export interface ViewCaption {
  text: string
  source?: string
}

/** The longest a caption's text and source line may be; anything longer is cut with an ellipsis. */
export const CAPTION_MAX = 400
export const SOURCE_MAX = 120
/** The most a tile may hand the viewer in one picture. */
export const SHOW_MAX = 40 * 1024 * 1024

const oneLine = (s: unknown, max: number): string => {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** A tile's caption made safe to keep and draw: plain one-line text, capped; null if it has no text. */
export function cleanCaption(raw: unknown): ViewCaption | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = oneLine(r.text, CAPTION_MAX)
  if (!text) return null
  const source = oneLine(r.source, SOURCE_MAX)
  return source ? { text, source } : { text }
}

/** A crop of a picture, in the picture's own pixels. */
export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

/** The crop's shape: width over height. */
export const CROP_RATIO = 9 / 16
/** The smallest crop, as a fraction of the largest that fits, so the box stays grabbable. */
export const CROP_MIN = 0.15

/** The largest 9:16 box that fits a `w` × `h` picture. */
export function largestCrop(w: number, h: number): { w: number; h: number } {
  return w / h > CROP_RATIO ? { w: h * CROP_RATIO, h } : { w, h: w / CROP_RATIO }
}

/** The crop a picture starts with: the largest 9:16 box, centred. */
export function initialCrop(w: number, h: number): Crop {
  const b = largestCrop(w, h)
  return { x: (w - b.w) / 2, y: (h - b.h) / 2, w: b.w, h: b.h }
}

/** `c` kept 9:16, no smaller than CROP_MIN of the largest and no larger, and moved back inside the picture. */
export function clampCrop(c: Crop, w: number, h: number): Crop {
  const big = largestCrop(w, h)
  const cw = Math.min(big.w, Math.max(big.w * CROP_MIN, c.w))
  const ch = cw / CROP_RATIO
  return { x: Math.min(Math.max(0, c.x), w - cw), y: Math.min(Math.max(0, c.y), h - ch), w: cw, h: ch }
}

/**
 * The crop after dragging its bottom-right corner to (`px`, `py`), the top-left corner held: the
 * larger of the two sizes the pointer asks for, so it follows whichever way the hand moves.
 */
export function resizeCrop(c: Crop, px: number, py: number, w: number, h: number): Crop {
  const want = Math.max(px - c.x, (py - c.y) * CROP_RATIO)
  const big = largestCrop(w, h)
  const room = Math.min(w - c.x, (h - c.y) * CROP_RATIO, big.w)
  const cw = Math.min(room, Math.max(big.w * CROP_MIN, want))
  return clampCrop({ x: c.x, y: c.y, w: cw, h: cw / CROP_RATIO }, w, h)
}

/** `text` broken into lines no wider than `max`, by `measure`; a word wider than a line stands alone. */
export function wrapLines(text: string, max: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(next) > max) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** The file name a crop is saved under: the picture's name, its extension replaced. */
export const cropName = (name: string): string => `${name.replace(/\.[a-z0-9]+$/i, '') || 'picture'} 9x16.png`
