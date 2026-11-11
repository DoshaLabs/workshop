// The preview pane's reading and writing (CLAUDE.md §3 "Preview pane"). The window never touches
// the disk: it asks main for a file, and main says what it is. Text and markdown come back whole;
// a folder, a binary, a file over PREVIEW_MAX or one that is missing comes back as a polite note.
//
// Writes are careful, after deck's main/files.ts: only an existing regular file that is text, valid
// UTF-8 and unchanged since the pane read it (the mtime it read is the lock), written atomically (a
// temp file beside it, then a rename, keeping the file's mode; a symlink is followed, so the link
// stays a link). A task tick changes one character of one line (shared/preview.ts toggleTask).
//
// The file the pane shows is watched (stat polling, which survives an editor replacing the file
// by rename); a change is pushed to the window, which reloads it or, with unsaved edits, says so.
//
// The door's half: a session runs `node "$WORKSHOP_DOC" open <path> [--line N]` (bin/workshop-doc.mjs),
// which POSTs to /core/doc with the session's own token. Only a session may; the window is told
// to show the file.

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { chmod, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { CH } from '@shared/ipc'
import { PREVIEW_MAX, isMarkdownName, toggleTask, type PreviewDoc, type PreviewRef, type PreviewWrite } from '@shared/preview'

/** The absolute path a reference means: `~/x`, `/x`, or relative to `cwd` (else home). */
export function resolveRef(ref: string, cwd?: string): string {
  let p = String(ref ?? '').trim().replace(/^['"]+|['"]+$/g, '')
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  return isAbsolute(p) ? normalize(p) : resolve(cwd && isAbsolute(cwd) ? cwd : homedir(), p)
}

/** True when the head of the file looks binary: a NUL byte, or too much of it unprintable. */
async function looksBinary(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    let odd = 0
    for (let i = 0; i < bytesRead; i++) {
      const b = buf[i]
      if (b === 0) return true
      if (b < 9 || (b > 13 && b < 32)) odd++
    }
    return bytesRead > 0 && odd / bytesRead > 0.1
  } finally {
    await fh.close()
  }
}

const sizeOf = (n: number): string => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)

/** Everything the pane needs about one path. Never throws: trouble comes back as a note. */
export async function readDoc(ref: string, cwd?: string): Promise<PreviewDoc> {
  const path = resolveRef(ref, cwd)
  const name = basename(path) || path
  const refused = (note: string, size = 0, mtime = 0): PreviewDoc => ({ path, name, kind: 'refused', note, size, mtime })
  let s: Stats
  try {
    s = await stat(path)
  } catch {
    return { ...refused('There is no such file.'), missing: true }
  }
  if (s.isDirectory()) return refused('This is a folder. The preview pane shows one file at a time.', 0, s.mtimeMs)
  if (!s.isFile()) return refused('This is not a regular file.', 0, s.mtimeMs)
  if (s.size > PREVIEW_MAX) return refused(`This file is ${sizeOf(s.size)}, too large to show here (the pane takes up to ${sizeOf(PREVIEW_MAX)}).`, s.size, s.mtimeMs)
  try {
    if (await looksBinary(path)) return refused('This is a binary file, not text, so there is nothing to show here.', s.size, s.mtimeMs)
    const buf = await readFile(path)
    const text = buf.toString('utf8')
    // Read again if it changed while being read: the mtime handed back must be the text's.
    const after = await stat(path)
    if (after.mtimeMs !== s.mtimeMs) return readDoc(path)
    return { path, name, kind: isMarkdownName(name) ? 'markdown' : 'text', text, size: buf.length, mtime: s.mtimeMs }
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err), s.size, s.mtimeMs)
  }
}

/** The file behind `path` if the pane may write it, unchanged since it was read at `mtime`. */
async function writable(path: string, mtime: number): Promise<{ real: string; mode: number; text: string } | { error: string; stale?: boolean }> {
  const doc = await readDoc(path)
  if (doc.kind === 'refused') return { error: doc.note ?? 'This file cannot be edited here.' }
  let real: string
  try {
    real = await realpath(doc.path)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const s = await stat(real)
  if (s.mtimeMs !== mtime) return { error: 'The file changed on disk since it was read.', stale: true }
  const buf = await readFile(real)
  if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) return { error: 'This file is not UTF-8 text: saving it here could change bytes you did not touch.' }
  return { real, mode: s.mode & 0o7777, text: buf.toString('utf8') }
}

