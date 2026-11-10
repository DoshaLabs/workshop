// The tile index's file format: `tiles.json` in the index repo (CLAUDE.md §6), and what the + menu's
// Marketplace tab reads. It is an array of entries, one per tile, each pinned to a commit:
//
//   [{ "id": "focus-timer", "name": "Focus timer", "author": "someone", "hint": "25 minutes on",
//      "repo": "https://github.com/someone/workshop-focus-timer", "commit": "<40 hex>",
//      "version": "0.2.0", "permissions": { "storage": true, "notify": true }, "category": "tools" }]
//
// The index says what a tile asks for so the menu can show it before anything is downloaded; the
// manifest in the cloned commit is still the truth, and install refuses a tile whose manifest asks
// for something the index did not list. A bad entry is dropped with a reason, never the whole index.

import { ID_RE, checkManifest, type Permissions } from './manifest'
import semver from 'semver'

export const CATEGORIES = ['tools', 'notes', 'sessions', 'media', 'games', 'emulators', 'fun', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

export interface IndexEntry {
  id: string
  name: string
  author: string
  hint: string
  /** Where the tile's source is: an https git URL (a file:// URL or path only in a local index). */
  repo: string
  /** The commit the index vouches for, as 40 hex characters. Install checks out exactly this. */
  commit: string
  version: string
  permissions: Permissions
  category: Category
}

export interface CheckedIndex {
  entries: IndexEntry[]
  /** One line per entry that was dropped, and why. */
  errors: string[]
}

/** The most entries one index may hold. */
export const INDEX_MAX = 2000
/** The most bytes core reads of an index. */
export const INDEX_MAX_BYTES = 2 * 1024 * 1024

const COMMIT_RE = /^[0-9a-f]{40}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether `repo` is a place install may clone from. A local index (a file on this Mac) may name local repos. */
export function repoAllowed(repo: string, opts: { local?: boolean } = {}): boolean {
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?\/[^\s]+$/i.test(repo)) return true
  return !!opts.local && (/^file:\/\/\/[^\s]+$/.test(repo) || /^\/[^\s]+$/.test(repo))
}

/**
 * Checks one entry. Its permissions are checked by the manifest's own validator (a stand-in
 * manifest around them), so the index and tile.json can never disagree on what a permission is.
 */
export function checkEntry(raw: unknown, opts: { local?: boolean } = {}): { ok: true; entry: IndexEntry } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['not an object'] }
  const errors: string[] = []
  const str = (k: string, max: number): string => {
    const v = raw[k]
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
      errors.push(`${k}: required, a string of at most ${max} characters`)
      return ''
    }
    return v
  }
  const id = str('id', 40)
  if (id && !ID_RE.test(id)) errors.push('id: lowercase letters, digits and dashes')
  const name = str('name', 40)
  const author = str('author', 80)
  const hint = raw.hint === undefined ? '' : str('hint', 120)
  const repo = str('repo', 300)
  if (repo && !repoAllowed(repo, opts)) errors.push(opts.local ? 'repo: an https URL, a file:// URL or an absolute path' : 'repo: must be an https URL')
  const commit = str('commit', 40)
  if (commit && !COMMIT_RE.test(commit)) errors.push('commit: the full commit id, 40 lowercase hex characters')
  const version = str('version', 64)
  if (version && !semver.valid(version)) errors.push('version: a semver version, like 1.2.0')
  const category = raw.category === undefined ? 'other' : raw.category
  if (!CATEGORIES.includes(category as Category)) errors.push(`category: one of ${CATEGORIES.join(', ')}`)
  for (const k of Object.keys(raw)) if (!['id', 'name', 'author', 'hint', 'repo', 'commit', 'version', 'permissions', 'category'].includes(k)) errors.push(`${k}: not a field of an index entry`)

  let permissions: Permissions = {}
  // The trusted tier is for tiles that ship with workshop; the index never lists one (for now).
  if (isObj(raw.permissions) && 'backend' in raw.permissions) errors.push('permissions.backend: the trusted tier is not open to tiles from the index')
  const stand = checkManifest({ id: 'x', name: 'x', version: '0.0.0', workshop: '*', author: 'x', entry: 'index.html', permissions: raw.permissions ?? {} })
  if (stand.ok) permissions = stand.manifest.permissions
  else errors.push(...stand.errors)

  return errors.length ? { ok: false, errors } : { ok: true, entry: { id, name, author, hint, repo, commit, version, permissions, category: category as Category } }
}

/** Reads a whole index. Entries that fail are dropped with a reason; a second entry with an id already listed is dropped too. */
export function checkIndex(raw: unknown, opts: { local?: boolean } = {}): CheckedIndex {
  if (!Array.isArray(raw)) return { entries: [], errors: ['tiles.json must be a JSON array of entries'] }
  const entries: IndexEntry[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const [i, item] of raw.slice(0, INDEX_MAX).entries()) {
    const label = isObj(item) && typeof item.id === 'string' ? `${item.id}` : `entry ${i + 1}`
    const r = checkEntry(item, opts)
    if (!r.ok) errors.push(`${label}: ${r.errors.join('; ')}`)
    else if (seen.has(r.entry.id)) errors.push(`${label}: listed twice`)
    else {
      seen.add(r.entry.id)
      entries.push(r.entry)
    }
  }
  if (raw.length > INDEX_MAX) errors.push(`only the first ${INDEX_MAX} entries are read`)
  return { entries, errors }
}
