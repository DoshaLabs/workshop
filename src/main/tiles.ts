// The tile registry and the sandbox. Every tile is a folder with a tile.json; each one that
// passes the manifest check gets its own origin (tile://<id>/), its own session partition, and a
// network that reaches only the hosts it declared. All of it is enforced here in main, never in
// the page. CLAUDE.md §5.

import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { app, session, type Session } from 'electron'
import { TILE_SCHEME, checkManifest, devServerOrigin, requestAllowed, type Manifest } from '@shared/manifest'
import type { TileInfo, TileProblem } from '@shared/ipc'
import { checkPlugin } from './plugin'
import { BACKEND_FILE, TRUSTED_ONLY, wantsBackend } from './tile-check'
import { FILES_PREFIX, type TileGrants } from './files'
import { FONTS_PREFIX, FONT_FILES } from '@shared/fonts'
import { ART_KEY_RE, MUSIC_ART_PREFIX } from '@shared/music'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

/** Set by main: the file grants of a tile (main/files.ts). */
let grantsOf: (id: string) => TileGrants = () => {
  throw new Error('grants not set up')
}
export function setGrants(fn: (id: string) => TileGrants): void {
  grantsOf = fn
}

/** Set by main: the artwork core holds for `workshop.music` (main/music.ts), by key. */
let musicArtOf: (key: string) => { type: string; body: Buffer } | undefined = () => undefined
export function setMusicArt(fn: typeof musicArtOf): void {
  musicArtOf = fn
}

export { TILE_SCHEME }

export interface Tile {
  manifest: Manifest
  /** The tile's folder (real path). */
  root: string
  /** The folder its page is served from: the entry's folder. Nothing above it is reachable. */
  serveRoot: string
  source: TileInfo['source']
  partition: string
  /** One session per instance slot: [0] is the tile's first instance, [1] its second, … */
  sessions: Session[]
  src: string
  icon: string
  /** The tile's Claude Code plugin (handed to new sessions with --plugin-dir), or null. */
  plugin: string | null
  /** A dev tile's dev server (`http://localhost:5173`), whose page is the tile's. Else null. */
  devOrigin: string | null
  /** A built-in tile's backend program (real path), run by main/backend.ts. Null for every other tile. */
  backend: string | null
  /** Bumped each time a dev tile is loaded again, so core's window makes a fresh page for it. */
  rev: number
}

export interface Registry {
  tiles: Map<string, Tile>
  problems: TileProblem[]
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

/** A path is inside `root` (both real paths) only if it IS root or starts with root + separator. */
export function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Whether `url` is a page of this tile: its own origin, or its dev server. */
export function ownsUrl(tile: Pick<Tile, 'manifest' | 'devOrigin'>, url: string): boolean {
  return url.startsWith(`${TILE_SCHEME}://${tile.manifest.id}/`) || (!!tile.devOrigin && url.startsWith(`${tile.devOrigin}/`))
}

export async function readTile(folder: string, source: Tile['source']): Promise<Omit<Tile, 'sessions' | 'rev'> | TileProblem> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(folder, 'tile.json'), 'utf8'))
  } catch (err) {
    return { folder, errors: [`tile.json: ${(err as Error).message}`] }
  }
  // The trusted tier is for tiles that ship with workshop: an installed or local tile asking for a
  // backend is refused here, with the reason, whatever the manifest validator would say.
  const refused = source === 'core' ? null : wantsBackend(raw, await stat(join(folder, BACKEND_FILE)).then(() => true, () => false))
  if (refused) return { folder, errors: [`backend: ${TRUSTED_ONLY}, and ${refused}`] }
  const checked = checkManifest(raw, { dev: source === 'dev', builtin: source === 'core' })
  if (!checked.ok) return { folder, errors: checked.errors }
  const m = checked.manifest
  const root = await realpath(folder)
  const devOrigin = source === 'dev' ? devServerOrigin(m.entry) : null
  const plugin = await checkPlugin(root, m.id)
  if (!plugin.ok) return { folder, errors: plugin.errors }
  let backend: string | null = null
  if (m.backend) {
    const file = await realpath(resolve(root, m.backend.entry)).catch(() => null)
    if (!file || !inside(root, file) || !(await stat(file)).isFile()) return { folder, errors: [`backend.entry: ${m.backend.entry} is not a file inside the tile's folder`] }
    backend = file
  }
  const icon = await readIcon(root, m.icon)
  const common = { manifest: m, root, source, partition: `persist:tile-${m.id}`, icon, plugin: plugin.dir, backend }
  if (devOrigin) return { ...common, serveRoot: root, src: m.entry, devOrigin }
  const entry = resolve(root, m.entry)
  let entryReal: string
  try {
    entryReal = await realpath(entry)
    if (!(await stat(entryReal)).isFile()) throw new Error('not a file')
  } catch {
    return { folder, errors: [`entry: ${m.entry} does not exist (the built page must be in the folder; no build step runs on install)`] }
  }
  if (!inside(root, entryReal)) return { folder, errors: ['entry: points outside the tile folder'] }
  return { ...common, serveRoot: dirname(entryReal), src: `${TILE_SCHEME}://${m.id}/${basename(entryReal)}`, devOrigin: null }
}

