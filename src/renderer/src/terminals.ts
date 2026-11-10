// One persistent xterm per session. Terminals live outside React and are MOVED into whatever
// box shows them (never recreated), so focusing a session is one appendChild and one fit. Only the
// terminal on screen holds a WebGL context: Chromium caps live contexts at about sixteen a window
// (CLAUDE.md §7). Carried over from deck's lib/terminals.ts, leaner: no fox banner, no file links yet.

import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermPalette } from '@shared/themes'

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
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    theme: palette ?? undefined,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    // Deep Space's terminal background is clear; this cannot change after open(), so it is always on.
    allowTransparency: true,
    // OSC 8 links (Claude Code writes markdown links as them): http(s) opens in the browser.
    linkHandler: {
      activate: (_ev, uri) => {
        if (/^https?:\/\//i.test(uri)) void window.core.openExternal(uri)
      }
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

/** Put a session's terminal in `host` and fit it. Idempotent. */
export function mount(id: string, host: HTMLElement): void {
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

// Output from every session, and a session whose pty went away.
window.core.onPtyData((id, data) => writeData(id, data))
