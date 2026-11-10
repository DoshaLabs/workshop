// Images for a session's prompt (track E). The CLI takes an image the way a terminal hands one
// over: as a file path in the prompt, which it reads and attaches. So a picture pasted into a
// session tile's prompt bar (bytes on the clipboard, no file) is written to `<profile>/drops/`, and
// that path is what the session is sent. A file dropped from Finder already has a lasting path and
// is used as it is; one in a temp folder (a macOS screenshot thumbnail is a file promise Chromium
// fulfils there, and dragging it cancels the save to the Desktop) is copied first. After deck's
// main/drops.ts. Copies older than 30 days are pruned on each new one.

import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'

export interface DroppedFile {
  name: string
  /** The file's own path ('' for a pasted image, which has none). */
  path?: string
  /** The bytes, for a file without a path. */
  bytes?: Uint8Array
  /** Its MIME type, as the clipboard or the drop said. */
  type?: string
}

const KEEP_MS = 30 * 24 * 3600 * 1000
/** A pasted picture larger than this is refused (the API's own limit for an image is lower still). */
export const IMAGE_MAX = 20 * 1024 * 1024
const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

/** True for a path under a temp folder, which the system may empty at any time. */
export function isTransient(p: string): boolean {
  const t = tmpdir().replace(/\/$/, '') + '/'
  return p.startsWith(t) || TEMP_ROOTS.some((r) => p.startsWith(r)) || p.includes('/TemporaryItems/')
}

/** A file name that is safe to write and readable in a prompt: no slashes, controls or spaces. */
export function safeName(name: string, type?: string): string {
  // eslint-disable-next-line no-control-regex
  let n = basename(String(name ?? '')).replace(/[\x00-\x1f/\\]/g, '').replace(/\s+/g, '-').replace(/^\.+/, '').slice(0, 80)
  if (!n || n === 'image.png') n = `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  if (!extname(n) && type && IMAGE_EXT[type]) n += IMAGE_EXT[type]
  return n
}

async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const taken = new Set(await readdir(dir).catch(() => [] as string[]))
  if (!taken.has(name)) return name
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`
}

async function prune(dir: string): Promise<void> {
  const cutoff = Date.now() - KEEP_MS
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    try {
      if ((await stat(join(dir, f))).mtimeMs < cutoff) await unlink(join(dir, f))
    } catch {
      // gone already
    }
  }
}

/** The path the session should be sent for a pasted or dropped file. Throws with a reason it can show. */
export async function keepImage(home: string, raw: unknown): Promise<string> {
  const f = (raw && typeof raw === 'object' ? raw : {}) as DroppedFile
  const path = typeof f.path === 'string' ? f.path : ''
  if (path && isAbsolute(path) && !isTransient(path)) {
    if (!(await stat(path).then((s) => s.isFile(), () => false))) throw new Error('That is not a file.')
    return path
  }
  const dir = join(home, 'drops')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  void prune(dir)
  if (path && isAbsolute(path)) {
    const dest = join(dir, await freeName(dir, safeName(f.name || basename(path), f.type)))
    await copyFile(path, dest)
    return dest
  }
  const bytes = f.bytes instanceof Uint8Array ? f.bytes : null
  if (!bytes || bytes.byteLength === 0) throw new Error('Nothing to keep: the paste had no picture in it.')
  if (!f.type || !IMAGE_EXT[f.type]) throw new Error('Only a PNG, JPEG, GIF or WebP picture can be pasted.')
  if (bytes.byteLength > IMAGE_MAX) throw new Error('That picture is larger than 20 MB.')
  const dest = join(dir, await freeName(dir, safeName(f.name, f.type)))
  await writeFile(dest, bytes, { mode: 0o600 })
  return dest
}
