// The tile contract's manifest (tile.json): its shape, and the one validator core trusts. A tile
// that fails here is never registered, served or shown. Unknown keys under `permissions` are an
// error, not a warning: a tile asking for something this core does not know is a tile core cannot
// satisfy, and a typo must never quietly change what a stranger's code can do. CLAUDE.md §5.

import semver from 'semver'

/** The bridge this core implements. A tile's `workshop` range must accept it. */
/** 1.1: `overlay` (the tile's page over the whole window). 1.2: `backend` (the trusted tier, built-in tiles only). */
export const BRIDGE_VERSION = '1.2.0'

/** A tile's own origin is tile://<id>/. */
export const TILE_SCHEME = 'tile'

export interface DoorPermission {
  ops: string[]
  /** How long core waits for the tile to answer one call. */
  timeoutMs: number
}

/**
 * The trusted tier: a node program beside the page (`backend.mjs`), with full access to the Mac.
 * Declared at the top of tile.json, not under permissions, because it is not something the page
 * may do but a second program the tile ships. CLAUDE.md §5 "Two trust tiers".
 */
export interface BackendDecl {
  /** The program, a .mjs file inside the tile's folder. */
  entry: string
  /** What the page may ask it, by name. Anything else is refused by core before it gets there. */
  ops: string[]
  /** How long core waits for one answer. */
  timeoutMs: number
}

/** Why an installed or local tile may not have a backend. The one sentence every refusal uses. */
export const TRUSTED_ONLY = 'the trusted tier (a backend with full access to the Mac) is only for tiles that ship with workshop'

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
  /**
   * `workshop.openOverlay()`: the tile's page laid over the whole window (a lightbox), under a
   * strip core draws with the tile's name and a close button. A permission, not a layout flag like
   * `pane`, because a page that covers the window could pass itself off as core: the user is shown
   * it at install, and a core that does not know it refuses the tile.
   */
  overlay?: boolean
  /** Hosts the page may reach: `example.com` or `*.example.com`. Nothing else gets through. */
  net?: string[]
  /**
   * Set by core, never by tile.json: true when the manifest declares a `backend`. It is here so the
   * words the user is shown, and what an update is compared on, include it like any permission.
   */
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
  /** Only on a tile that ships with workshop (`tiles/` in the app). */
  backend?: BackendDecl
}

export type Checked = { ok: true; manifest: Manifest } | { ok: false; errors: string[] }

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const OP_RE = /^[a-z][a-z0-9-]{0,31}$/
const HOST_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const DOOR_TIMEOUT_DEFAULT = 10_000
export const DOOR_TIMEOUT_MAX = 120_000
export const BACKEND_TIMEOUT_DEFAULT = 10_000
export const BACKEND_TIMEOUT_MAX = 120_000

const KNOWN = new Set(['storage', 'sessions', 'transcripts', 'usage', 'door', 'notify', 'files', 'camera', 'microphone', 'overlay', 'net', 'backend'])

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

/**
 * A dev server's origin, if `entry` names one: http on localhost or 127.0.0.1 with a port. Only a
 * tile loaded for development (`workshop tile dev`) may use one; an installed tile never can.
 */
export function devServerOrigin(entry: string): string | null {
  const m = /^http:\/\/(localhost|127\.0\.0\.1):(\d{2,5})(\/[^\s]*)?$/.exec(entry)
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? `http://${m[1]}:${m[2]}` : null
}

/**
 * A list of op names and a timeout, the same rules for the door and a backend: 1 to 32 lowercase
 * words, none twice, and a timeout from 100 ms to the cap. Errors go to `errors` under `where`.
 */
function checkOps(d: unknown, where: string, extra: string[], timeout: { def: number; max: number }, errors: string[]): { ops: string[]; timeoutMs: number } | null {
  if (!isObj(d) || !Array.isArray(d.ops) || d.ops.length === 0 || d.ops.length > 32) {
    errors.push(`${where}: { ${extra.map((k) => `"${k}": …, `).join('')}"ops": [1 to 32 op names], "timeoutMs"?: number }`)
    return null
  }
  const ops = d.ops.filter((o): o is string => typeof o === 'string' && OP_RE.test(o))
  if (ops.length !== d.ops.length) errors.push(`${where}.ops: each op is a lowercase word (letters, digits, dashes), at most 32 long`)
  if (new Set(ops).size !== ops.length) errors.push(`${where}.ops: listed twice`)
  let timeoutMs = timeout.def
  if (d.timeoutMs !== undefined) {
    if (typeof d.timeoutMs !== 'number' || !Number.isInteger(d.timeoutMs) || d.timeoutMs < 100 || d.timeoutMs > timeout.max) errors.push(`${where}.timeoutMs: a whole number from 100 to ${timeout.max}`)
    else timeoutMs = d.timeoutMs
  }
  for (const k of Object.keys(d)) if (k !== 'ops' && k !== 'timeoutMs' && !extra.includes(k)) errors.push(`${where}.${k}: not known`)
  return { ops, timeoutMs }
}

