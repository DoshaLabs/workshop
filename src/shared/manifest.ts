// The tile contract's manifest (tile.json): its shape, and the one validator core trusts. A tile
// that fails here is never registered, served or shown. Unknown keys under `permissions` are an
// error, not a warning: a tile asking for something this core does not know is a tile core cannot
// satisfy, and a typo must never quietly change what a stranger's code can do. CLAUDE.md §5.

import semver from 'semver'

/** The bridge this core implements. A tile's `workshop` range must accept it. */
export const BRIDGE_VERSION = '1.0.0'

/** A tile's own origin is tile://<id>/. */
export const TILE_SCHEME = 'tile'

export interface DoorPermission {
  ops: string[]
  /** How long core waits for the tile to answer one call. */
  timeoutMs: number
}

export interface Permissions {
  storage?: boolean
  sessions?: 'read' | 'write'
  transcripts?: boolean
  usage?: boolean
  door?: DoorPermission
  notify?: boolean
  files?: boolean
  camera?: boolean
  microphone?: boolean
  /** Hosts the page may reach: `example.com` or `*.example.com`. Nothing else gets through. */
  net?: string[]
  /** The trusted tier: a node process beside the page. Not accepted from any tile yet. */
  backend?: boolean
}

export interface Manifest {
  id: string
  name: string
  version: string
  workshop: string
  author: string
  repo?: string
  hint?: string
  icon?: string
  entry: string
  pane: boolean
  multiple: boolean
  span: number
  permissions: Permissions
}

export type Checked = { ok: true; manifest: Manifest } | { ok: false; errors: string[] }

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const OP_RE = /^[a-z][a-z0-9-]{0,31}$/
const HOST_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const DOOR_TIMEOUT_DEFAULT = 10_000
export const DOOR_TIMEOUT_MAX = 120_000

