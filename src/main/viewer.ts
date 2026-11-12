// The file viewer's main half (CLAUDE.md §3 "Preview pane"): a picture, a PDF, a web page, a film
// or a sound a session points at, shown in core's lightbox. The window never reads the disk: it
// asks main to view a path, and main hands back a `view://<grant>/<name>` URL for that one file.
//
// Every grant is its own origin, never core's, so a page shown here (an HTML report a session
// wrote) cannot reach core's window or its bridge, and the window's CSP lets these URLs into an
// <img>, <video>, <audio> or <iframe> only. A grant serves exactly the file it was made for, except
// a web page's, which also serves the files beside and below it (its stylesheets, scripts and
// pictures), never above, never through a symlink that leads out, and only when the page is inside
// an open session's start folder or project root (Colin, 12 Nov 2026; shared/viewer.ts
// pageGetsFolder): a page from Downloads gets itself alone. Decided when the grant is made. Grants
// are kept only for the last few files.
//
// Esc closes the viewer even when the focus is inside the page it shows (a PDF, a web page): keys
// there never reach the window's own listeners, so main catches Esc for the window while a viewer
// is open, as it does for a tile's overlay.

import { BrowserWindow, dialog, net, protocol, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '@shared/ipc'
import { SHOW_MAX, VIEW_SCHEME, mimeOf, pageGetsFolder, sniffKind, viewKindOf, type ViewDoc, type ViewKind } from '@shared/viewer'
import { resolveRef } from './preview'

interface Grant {
  /** The file itself, resolved through any symlinks. */
  file: string
  /** A web page's folder, whose files it may load; null serves the file alone. */
  root: string | null
  mime: string
}

/** The last grants handed out, oldest first. A viewer shows one file; a few spare cover a quick back and forth. */
const grants = new Map<string, Grant>()
const KEEP = 8
let viewing = false
/** The open sessions' start folders and project roots: a web page inside one gets its folder. */
let sessionFolders: () => Promise<string[]> = async () => []

export function setSessionFolders(fn: () => Promise<string[]>): void {
  sessionFolders = fn
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

async function head(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(16)
    const { bytesRead } = await fh.read(buf, 0, 16, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** What the viewer can show of `ref`: a URL on its own origin, or why not. Never throws. */
export async function viewFile(ref: string, cwd?: string): Promise<ViewDoc> {
  const path = resolveRef(ref, cwd)
  const name = basename(path) || path
  const refused = (note: string, missing = false): ViewDoc => ({ path, name, kind: 'refused', note, ...(missing ? { missing } : {}) })
  try {
    const s = await stat(path).catch(() => null)
    if (!s) return refused('There is no such file.', true)
    if (!s.isFile()) return refused(s.isDirectory() ? 'This is a folder, not a file.' : 'This is not a regular file.')
    const real = await realpath(path)
    let kind: ViewKind | null = viewKindOf(name)
    let mime = mimeOf(name)
    if (!kind) {
      const sniffed = sniffKind(await head(real))
      if (!sniffed) return refused('This file is not something workshop can show. ⌘-click its path to open it in its own app.')
      kind = sniffed.kind
      mime = sniffed.mime
    }
    const home = await realpath(homedir()).catch(() => homedir())
    const folders = kind === 'html' ? await Promise.all((await sessionFolders().catch(() => [])).map((f) => realpath(f).catch(() => f))) : []
    const root = kind === 'html' && pageGetsFolder(real, folders, home) ? dirname(real) : null
    const token = randomBytes(12).toString('hex')
    grants.set(token, { file: real, root, mime })
    while (grants.size > KEEP) grants.delete(grants.keys().next().value!)
    const rel = root ? real.slice(root.length + 1) : basename(real)
    const url = `${VIEW_SCHEME}://${token}/${rel.split(sep).map(encodeURIComponent).join('/')}`
    return { path, name, kind, url, size: s.size }
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err))
  }
}

const notFound = (): Response => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })

/** The `view://` handler, on the session core's window uses. Answers only what a grant allows. */
async function serve(req: Request): Promise<Response> {
  let u: URL
  try {
    u = new URL(req.url)
  } catch {
    return notFound()
  }
  const g = grants.get(u.hostname)
  if (!g) return notFound()
  let rel: string
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  } catch {
    return notFound()
  }
  let target: string
  if (!g.root) {
    if (rel !== basename(g.file)) return notFound()
    target = g.file
  } else {
    if (rel.split('/').some((p) => p === '..' || p === '.')) return notFound()
    const real = await realpath(`${g.root}/${rel}`).catch(() => null)
    if (!real || !within(g.root, real)) return notFound()
    const s = await stat(real).catch(() => null)
    if (!s?.isFile()) return notFound()
    target = real
  }
  const res = await net.fetch(pathToFileURL(target).href, { headers: req.headers })
  const headers = new Headers(res.headers)
  // The file granted keeps the type it was granted as (a sniffed one has no telling name); a page's
  // own files go by their names, else by what Chromium's file loader said.
  const byName = mimeOf(target)
  headers.set('Content-Type', target === g.file ? g.mime : byName !== 'application/octet-stream' ? byName : (res.headers.get('Content-Type') ?? byName))
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  // A picture granted may be read into core's own canvas (the viewer's 9:16 crop), so it is sent
  // with CORS; a page and its files never are, so one grant still cannot read another's page.
  if (target === g.file && g.mime.startsWith('image/')) headers.set('Access-Control-Allow-Origin', '*')
  return new Response(res.body, { status: res.status, headers })
}

