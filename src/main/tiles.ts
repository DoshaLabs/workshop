// The tile registry and the sandbox. Every tile is a folder with a tile.json; each one that
// passes the manifest check gets its own origin (tile://<id>/), its own session partition, and a
// network that reaches only the hosts it declared. All of it is enforced here in main, never in
// the page. CLAUDE.md §5.

import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { session, type Session } from 'electron'
import { TILE_SCHEME, checkManifest, requestAllowed, type Manifest } from '@shared/manifest'
import type { TileInfo, TileProblem } from '@shared/ipc'
import { checkPlugin } from './plugin'

export { TILE_SCHEME }

export interface Tile {
  manifest: Manifest
  /** The tile's folder (real path). */
  root: string
  /** The folder its page is served from: the entry's folder. Nothing above it is reachable. */
  serveRoot: string
  source: TileInfo['source']
  partition: string
  session: Session
  src: string
  icon: string
  /** The tile's Claude Code plugin (handed to new sessions with --plugin-dir), or null. */
  plugin: string | null
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

async function readTile(folder: string, source: Tile['source']): Promise<Omit<Tile, 'session'> | TileProblem> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(folder, 'tile.json'), 'utf8'))
  } catch (err) {
    return { folder, errors: [`tile.json: ${(err as Error).message}`] }
  }
  const checked = checkManifest(raw)
  if (!checked.ok) return { folder, errors: checked.errors }
  const m = checked.manifest
  const root = await realpath(folder)
  const entry = resolve(root, m.entry)
  let entryReal: string
  try {
    entryReal = await realpath(entry)
    if (!(await stat(entryReal)).isFile()) throw new Error('not a file')
  } catch {
    return { folder, errors: [`entry: ${m.entry} does not exist (the built page must be in the folder; no build step runs on install)`] }
  }
  if (!inside(root, entryReal)) return { folder, errors: ['entry: points outside the tile folder'] }
  const plugin = await checkPlugin(root, m.id)
  if (!plugin.ok) return { folder, errors: plugin.errors }
  let icon = ''
  if (m.icon) {
    try {
      const file = await realpath(resolve(root, m.icon))
      if (inside(root, file)) {
        const buf = await readFile(file)
        if (buf.length <= 256 * 1024) icon = `data:${MIME[extname(file)] ?? 'image/png'};base64,${buf.toString('base64')}`
      }
    } catch {
      // no icon: core draws a letter
    }
  }
  return {
    manifest: m,
    root,
    serveRoot: dirname(entryReal),
    source,
    partition: `persist:tile-${m.id}`,
    src: `${TILE_SCHEME}://${m.id}/${basename(entryReal)}`,
    icon,
    plugin: plugin.dir
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
      tiles.set(t.manifest.id, { ...t, session: session.fromPartition(t.partition) })
    }
  }
  return { tiles, problems }
}

/**
 * Dresses a tile's session: its files served on its own origin, every request checked against
 * its `net` list, every permission refused unless declared, no downloads, no screen capture.
 * Traffic to undeclared hosts is also sent to a proxy that does not exist, which closes the side
 * doors a request filter cannot see (WebRTC, DNS prefetch).
 */
export async function armSession(tile: Tile): Promise<void> {
  const ses = tile.session
  const { id, permissions } = tile.manifest

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
    const wanted = resolve(tile.serveRoot, '.' + (rel === '/' ? '/' + basename(tile.src) : rel))
    try {
      const real = await realpath(wanted)
      if (!inside(tile.serveRoot, real) || !(await stat(real)).isFile()) return new Response('not found', { status: 404 })
      return new Response(await readFile(real), {
        headers: { 'Content-Type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !requestAllowed(tile, details.url) }))

  await ses.setProxy({
    proxyRules: '127.0.0.1:9',
    // `<-loopback>` takes away Chromium's implicit "never proxy localhost".
    proxyBypassRules: [...(permissions.net ?? []), '<-loopback>'].join(',')
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
  ses.on('will-download', (e) => e.preventDefault())
}

export function tileInfo(t: Tile): TileInfo {
  return { manifest: t.manifest, src: t.src, partition: t.partition, icon: t.icon, source: t.source }
}
