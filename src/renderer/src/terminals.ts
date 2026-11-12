// One persistent xterm per session. Terminals live outside React and are MOVED into whatever
// box shows them (never recreated), so focusing a session is one appendChild and one fit. Only the
// terminal on screen holds a WebGL context: Chromium caps live contexts at about sixteen a window
// (CLAUDE.md §7). Carried over from deck's lib/terminals.ts, leaner: no fox banner. Paths printed in it are links
// to the preview pane, as in deck.

import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermPalette } from '@shared/themes'
import { FONT_MONO } from '@shared/fonts'
import { pathRefs } from '@shared/paths'
import { openDoc } from './preview-store'

interface Entry {
  term: Terminal
  el: HTMLDivElement
  webgl: WebglAddon | null
  host: HTMLElement | null
  fitRaf: number
}

const entries = new Map<string, Entry>()
/** Output that arrived before a session's terminal existed. */
const pending = new Map<string, string[]>()
const PENDING_CAP = 512
/** Each session's folder, so a relative path clicked in its terminal resolves as the CLI's would. */
const cwds = new Map<string, string>()
let staging: HTMLDivElement | null = null
let palette: TermPalette | null = null

function stagingEl(): HTMLDivElement {
  if (!staging) {
    staging = document.createElement('div')
    staging.className = 'term-staging'
    document.body.appendChild(staging)
  }
  return staging
}

/** The theme's terminal palette, for every terminal now and later. */
export function setPalette(p: TermPalette): void {
  palette = p
  for (const e of entries.values()) e.term.options.theme = p
}

function ensure(id: string): Entry {
  const had = entries.get(id)
  if (had) return had
  const el = document.createElement('div')
  el.className = 'term'
  stagingEl().appendChild(el)
  const term = new Terminal({
    fontSize: 13,
    fontFamily: FONT_MONO,
    theme: palette ?? undefined,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    // Deep Space's terminal background is clear; this cannot change after open(), so it is always on.
    allowTransparency: true,
    // OSC 8 links (Claude Code writes markdown links as them; tmux.conf passes them on): http(s)
    // opens in the browser, file:// as a path (`openRef`).
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (ev, uri) => {
        if (/^https?:\/\//i.test(uri)) void window.core.openExternal(uri)
        else if (/^file:/i.test(uri)) openRef(id, fileUri(uri), ev)
      }
    }
  })
  // Paths printed in the TUI are links: hover underlines one, a click opens it in the preview pane.
  // A path the TUI broke across lines is read whole (`logicalLine`).
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const run = logicalLine(term, y)
      if (!run) return cb(undefined)
      const links = pathRefs(run.text)
        .filter((r) => run.at(r.start).y <= y && run.at(r.end - 1).y >= y)
        .map((r) => ({
          range: { start: run.at(r.start), end: run.at(r.end - 1) },
          text: r.raw,
          activate: (ev: MouseEvent) => openRef(id, r, ev)
        }))
      cb(links.length > 0 ? links : undefined)
    }
  })
  term.open(el)
  term.onData((d) => window.core.ptyInput(id, d))
  term.onBinary((d) => window.core.ptyInput(id, d))
  term.onResize(({ cols, rows }) => window.core.ptyResize(id, cols, rows))
  term.onTitleChange((t) => window.core.setTitle(id, t))
  term.onBell(() => window.core.bell(id))
  const e: Entry = { term, el, webgl: null, host: null, fitRaf: 0 }
  entries.set(id, e)
  for (const d of pending.get(id) ?? []) term.write(d)
  pending.delete(id)
  return e
}

export function writeData(id: string, data: string): void {
  const e = entries.get(id)
  if (e) return void e.term.write(data)
  const buf = pending.get(id) ?? []
  buf.push(data)
  if (buf.length > PENDING_CAP) buf.splice(0, buf.length - PENDING_CAP)
  pending.set(id, buf)
}

/** Put a session's terminal in `host` and fit it. Idempotent. `cwd` is its folder (for paths). */
export function mount(id: string, host: HTMLElement, cwd: string): void {
  if (cwd) cwds.set(id, cwd)
  const e = ensure(id)
  if (e.el.parentElement !== host) host.appendChild(e.el)
  e.host = host
  if (!e.webgl) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        e.webgl = null
        // Fall back to the DOM renderer and repaint, or the pane stays blank (deck learned this).
        e.term.refresh(0, e.term.rows - 1)
      })
      e.term.loadAddon(webgl)
      e.webgl = webgl
    } catch {
      e.webgl = null // the DOM renderer takes over by itself
    }
  }
  fit(id)
}

export function unmount(id: string, host: HTMLElement): void {
  const e = entries.get(id)
  if (!e || e.host !== host) return
  if (e.fitRaf) cancelAnimationFrame(e.fitRaf)
  e.fitRaf = 0
  e.webgl?.dispose()
  e.webgl = null
  stagingEl().appendChild(e.el)
  e.host = null
}