/** A temp file in the same folder, then a rename over the original: a reader never sees half a file. */
async function replaceFile(real: string, mode: number, data: string): Promise<void> {
  const tmp = join(dirname(real), `.${basename(real)}.workshop-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data, { mode, flag: 'wx' })
    await chmod(tmp, mode) // writeFile's mode passes through the umask
    await rename(tmp, real)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function commit(path: string, mtime: number, next: (text: string) => string | { error: string }): Promise<PreviewWrite> {
  try {
    const w = await writable(resolveRef(path), mtime)
    if ('error' in w) return { ok: false, error: w.error, stale: w.stale }
    const out = next(w.text)
    if (typeof out !== 'string') return { ok: false, error: out.error, stale: true }
    if (Buffer.byteLength(out) > PREVIEW_MAX) return { ok: false, error: `That would make the file larger than ${sizeOf(PREVIEW_MAX)}, the most the pane edits.` }
    await replaceFile(w.real, w.mode, out)
    return { ok: true, doc: await readDoc(path) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The edit mode's save: the whole text, over the file the pane read at `mtime`. */
export function writeDoc(path: string, text: string, mtime: number): Promise<PreviewWrite> {
  return commit(path, mtime, () => String(text ?? ''))
}

/** A task box: line `line` (0-based) must still be a task that is `checked`; only its mark changes. */
export function tickTask(path: string, line: number, checked: boolean, mtime: number): Promise<PreviewWrite> {
  return commit(path, mtime, (text) => {
    const r = toggleTask(text, line, checked)
    return 'error' in r ? r : r.text
  })
}

export interface Preview {
  /** A session's `open` through the door: checks the file and tells the window to show it. */
  call(name: string, payload: unknown, session: { id: string; cwd: string }): Promise<unknown>
  stop(): void
}

/**
 * The IPC core's window reads and writes through (core's window only: `handle` checks the
 * sender), and the door's `doc` call.
 */
export function startPreview(o: { win: () => BrowserWindow | null; handle: (ch: string, fn: (...a: any[]) => unknown) => void }): Preview {
  const send = (ch: string, ...a: unknown[]): void => {
    const w = o.win()
    if (w && !w.isDestroyed()) w.webContents.send(ch, ...a)
  }

  // One file is watched at a time: the one the pane shows.
  let watched: string | null = null
  const onChange = (cur: Stats, prev: Stats): void => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) send(CH.previewChanged, watched, cur.mtimeMs)
  }
  const watch = (path: string | null): void => {
    if (watched) unwatchFile(watched, onChange)
    watched = typeof path === 'string' && isAbsolute(path) ? path : null
    if (watched) watchFile(watched, { interval: 500, persistent: false }, onChange)
  }

  o.handle(CH.previewRead, (path: string, cwd?: string) => readDoc(String(path), typeof cwd === 'string' ? cwd : undefined))
  o.handle(CH.previewWrite, (path: string, text: string, mtime: number) => writeDoc(String(path), String(text), Number(mtime)))
  o.handle(CH.previewTask, (path: string, line: number, checked: boolean, mtime: number) => tickTask(String(path), Number(line), checked === true, Number(mtime)))
  o.handle(CH.previewWatch, (path: string | null) => watch(path))
  // ⌘-click on a path (deck's): the file in the app that owns its type. Never anything that would
  // run: an app bundle, a script macOS opens in Terminal, or an executable file.
  o.handle(CH.previewOpenApp, async (path: string, cwd?: string) => {
    const p = resolveRef(String(path), typeof cwd === 'string' ? cwd : undefined)
    const st = await stat(p).catch(() => null)
    if (!st) return false
    if (/\.(app|command|tool|terminal|workflow|action|scpt|scptd|applescript|pkg|mpkg|dmg|sh|zsh|bash|webloc|inetloc|fileloc)\/?$/i.test(p)) return false
    if (st.isFile() && (st.mode & 0o111) !== 0) return false
    return (await shell.openPath(p)) === ''
  })

  return {
    async call(name, payload, session) {
      if (name !== 'doc') throw new Error(`no such call: ${name}`)
      const b = (payload ?? {}) as { op?: unknown; path?: unknown; line?: unknown }
      if (b.op !== 'open') throw new Error(`unknown op "${String(b.op)}": the preview pane knows "open"`)
      if (typeof b.path !== 'string' || !b.path) throw new Error('open which file?')
      const doc = await readDoc(b.path, session.cwd)
      if (doc.missing) throw new Error(`no such file: ${doc.path}`)
      const line = Number.isInteger(b.line) && (b.line as number) > 0 ? (b.line as number) : null
      const w = o.win()
      if (!w || w.isDestroyed()) throw new Error('workshop has no window open')
      if (w.isMinimized()) w.restore()
      const ref: PreviewRef = { path: doc.path, line, cwd: session.cwd }
      send(CH.previewOpen, ref, session.id)
      return { path: doc.path, kind: doc.kind, editable: doc.kind !== 'refused', ...(line ? { line } : {}), ...(doc.kind === 'refused' ? { note: doc.note } : {}) }
    },
    stop() {
      watch(null)
    }
  }
}
