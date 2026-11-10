// `workshop.files`: a tile reads only what the user picked for it. A pick opens the macOS chooser
// in main; the folder (or file) chosen becomes a GRANT for that tile, kept in its data folder so it
// survives restarts. The page gets a handle and the name, never the absolute path (it would carry
// the user's name off the machine with any `net` permission). Files are read through the tile's
// own origin, tile://<id>/~files/<handle>/<path>, streamed by the protocol handler, so a disc image
// never crosses IPC whole. Every read resolves symlinks and must stay inside the grant.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

export interface Grant {
  handle: string
  name: string
  kind: 'folder' | 'file'
  /** Real path. Never sent to the page. */
  path: string
}

export interface Entry {
  name: string
  kind: 'folder' | 'file'
  size: number
}

export const FILES_PREFIX = '/~files/'
const MAX_GRANTS = 16
const MAX_ENTRIES = 5000

export class TileGrants {
  private grants: Grant[] | null = null

  constructor(private readonly file: string) {}

  static forTile(dataDir: string, id: string): TileGrants {
    return new TileGrants(join(dataDir, id, 'grants.json'))
  }

  async list(): Promise<Grant[]> {
    if (this.grants) return this.grants
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Grant[]
      this.grants = Array.isArray(raw) ? raw.filter((g) => g && typeof g.handle === 'string' && typeof g.path === 'string') : []
    } catch {
      this.grants = []
    }
    return this.grants
  }

  /** What the page may see of a grant. */
  static public(g: Grant): Omit<Grant, 'path'> {
    return { handle: g.handle, name: g.name, kind: g.kind }
  }

  /** Grants `path` (picked by the user). Picking the same place again returns the grant it has. */
  async add(path: string): Promise<Grant> {
    const real = await realpath(path)
    const st = await stat(real)
    const grants = await this.list()
    const had = grants.find((g) => g.path === real)
    if (had) return had
    const g: Grant = { handle: randomBytes(6).toString('hex'), name: basename(real), kind: st.isDirectory() ? 'folder' : 'file', path: real }
    this.grants = [...grants, g].slice(-MAX_GRANTS)
    await this.save()
    return g
  }

  async forget(handle: string): Promise<boolean> {
    const grants = await this.list()
    const next = grants.filter((g) => g.handle !== handle)
    if (next.length === grants.length) return false
    this.grants = next
    await this.save()
    return true
  }

  private async save(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.grants), { mode: 0o600 })
    await rename(tmp, this.file)
  }

  /**
   * The real path of `rel` inside the grant, or null if the grant is unknown or the path leaves it
   * (`..`, an absolute path, a symlink pointing out). A file grant answers only to ''.
   */
  async resolve(handle: string, rel: string): Promise<{ grant: Grant; path: string } | null> {
    const grant = (await this.list()).find((g) => g.handle === handle)
    if (!grant || rel.includes('\0')) return null
    if (grant.kind === 'file') return rel === '' || rel === '/' ? { grant, path: grant.path } : null
    try {
      const real = await realpath(resolve(grant.path, '.' + sep + rel))
      return real === grant.path || real.startsWith(grant.path + sep) ? { grant, path: real } : null
    } catch {
      return null
    }
  }

  async entries(handle: string, rel: string): Promise<Entry[]> {
    const r = await this.resolve(handle, rel)
    if (!r || !(await stat(r.path)).isDirectory()) throw new Error('files: no such folder in what was picked')
    const out: Entry[] = []
    for (const d of (await readdir(r.path, { withFileTypes: true })).slice(0, MAX_ENTRIES)) {
      if (d.name.startsWith('.')) continue
      // A symlink is listed only if it stays inside the grant.
      const inside = await this.resolve(handle, join(rel, d.name))
      if (!inside) continue
      const st = await stat(inside.path).catch(() => null)
      if (st) out.push({ name: d.name, kind: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? 0 : st.size })
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  }
}