/** The icon as a data: URL, or '' (core then draws the name's first letter). */
async function readIcon(root: string, icon: string | undefined): Promise<string> {
  if (!icon) return ''
  try {
    const file = await realpath(resolve(root, icon))
    if (!inside(root, file)) return ''
    const buf = await readFile(file)
    return buf.length <= 256 * 1024 ? `data:${MIME[extname(file)] ?? 'image/png'};base64,${buf.toString('base64')}` : ''
  } catch {
    return ''
  }
}

/**
 * Reads every tile folder under the given sources. Order is precedence: a later folder with an id
 * already taken is refused, so list the sources dev, core, installed — a folder under development
 * may stand in for a core tile, an installed one never can.
 */
export async function loadTiles(sources: { dir: string; source: Tile['source']; single?: boolean }[]): Promise<Registry> {
  const tiles = new Map<string, Tile>()
  const problems: TileProblem[] = []
  for (const { dir, source, single } of sources) {
    let folders: string[]
    if (single) folders = [dir]
    else {
      try {
        folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(dir, d.name))
      } catch {
        continue // no such source yet (nothing installed)
      }
    }
    for (const folder of folders) {
      const t = await readTile(folder, source)
      if ('errors' in t) {
        problems.push(t)
        continue
      }
      if (tiles.has(t.manifest.id)) {
        problems.push({ folder, errors: [`id: "${t.manifest.id}" is already taken by ${tiles.get(t.manifest.id)!.root}`] })
        continue
      }
      tiles.set(t.manifest.id, { ...t, rev: 0, sessions: sessionsFor(t) })
    }
  }
  return { tiles, problems }
}

/**
 * Dresses a tile's session: its files served on its own origin, every request checked against
 * its `net` list, every permission refused unless declared, no downloads, no screen capture.
 * Traffic to undeclared hosts is also sent to a proxy that does not exist, which closes WebRTC
 * (with the page's WebRTC held to proxied UDP, index.ts). It does NOT stop DNS prefetch: tile
 * pages are started with Blink's prefetching off for that (index.ts, will-attach-webview).
 */
/** The most instances of one tile (manifest `multiple: true`) open at once. */
export const MAX_INSTANCES = 4

/** Instance n of a tile: partition `persist:tile-<id>` for the first, `persist:tile-<id>.<n>` after. */
export const partitionOf = (partition: string, n: number): string => (n === 1 ? partition : `${partition}.${n}`)
/** The instance's key, used everywhere core names one: `<id>` for the first, `<id>.<n>` after. */
export const instanceKey = (id: string, n: number): string => (n === 1 ? id : `${id}.${n}`)

export function sessionsFor(t: Pick<Tile, 'partition' | 'manifest'>): Session[] {
  const n = t.manifest.multiple ? MAX_INSTANCES : 1
  return Array.from({ length: n }, (_, i) => session.fromPartition(partitionOf(t.partition, i + 1)))
}

/** Which tile and instance a webview partition is, or null. */
export function instanceOfPartition(tiles: Map<string, Tile>, partition: string): { tile: Tile; n: number; key: string } | null {
  const m = /^persist:tile-([a-z0-9-]+)(?:\.([2-9]))?$/.exec(partition)
  const tile = m ? tiles.get(m[1]) : undefined
  if (!m || !tile) return null
  const n = m[2] ? Number(m[2]) : 1
  if (n > tile.sessions.length) return null
  return { tile, n, key: instanceKey(tile.manifest.id, n) }
}

const armed = new WeakSet<Session>()

