// Core's main process. In this first cut (roadmap step 1) it is the tile host: it finds the tiles,
// arms a sandbox for each, guards every webview core's window attaches, answers the bridge and
// runs the door. Sessions, the launcher and the rest of deck's core come over in step 3.

import { BrowserWindow, Notification, app, ipcMain, nativeTheme, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CH, type DoorCall, type TileHead, type TileHello, type TileView } from '@shared/ipc'
import { BRIDGE_VERSION } from '@shared/manifest'
import { DEFAULT_THEME, resolveVariant, themeVars } from '@shared/themes'
import { Door } from './door'
import { TileStore } from './storage'
import { TILE_SCHEME, armSession, loadTiles, tileInfo, type Registry, type Tile } from './tiles'
import { runSmoke } from './smoke'

const SMOKE = process.argv.includes('--smoke')
const devTiles = process.argv.filter((a) => a.startsWith('--dev-tile=')).map((a) => resolve(a.slice('--dev-tile='.length)))

if (SMOKE) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'workshop-smoke-')))
  devTiles.push(resolve(app.getAppPath(), 'test/fixtures/probe'))
}

// Must happen before ready: tile:// behaves like https (its own origin, fetch, CORS, storage).
protocol.registerSchemesAsPrivileged([{ scheme: TILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

let win: BrowserWindow | null = null
let registry: Registry = { tiles: new Map(), problems: [] }

interface Guest {
  tile: Tile
  wc: WebContents
  /** The ops the page has registered a handler for. */
  ops: Set<string>
}
/** Live tile pages by webContents id, and by tile id (one live page per tile in v1). */
const guests = new Map<number, Guest>()
const liveByTile = new Map<string, Guest>()
const views = new Map<string, TileView>()
const stores = new Map<string, TileStore>()
const lastNotify = new Map<string, number>()
const lastExternal = new Map<string, number>()

const tileDataDir = (): string => join(app.getPath('userData'), 'tile-data')
const vars = (): Record<string, string> => themeVars(resolveVariant(DEFAULT_THEME, 'system', nativeTheme.shouldUseDarkColors))

const door = new Door({
  manifest: (id) => registry.tiles.get(id)?.manifest,
  live: (id) => liveByTile.has(id),
  answers: (id, op) => liveByTile.get(id)?.ops.has(op) ?? false,
  deliver: (id, call: DoorCall) => liveByTile.get(id)?.wc.send(CH.doorCall, call)
})

function storeOf(id: string): TileStore {
  let s = stores.get(id)
  if (!s) stores.set(id, (s = TileStore.forTile(tileDataDir(), id)))
  return s
}

/**
 * The tile behind a bridge call, or null. The call must come from a webview core attached for
 * that tile, from its top frame, on its own origin: an iframe the page embeds, or the page after
 * it somehow navigated away, gets nothing.
 */
function tileOf(e: IpcMainEvent | IpcMainInvokeEvent): Tile | null {
  const g = guests.get(e.sender.id)
  const f = e.senderFrame
  if (!g || !f || e.sender.isDestroyed()) return null
  const top = e.sender.mainFrame
  if (f.processId !== top.processId || f.routingId !== top.routingId) return null
  if (!f.url.startsWith(`${TILE_SCHEME}://${g.tile.manifest.id}/`)) return null
  return g.tile
}

function need(e: IpcMainInvokeEvent, perm?: 'storage' | 'notify'): Tile {
  const t = tileOf(e)
  if (!t) throw new Error('not a tile')
  if (perm && !t.manifest.permissions[perm]) throw new Error(`this tile did not ask for "${perm}" in tile.json`)
  return t
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

/** Every webview core's window attaches must be a registered tile, and gets core's sandbox. */
function guardWebviews(w: BrowserWindow): void {
  w.webContents.on('will-attach-webview', (e, prefs, params) => {
    const tile = [...registry.tiles.values()].find((t) => t.partition === params.partition)
    if (!tile || params.src !== tile.src) {
      e.preventDefault()
      return
    }
    delete (prefs as { preloadURL?: string }).preloadURL
    prefs.preload = join(__dirname, '../preload/tile.js')
    prefs.sandbox = true
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.webSecurity = true
    prefs.allowRunningInsecureContent = false
    prefs.experimentalFeatures = false
    delete prefs.enableBlinkFeatures
    prefs.backgroundThrottling = !SMOKE
  })
  w.webContents.on('did-attach-webview', (_e, wc) => {
    const tile = [...registry.tiles.values()].find((t) => t.session === wc.session)
    if (!tile) {
      wc.close()
      return
    }
    const g: Guest = { tile, wc, ops: new Set() }
    const id = tile.manifest.id
    guests.set(wc.id, g)
    liveByTile.set(id, g)
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // Popups go to the browser. The page itself stays on its own origin.
    wc.setWindowOpenHandler(({ url }) => {
      if (isHttp(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const own = (url: string): boolean => url.startsWith(`${TILE_SCHEME}://${id}/`)
    wc.on('will-navigate', (ev, url) => {
      if (own(url)) return
      ev.preventDefault()
      if (isHttp(url)) void shell.openExternal(url)
    })
    wc.on('will-redirect', (ev, url) => {
      if (!own(url)) ev.preventDefault()
    })
    wc.once('destroyed', () => {
      guests.delete(wc.id)
      if (liveByTile.get(id) === g) liveByTile.delete(id)
      door.dropTile(id)
    })
  })
}

function bridge(): void {
  ipcMain.on(CH.hello, (e) => {
    const t = tileOf(e)
    if (!t) {
      e.returnValue = null
      return
    }
    // Every new document says hello first, so a reloaded page starts with no door ops until it registers them again.
    const g = guests.get(e.sender.id)
    if (g) g.ops = new Set()
    const hello: TileHello = { id: t.manifest.id, view: views.get(t.manifest.id) ?? 'tile', vars: vars(), bridge: BRIDGE_VERSION, permissions: t.manifest.permissions }
    e.returnValue = hello
  })

  ipcMain.handle(CH.head, (e, head: TileHead) => {
    const t = need(e)
    const clean: TileHead = {}
    if (typeof head?.title === 'string') clean.title = head.title.slice(0, 60)
    if (typeof head?.badge === 'string') clean.badge = head.badge.slice(0, 12)
    win?.webContents.send(CH.tileHead, t.manifest.id, clean)
  })

  ipcMain.handle(CH.pane, (e, open: boolean) => {
    const t = need(e)
    if (open && !t.manifest.pane) throw new Error('this tile did not set "pane": true in tile.json')
    win?.webContents.send(CH.tilePane, t.manifest.id, !!open)
  })

  ipcMain.handle(CH.external, (e, url: string) => {
    const t = need(e)
    if (typeof url !== 'string' || !isHttp(url)) throw new Error('openExternal: http(s) URLs only')
    const now = Date.now()
    if (now - (lastExternal.get(t.manifest.id) ?? 0) < 1000) throw new Error('openExternal: one a second')
    lastExternal.set(t.manifest.id, now)
    void shell.openExternal(url)
  })

  ipcMain.handle(CH.storageGet, (e, key: string) => storeOf(need(e, 'storage').manifest.id).get(key))
  ipcMain.handle(CH.storageSet, async (e, key: string, value: unknown) => {
    const id = need(e, 'storage').manifest.id
    await storeOf(id).set(key, value)
    liveByTile.get(id)?.wc.send(CH.storageChanged, key, value ?? null)
  })

  ipcMain.handle(CH.notify, (e, n: { text?: unknown }) => {
    const t = need(e, 'notify')
    const text = typeof n?.text === 'string' ? n.text.slice(0, 200) : ''
    if (!text) throw new Error('notify: { text }')
    const now = Date.now()
    if (now - (lastNotify.get(t.manifest.id) ?? 0) < 3000) return false
    lastNotify.set(t.manifest.id, now)
    win?.webContents.send(CH.tileNotify, t.manifest.id, text)
    if (!SMOKE && Notification.isSupported()) new Notification({ title: t.manifest.name, body: text, silent: true }).show()
    return true
  })

  ipcMain.on(CH.doorReady, (e, ops: unknown) => {
    const t = tileOf(e)
    const g = guests.get(e.sender.id)
    if (!t || !g || !Array.isArray(ops)) return
    const declared = t.manifest.permissions.door?.ops ?? []
    g.ops = new Set(ops.filter((o): o is string => typeof o === 'string' && declared.includes(o)))
  })
  ipcMain.on(CH.doorReply, (e, callId: unknown, reply: unknown) => {
    const t = tileOf(e)
    if (!t || typeof callId !== 'string' || !reply || typeof reply !== 'object') return
    const r = reply as { ok?: unknown; result?: unknown; error?: unknown }
    door.answer(t.manifest.id, callId, r.ok === true ? { ok: true, result: r.result } : { ok: false, error: String(r.error ?? 'failed').slice(0, 500) })
  })

  // Core's own window.
  ipcMain.handle(CH.listTiles, (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return { tiles: [...registry.tiles.values()].map(tileInfo), problems: registry.problems, vars: vars() }
  })
  ipcMain.handle(CH.setView, (e, id: string, view: TileView) => {
    if (e.sender !== win?.webContents || (view !== 'tile' && view !== 'pane')) return
    views.set(id, view)
    liveByTile.get(id)?.wc.send(CH.view, view)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: !SMOKE,
    title: 'workshop',
    titleBarStyle: 'hiddenInset',
    backgroundColor: vars()['--ws-bg'],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: !SMOKE
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  guardWebviews(win)
  if (SMOKE) {
    win.webContents.on('console-message', (e) => console.log(`[window] ${e.message}`))
    win.webContents.on('did-attach-webview', (_e, wc) => {
      wc.on('console-message', (e) => console.log(`[tile ${wc.getURL()}] ${e.message}`))
      wc.on('preload-error', (_e, path, err) => console.log(`[tile preload ${path}] ${err.message}`))
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  registry = await loadTiles([
    ...devTiles.map((dir) => ({ dir, source: 'dev' as const, single: true })),
    { dir: join(app.getAppPath(), 'tiles'), source: 'core' },
    { dir: join(app.getPath('userData'), 'tiles'), source: 'installed' }
  ])
  for (const p of registry.problems) console.warn(`[tiles] refused ${p.folder}:\n  ${p.errors.join('\n  ')}`)
  await Promise.all([...registry.tiles.values()].map(armSession))

  await door.start()
  // Where the CLI finds the door from outside a session. Readable by this user only.
  writeFileSync(join(app.getPath('userData'), 'door.json'), JSON.stringify({ port: door.port, token: door.token }), { mode: 0o600 })

  bridge()
  createWindow()

  nativeTheme.on('updated', () => {
    const v = vars()
    win?.webContents.send(CH.themeChanged, v)
    for (const g of liveByTile.values()) g.wc.send(CH.theme, v)
  })

  if (SMOKE) {
    const code = await runSmoke({ win: win!, door, liveByTile, userData: app.getPath('userData') })
    door.stop()
    app.exit(code)
  }
})

app.on('window-all-closed', () => {
  door.stop()
  app.quit()
})