const KNOWN = new Set(['storage', 'sessions', 'transcripts', 'usage', 'door', 'notify', 'files', 'camera', 'microphone', 'net', 'backend'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A path inside the tile's folder, written with forward slashes: no absolute path, no `..`, no
 * backslash, no empty segment. Returns the error or null.
 */
export function badRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return 'must be a non-empty relative path'
  if (p.startsWith('/') || p.includes('\\') || /^[a-z]+:/i.test(p)) return 'must be relative, with forward slashes'
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'must not contain empty, "." or ".." segments'
  return null
}

export function checkManifest(raw: unknown): Checked {
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['tile.json must be a JSON object'] }
  const str = (k: string, max: number, required = true): string | undefined => {
    const v = raw[k]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
      errors.push(`${k}: ${required ? 'required, ' : ''}a string of at most ${max} characters`)
      return undefined
    }
    return v
  }

  const id = str('id', 40)
  if (id !== undefined && !ID_RE.test(id)) errors.push('id: lowercase letters, digits and dashes, 1 to 40, not starting or ending with a dash')
  const name = str('name', 40)
  const version = str('version', 64)
  if (version !== undefined && !semver.valid(version)) errors.push('version: must be a semver version, like 1.2.0')
  const range = str('workshop', 64)
  if (range !== undefined) {
    if (!semver.validRange(range)) errors.push('workshop: must be a semver range, like ^1')
    else if (!semver.satisfies(BRIDGE_VERSION, range)) errors.push(`workshop: this core implements bridge ${BRIDGE_VERSION}, which "${range}" does not accept`)
  }
  const author = str('author', 80)
  const repo = str('repo', 300, false)
  if (repo !== undefined && !/^https:\/\//.test(repo)) errors.push('repo: must be an https URL')
  const hint = str('hint', 120, false)
  const icon = str('icon', 200, false)
  if (icon !== undefined) {
    const e = badRelPath(icon)
    if (e) errors.push(`icon: ${e}`)
    else if (!icon.endsWith('.svg') && !icon.endsWith('.png')) errors.push('icon: must be an .svg or .png file')
  }
  const entry = str('entry', 200)
  if (entry !== undefined) {
    const e = badRelPath(entry)
    if (e) errors.push(`entry: ${e}`)
    else if (!entry.endsWith('.html')) errors.push('entry: must be an .html file')
  }

  const bool = (k: string): boolean => {
    const v = raw[k]
    if (v === undefined) return false
    if (typeof v !== 'boolean') errors.push(`${k}: must be true or false`)
    return v === true
  }
  const pane = bool('pane')
  const multiple = bool('multiple')
  let span = 1
  if (raw.span !== undefined) {
    if (typeof raw.span !== 'number' || !Number.isInteger(raw.span) || raw.span < 1 || raw.span > 4) errors.push('span: a whole number from 1 to 4')
    else span = raw.span
  }

  const permissions: Permissions = {}
  const p = raw.permissions ?? {}
  if (!isObj(p)) errors.push('permissions: must be an object')
  else {
    for (const k of Object.keys(p)) if (!KNOWN.has(k)) errors.push(`permissions.${k}: not a permission this core knows`)
    for (const k of ['storage', 'transcripts', 'usage', 'notify', 'files', 'camera', 'microphone'] as const) {
      if (p[k] === undefined) continue
      if (typeof p[k] !== 'boolean') errors.push(`permissions.${k}: must be true or false`)
      else if (p[k]) permissions[k] = true
    }
    if (p.sessions !== undefined) {
      if (p.sessions !== 'read' && p.sessions !== 'write') errors.push('permissions.sessions: "read" or "write"')
      else permissions.sessions = p.sessions
    }
    if (p.door !== undefined) {
      const d = p.door
      if (!isObj(d) || !Array.isArray(d.ops) || d.ops.length === 0 || d.ops.length > 32) errors.push('permissions.door: { "ops": [1 to 32 op names], "timeoutMs"?: number }')
      else {
        const ops = d.ops.filter((o): o is string => typeof o === 'string' && OP_RE.test(o))
        if (ops.length !== d.ops.length) errors.push('permissions.door.ops: each op is a lowercase word (letters, digits, dashes), at most 32 long')
        if (new Set(ops).size !== ops.length) errors.push('permissions.door.ops: listed twice')
        let timeoutMs = DOOR_TIMEOUT_DEFAULT
        if (d.timeoutMs !== undefined) {
          if (typeof d.timeoutMs !== 'number' || !Number.isInteger(d.timeoutMs) || d.timeoutMs < 100 || d.timeoutMs > DOOR_TIMEOUT_MAX) errors.push(`permissions.door.timeoutMs: a whole number from 100 to ${DOOR_TIMEOUT_MAX}`)
          else timeoutMs = d.timeoutMs
        }
        for (const k of Object.keys(d)) if (k !== 'ops' && k !== 'timeoutMs') errors.push(`permissions.door.${k}: not known`)
        permissions.door = { ops, timeoutMs }
      }
    }
    if (p.net !== undefined) {
      if (!Array.isArray(p.net) || p.net.length > 32) errors.push('permissions.net: a list of at most 32 host names')
      else {
        // A host name, never an IP: the last label must hold a letter.
        const hosts = p.net.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h) && /[a-z]/.test(h.slice(h.lastIndexOf('.') + 1)))
        if (hosts.length !== p.net.length) errors.push('permissions.net: each entry is a lowercase host name like "api.example.com" or "*.example.com" (no scheme, port, path, IP or bare "*")')
        if (hosts.length) permissions.net = hosts
      }
    }
    if (p.backend !== undefined) errors.push('permissions.backend: the trusted tier is not open to tiles in this build')
  }

  if (errors.length || !id || !name || !version || !range || !author || !entry) return { ok: false, errors: errors.length ? errors : ['incomplete manifest'] }
  return { ok: true, manifest: { id, name, version, workshop: range, author, repo, hint, icon, entry, pane, multiple, span, permissions } }
}

/** Whether `host` (from a request URL, lowercase) is one the manifest's `net` list lets through. */
export function hostAllowed(host: string, net: string[] | undefined): boolean {
  if (!net || !host) return false
  const h = host.toLowerCase().replace(/\.$/, '')
  return net.some((rule) => (rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule))
}

/** Where a request from a tile's session may go. Enforced in main on every request from a tile's session. */
export function requestAllowed(tile: { manifest: Manifest }, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  switch (u.protocol) {
    case `${TILE_SCHEME}:`:
      return u.hostname === tile.manifest.id
    case 'data:':
    case 'blob:':
      return true
    case 'devtools:':
      return true
    case 'https:':
    case 'wss:':
      return hostAllowed(u.hostname, tile.manifest.permissions.net)
    default:
      // http:, ws:, file:, chrome:, chrome-extension:, and anything else: never.
      return false
  }
}
