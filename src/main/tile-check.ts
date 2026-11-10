// `workshop tile check <folder>`: everything core checks before it will load a tile, run from the
// shell, for authors, for the Claude building a tile (which cannot see the window), and for the
// index's CI. The manifest is checked by the one validator core trusts (shared/manifest.ts) and the
// plugin by the one core uses (plugin.ts); this adds what only the folder can tell: the page and
// icon are really there, inside it, and nothing in it needs the trusted tier.
//
// No electron here: bin/workshop.mjs runs this with plain node, from out/check/tile-check.mjs
// (vite.check.config.ts). Install runs it on every clone too, so a tile that passes here is one
// install will take.

import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { checkManifest, devServerOrigin, type Manifest } from '../shared/manifest'
import { checkPlugin } from './plugin'

export interface FolderCheck {
  ok: boolean
  folder: string
  /** The manifest, when it passed. */
  manifest: Manifest | null
  /** What stops core loading the tile. */
  errors: string[]
  /** What core will load, but probably not the way the author meant. */
  warnings: string[]
}

export interface CheckOpts {
  /** The folder is loaded with `workshop tile dev`: its entry may be a dev server. */
  dev?: boolean
  /** The folder is a tile that ships with workshop (tiles/ in the app): the only place a backend is allowed. */
  builtin?: boolean
}

/** Where the trusted tier would live. Its presence alone marks a tile as wanting full access. */
export const BACKEND_FILE = 'backend.mjs'
/** Above this a tile is probably carrying something it should not (a game, a model, node_modules). */
const BIG_BYTES = 50 * 1024 * 1024
const ICON_MAX = 256 * 1024

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Whether a raw tile.json (or the folder) asks for the trusted tier: a `backend` key at the top
 * (as track B's design writes it) or under permissions (as v1's manifest names it), or a
 * backend.mjs in the folder. Returns the reason, or null.
 */
export function wantsBackend(raw: unknown, hasBackendFile: boolean): string | null {
  if (isObj(raw) && 'backend' in raw) return 'it declares "backend"'
  if (isObj(raw) && isObj(raw.permissions) && 'backend' in raw.permissions) return 'it declares "permissions.backend"'
  if (hasBackendFile) return `it has a ${BACKEND_FILE}`
  return null
}

export const TRUSTED_ONLY = 'the trusted tier (a backend with full access to the Mac) is only for tiles that ship with workshop'

export async function checkTileFolder(folder: string, opts: CheckOpts = {}): Promise<FolderCheck> {
  const errors: string[] = []
  const warnings: string[] = []
  const out = (manifest: Manifest | null): FolderCheck => ({ ok: errors.length === 0, folder, manifest: errors.length ? null : manifest, errors, warnings })

  let root: string
  try {
    root = await realpath(resolve(folder))
    if (!(await stat(root)).isDirectory()) throw new Error('not a folder')
  } catch {
    errors.push(`${folder}: not a folder`)
    return out(null)
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, 'tile.json'), 'utf8'))
  } catch (err) {
    errors.push(`tile.json: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : (err as Error).message}`)
    return out(null)
  }

  const hasBackendFile = await stat(join(root, BACKEND_FILE)).then(() => true, () => false)
  const backend = wantsBackend(raw, hasBackendFile)
  let forManifest = raw
  if (backend && !opts.builtin) {
    errors.push(`backend: ${TRUSTED_ONLY}, and ${backend}`)
    // Checked without it, so the rest of the report is about the rest of the tile.
    if (isObj(raw)) {
      const { backend: _b, ...rest } = raw
      forManifest = isObj(rest.permissions) ? { ...rest, permissions: Object.fromEntries(Object.entries(rest.permissions).filter(([k]) => k !== 'backend')) } : rest
    }
  }

  const checked = checkManifest(forManifest, { dev: opts.dev })
  if (!checked.ok) {
    errors.push(...checked.errors)
    return out(null)
  }
  const m = checked.manifest

  // The page: a file inside the folder (a dev server is checked by loading it, not here).
  if (!devServerOrigin(m.entry)) {
    try {
      const entry = await realpath(resolve(root, m.entry))
      if (!inside(root, entry)) errors.push(`entry: ${m.entry} points outside the folder`)
      else if (!(await stat(entry)).isFile()) errors.push(`entry: ${m.entry} is not a file`)
      else if (!/http-equiv=["']?content-security-policy/i.test(await readFile(entry, 'utf8'))) warnings.push(`entry: ${m.entry} has no Content-Security-Policy <meta>; the starter's is a good one to keep`)
    } catch {
      errors.push(`entry: ${m.entry} does not exist (the built page must be committed in the folder; nothing is built on install)`)
    }
  }

  if (!m.icon) warnings.push('icon: none declared; the head will show the first letter of the name')
  else {
    try {
      const icon = await realpath(resolve(root, m.icon))
      if (!inside(root, icon)) errors.push(`icon: ${m.icon} points outside the folder`)
      else if ((await stat(icon)).size > ICON_MAX) warnings.push(`icon: ${m.icon} is over ${ICON_MAX / 1024} KB and will not be shown`)
    } catch {
      errors.push(`icon: ${m.icon} does not exist`)
    }
  }

  const plugin = await checkPlugin(root, m.id)
  if (!plugin.ok) errors.push(...plugin.errors)

  if (!m.repo) warnings.push('repo: none; the index needs the https URL of the tile\'s git repo')

  // What install would do differently from this folder: it fetches no submodules, makes no
  // symlinks and runs nothing, so a tile that leans on any of them works here and not there.
  if (await stat(join(root, '.gitmodules')).then(() => true, () => false)) warnings.push('.gitmodules: submodules are never fetched on install; commit what the tile needs')
  const walk = await walkFolder(root)
  if (walk.symlinks.length) warnings.push(`symlinks (${walk.symlinks.slice(0, 3).join(', ')}${walk.symlinks.length > 3 ? ', …' : ''}): install checks a tile out without them, as plain files`)
  if (walk.bytes > BIG_BYTES) warnings.push(`the folder holds ${Math.round(walk.bytes / 1024 / 1024)} MB; a tile should be its page and little else`)
  if (walk.nodeModules) warnings.push('node_modules: never installed on the user\'s side; the built page must not need it')

  return out(m)
}

/** Sizes and symlinks under `root`, skipping .git and node_modules (noted, not read). */
async function walkFolder(root: string): Promise<{ bytes: number; symlinks: string[]; nodeModules: boolean }> {
  const r = { bytes: 0, symlinks: [] as string[], nodeModules: false }
  const go = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 12) return
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name)
      const relp = rel ? `${rel}/${e.name}` : e.name
      if (e.name === '.git') continue
      if (e.name === 'node_modules') {
        r.nodeModules = true
        continue
      }
      if (e.isSymbolicLink()) r.symlinks.push(relp)
      else if (e.isDirectory()) await go(p, relp, depth + 1)
      else if (e.isFile()) r.bytes += (await lstat(p).catch(() => ({ size: 0 }))).size
    }
  }
  await go(root, '', 0)
  return r
}

/** The report as a person reads it. */
export function formatCheck(c: FolderCheck): string {
  const lines: string[] = []
  lines.push(c.ok ? `ok  ${c.manifest!.name} (${c.manifest!.id} ${c.manifest!.version}) in ${c.folder}` : `refused  ${c.folder}`)
  for (const e of c.errors) lines.push(`  error    ${e}`)
  for (const w of c.warnings) lines.push(`  warning  ${w}`)
  return lines.join('\n')
}