export interface CheckOptions {
  /** Loaded with `workshop tile dev`: the entry may be a dev server. */
  dev?: boolean
  /** Ships with workshop (`tiles/` in the app): the only tiles that may declare a backend. */
  builtin?: boolean
}

export function checkManifest(raw: unknown, opts: CheckOptions = {}): Checked {
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
  if (entry !== undefined && /^[a-z]+:/i.test(entry)) {
    if (!devServerOrigin(entry)) errors.push('entry: a URL entry must be http://localhost:<port>/… or http://127.0.0.1:<port>/…')
    else if (!opts.dev) errors.push('entry: a dev server is allowed only for a tile loaded with workshop tile dev; ship the built page')
  } else if (entry !== undefined) {
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
    for (const k of ['storage', 'transcripts', 'usage', 'notify', 'files', 'camera', 'microphone', 'overlay'] as const) {
      if (p[k] === undefined) continue
      if (typeof p[k] !== 'boolean') errors.push(`permissions.${k}: must be true or false`)
      else if (p[k]) permissions[k] = true
    }
    if (p.sessions !== undefined) {
      if (p.sessions !== 'read' && p.sessions !== 'write') errors.push('permissions.sessions: "read" or "write"')
      else permissions.sessions = p.sessions
    }
    if (p.door !== undefined) {
      const door = checkOps(p.door, 'permissions.door', [], { def: DOOR_TIMEOUT_DEFAULT, max: DOOR_TIMEOUT_MAX }, errors)
      if (door) permissions.door = door
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
    // Never a permission a tile writes: core sets it from the top-level `backend` below.
    if (p.backend !== undefined)
      errors.push(opts.builtin ? 'permissions.backend: declare a backend at the top of tile.json, as "backend": { "entry": "backend.mjs", "ops": [...] }' : `permissions.backend: ${TRUSTED_ONLY}`)
  }

  let backend: BackendDecl | undefined
  if (raw.backend !== undefined) {
    if (!opts.builtin) errors.push(`backend: ${TRUSTED_ONLY}`)
    else {
      const b = raw.backend
      const ops = checkOps(b, 'backend', ['entry'], { def: BACKEND_TIMEOUT_DEFAULT, max: BACKEND_TIMEOUT_MAX }, errors)
      const entry = isObj(b) ? b.entry : undefined
      const bad = badRelPath(entry)
      if (bad) errors.push(`backend.entry: ${bad}`)
      else if (!(entry as string).endsWith('.mjs')) errors.push('backend.entry: must be an .mjs file (an ES module)')
      if (ops && !bad) {
        backend = { entry: entry as string, ops: ops.ops, timeoutMs: ops.timeoutMs }
        permissions.backend = true
      }
    }
  }

  if (errors.length || !id || !name || !version || !range || !author || !entry) return { ok: false, errors: errors.length ? errors : ['incomplete manifest'] }
  return { ok: true, manifest: { id, name, version, workshop: range, author, repo, hint, icon, entry, pane, multiple, span, permissions, ...(backend ? { backend } : {}) } }
}

/** Whether `host` (from a request URL, lowercase) is one the manifest's `net` list lets through. */
export function hostAllowed(host: string, net: string[] | undefined): boolean {
  if (!net || !host) return false
  const h = host.toLowerCase().replace(/\.$/, '')
  return net.some((rule) => (rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule))
}

/** Where a request from a tile's session may go. Enforced in main on every request from a tile's session. */
export function requestAllowed(tile: { manifest: Manifest; devOrigin?: string | null }, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  // A tile under development may also reach its own dev server, and that server's hot-reload socket.
  if (tile.devOrigin && (u.protocol === 'http:' || u.protocol === 'ws:') && `http://${u.host}` === tile.devOrigin) return true
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