/** Arms every instance's session. Safe to call again (a dev tile reloaded): every handler is replaced. */
export async function armSession(tile: Tile): Promise<void> {
  await Promise.all(tile.sessions.map((ses) => armOne(tile, ses)))
}

async function armOne(tile: Tile, ses: Session): Promise<void> {
  const { id, permissions } = tile.manifest

  if (ses.protocol.isProtocolHandled(TILE_SCHEME)) ses.protocol.unhandle(TILE_SCHEME)
  ses.protocol.handle(TILE_SCHEME, async (req) => {
    const u = new URL(req.url)
    if (u.hostname !== id) return new Response('not found', { status: 404 })
    let rel: string
    try {
      rel = decodeURIComponent(u.pathname)
    } catch {
      return new Response('bad path', { status: 400 })
    }
    if (rel.includes('\0')) return new Response('bad path', { status: 400 })
    // A dev-server page is another origin: let it read its own tile's files (the picked ones).
    const cors: Record<string, string> = tile.devOrigin ? { 'Access-Control-Allow-Origin': tile.devOrigin } : {}
    // Core's fonts, the same files for every tile, on the tile's own origin.
    if (rel.startsWith(FONTS_PREFIX)) {
      const font = FONT_FILES.find((f) => f.file === rel.slice(FONTS_PREFIX.length))
      if (!font) return new Response('not found', { status: 404, headers: cors })
      return new Response(await readFile(join(app.getAppPath(), 'assets', 'fonts', font.file)), { headers: { ...cors, 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' } })
    }
    if (rel.startsWith(FILES_PREFIX)) {
      if (!permissions.files) return new Response('not found', { status: 404 })
      const [handle, ...rest] = rel.slice(FILES_PREFIX.length).split('/')
      const found = await grantsOf(id).resolve(handle, rest.join('/'))
      const st = found ? await stat(found.path).catch(() => null) : null
      if (!found || !st?.isFile()) return new Response('not found', { status: 404, headers: cors })
      const body = Readable.toWeb(createReadStream(found.path)) as ReadableStream
      return new Response(body, { headers: { ...cors, 'Content-Type': MIME[extname(found.path).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': String(st.size), 'X-Content-Type-Options': 'nosniff' } })
    }
    // The playing track's picture, fetched by core, on this tile's origin: only for a tile with "music".
    if (rel.startsWith(MUSIC_ART_PREFIX)) {
      const key = rel.slice(MUSIC_ART_PREFIX.length)
      const art = permissions.music && ART_KEY_RE.test(key) ? musicArtOf(key) : undefined
      if (!art) return new Response('not found', { status: 404, headers: cors })
      return new Response(new Uint8Array(art.body), { headers: { ...cors, 'Content-Type': art.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=3600' } })
    }
    const wanted = resolve(tile.serveRoot, '.' + (rel === '/' ? '/' + basename(tile.src) : rel))
    try {
      const real = await realpath(wanted)
      if (!inside(tile.serveRoot, real) || !(await stat(real)).isFile()) return new Response('not found', { status: 404 })
      return new Response(await readFile(real), {
        headers: { ...cors, 'Content-Type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !requestAllowed(tile, details.url) }))

  await ses.setProxy({
    proxyRules: '127.0.0.1:9',
    // `<-loopback>` takes away Chromium's implicit "never proxy localhost", except for a dev tile,
    // which must reach its dev server (the request filter still holds it to that one origin).
    proxyBypassRules: [...(permissions.net ?? []), tile.devOrigin ? '' : '<-loopback>'].filter(Boolean).join(',')
  })

  ses.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (perm === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      cb(types.length > 0 && types.every((t) => (t === 'video' && permissions.camera) || (t === 'audio' && permissions.microphone)))
      return
    }
    cb(perm === 'clipboard-sanitized-write')
  })
  ses.setPermissionCheckHandler((_wc, perm, _origin, details) => {
    if (perm === 'media') {
      const t = (details as { mediaType?: string }).mediaType
      return (t === 'video' && !!permissions.camera) || (t === 'audio' && !!permissions.microphone)
    }
    return perm === 'clipboard-sanitized-write'
  })
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}))
  if (!armed.has(ses)) {
    armed.add(ses)
    ses.on('will-download', (e) => e.preventDefault())
  }
}

export function tileInfo(t: Tile): TileInfo {
  return { manifest: t.manifest, src: t.src, partition: t.partition, icon: t.icon, source: t.source, rev: t.rev }
}