export function dispose(id: string): void {
  const e = entries.get(id)
  if (!e) return
  if (e.fitRaf) cancelAnimationFrame(e.fitRaf)
  e.webgl?.dispose()
  e.term.dispose()
  e.el.remove()
  entries.delete(id)
  pending.delete(id)
  cwds.delete(id)
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

/** The cell size xterm is drawing at (the private numbers its fit addon reads). */
function cellSize(term: Terminal): { w: number; h: number } | null {
  type Core = { _renderService?: { dimensions?: { css: { cell: { width: number; height: number } } } } }
  const dims = (term as unknown as { _core?: Core })._core?._renderService?.dimensions
  return dims && dims.css.cell.width > 0 && dims.css.cell.height > 0 ? { w: dims.css.cell.width, h: dims.css.cell.height } : null
}

/**
 * Size the terminal to its box, again on later frames until the size stops changing (a fit right
 * after a mount often measures mid-layout). The height left under the last whole row goes above
 * the first, so Claude Code's prompt sits flush with the bottom of the pane.
 */
export function fit(id: string, tries = 10): void {
  const e = entries.get(id)
  if (!e || !e.host) return
  if (e.fitRaf) cancelAnimationFrame(e.fitRaf)
  let last = ''
  const step = (n: number): void => {
    e.fitRaf = 0
    if (!e.host) return
    const xt = e.term.element
    const cell = cellSize(e.term)
    const w = e.el.clientWidth
    const h = e.el.clientHeight
    if (!xt || !cell || w < 2 || h < 2) {
      if (n > 0) e.fitRaf = requestAnimationFrame(() => step(n - (cell ? 1 : 0)))
      return
    }
    xt.style.paddingTop = '0px'
    const cols = Math.max(2, Math.floor(w / cell.w))
    const rows = Math.max(1, Math.floor(h / cell.h))
    if (cols !== e.term.cols || rows !== e.term.rows) e.term.resize(cols, rows)
    xt.style.paddingTop = `${Math.max(0, Math.floor(h - rows * cell.h))}px`
    const key = `${cols}x${rows}`
    if (key !== last && n > 0) {
      last = key
      e.fitRaf = requestAnimationFrame(() => step(n - 1))
    }
  }
  e.fitRaf = requestAnimationFrame(() => step(tries))
}

/**
 * A clicked path: the preview pane (text) or the lightbox viewer (a picture, a PDF, a web page…),
 * or with ⌘ held the Mac app that owns the file's type, as in deck.
 */
function openRef(id: string, r: { path: string; line: number | null }, ev: MouseEvent): void {
  const cwd = cwds.get(id) ?? ''
  if (ev.metaKey) void window.core.openFileApp(r.path, cwd)
  else openDoc({ path: r.path, line: r.line, cwd })
}

/** A file:// URL → its path (decoded), and a `#L42` / `:42` line when it carries one. */
function fileUri(uri: string): { path: string; line: number | null } {
  let path = uri
  let line: number | null = null
  try {
    const u = new URL(uri)
    path = decodeURIComponent(u.pathname)
    const m = /^#L?(\d+)/.exec(u.hash)
    if (m) line = Number(m[1])
  } catch {
    path = uri.replace(/^file:\/\//i, '')
  }
  const m = /^(.*?):(\d+)$/.exec(path)
  if (m && line === null) return { path: m[1], line: Number(m[2]) }
  return { path, line }
}

const PATH_CHAR = /[A-Za-z0-9._~@+\-/]/
/** How many screen lines one path may be read across. */
const JOIN_MAX = 4

/**
 * Line `y` (1-based) with the lines it continues into and out of, as one string and a map back to
 * cells (deck's). Two lines join when xterm wrapped them (`isWrapped`), or when the TUI did: Claude
 * Code hard-breaks a word too long for the width, so the upper line runs to the right edge ending
 * in a path character and the lower one, past its indent, starts with one. A wrong join costs only
 * a "no such file" in the pane.
 */
function logicalLine(term: Terminal, y: number): { text: string; at(i: number): { x: number; y: number } } | null {
  const buf = term.buffer.active
  const read = (row: number) => buf.getLine(row - 1)
  if (!read(y)) return null
  const cols = term.cols
  const joins = (upper: number): boolean => {
    const a = read(upper)
    const b = read(upper + 1)
    if (!a || !b) return false
    if (b.isWrapped) return true
    const top = a.translateToString(true)
    if (top.length < cols - 2 || !PATH_CHAR.test(top[top.length - 1])) return false
    const tail = /[A-Za-z0-9._~@+\-/]+$/.exec(top)?.[0] ?? ''
    if (!tail.includes('/')) return false
    return PATH_CHAR.test(b.translateToString(true).trimStart()[0] ?? '')
  }
  let first = y
  while (y - first < JOIN_MAX - 1 && first > 1 && joins(first - 1)) first--
  let last = y
  while (last - first < JOIN_MAX - 1 && joins(last)) last++
  let text = ''
  const starts: { i: number; x0: number; y: number }[] = []
  for (let row = first; row <= last; row++) {
    const line = read(row)!
    // A row xterm wrapped into the next keeps its trailing cells: they are part of the text.
    let str = line.translateToString(!(row < last && read(row + 1)?.isWrapped))
    let x0 = 0
    if (row > first && !line.isWrapped) {
      // A TUI continuation: drop its indent.
      const lead = str.length - str.trimStart().length
      str = str.slice(lead)
      x0 = lead
    }
    starts.push({ i: text.length, x0, y: row })
    text += str
  }
  return {
    text,
    at(i) {
      let s = starts[0]
      for (const st of starts) if (st.i <= i) s = st
      return { x: s.x0 + (i - s.i) + 1, y: s.y }
    }
  }
}

// Output from every session, and a session whose pty went away.
window.core.onPtyData((id, data) => writeData(id, data))