/**
 * The head's "download": a copy of the file the viewer shows, saved where the user picks in the Mac's
 * save dialog (~/Downloads first; the dialog asks before replacing). Only a file with a live grant,
 * so the window cannot use it to copy any path it names. The copy's path, or null.
 */
export async function saveViewed(path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => null)
  if (!real || ![...grants.values()].some((g) => g.file === real)) return null
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = { defaultPath: join(homedir(), 'Downloads', basename(real)) }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return null
  if ((await realpath(r.filePath).catch(() => r.filePath)) === real) return real
  await copyFile(real, r.filePath)
  return r.filePath
}

/** What a picture's first bytes say it is, if they say it is a picture the viewer draws. */
const pictureType = (b: Uint8Array): string | null => {
  const s = sniffKind(b.subarray(0, 16))
  return s?.kind === 'image' ? s.mime : null
}
const EXT_OF: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * A picture a tile handed over (`workshop.viewer.show`, bridge 1.9), kept in `dir` (the profile's
 * `viewer/`, the last few only) so the viewer serves it as it serves any file. Its first bytes must
 * say it is a PNG, JPEG, GIF or WebP; the name is the tile's, made safe, with the true extension.
 */
export async function keepShown(dir: string, data: Uint8Array, name: string): Promise<string> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('viewer.show: data must be the picture\'s bytes')
  if (data.byteLength > SHOW_MAX) throw new Error(`viewer.show: at most ${SHOW_MAX / (1024 * 1024)} MB`)
  const mime = pictureType(data)
  if (!mime || !EXT_OF[mime]) throw new Error('viewer.show: only a PNG, JPEG, GIF or WebP picture')
  const stem = String(name ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\p{L}\p{N} ._()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'picture'
  await mkdir(dir, { recursive: true })
  const old = (await readdir(dir).catch(() => [] as string[])).sort()
  for (const f of old.slice(0, Math.max(0, old.length - KEEP + 1))) await rm(join(dir, f), { recursive: true, force: true })
  // A folder per picture keeps the name the user will see, with no clash between two of one name.
  const sub = join(dir, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
  await mkdir(sub)
  const file = join(sub, `${stem}.${EXT_OF[mime]}`)
  await writeFile(file, data)
  return file
}

/**
 * The viewer's crop, saved: a PNG core's own window drew, written where the user picks in the save
 * dialog (~/Downloads first). The copy's path, or null if cancelled.
 */
export async function saveCrop(data: Uint8Array, name: string): Promise<string | null> {
  const png = data instanceof Uint8Array && data.byteLength > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  if (!png) throw new Error('not a PNG')
  const safe = basename(String(name || 'picture.png')).replace(/^\.+/, '') || 'picture.png'
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = { defaultPath: join(homedir(), 'Downloads', safe), filters: [{ name: 'PNG', extensions: ['png'] }] }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return null
  await writeFile(r.filePath, data)
  return r.filePath
}

/** Serves `view://` and answers the window's IPC (core's window only: `handle` checks the sender). */
export function startViewer(o: { handle: (ch: string, fn: (...a: any[]) => unknown) => void }): void {
  if (!protocol.isProtocolHandled(VIEW_SCHEME)) protocol.handle(VIEW_SCHEME, serve)
  o.handle(CH.viewFile, (path: string, cwd?: string) => viewFile(String(path), typeof cwd === 'string' ? cwd : undefined))
  o.handle(CH.viewSave, (path: string) => saveViewed(String(path)))
  o.handle(CH.viewSaveCrop, (data: Uint8Array, name: string) => saveCrop(data, String(name)))
  o.handle(CH.viewOpen, (open: boolean) => {
    viewing = open === true
  })
}

/** Esc in core's window, wherever its focus is, closes an open viewer and goes no further. */
export function escClosesViewer(wc: WebContents): void {
  wc.on('before-input-event', (ev, input) => {
    if (viewing && input.type === 'keyDown' && input.key === 'Escape') {
      ev.preventDefault()
      wc.send(CH.viewClose)
    }
  })
}
