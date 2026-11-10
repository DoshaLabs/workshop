// Core's main process. In this first cut (roadmap step 1) it is the tile host: it finds the tiles,
// arms a sandbox for each, guards every webview core's window attaches, answers the bridge and
// runs the door. Sessions, the launcher and the rest of deck's core come over in step 3.

import { BrowserWindow, Notification, app, ipcMain, nativeTheme, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdtempSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CH, type DoorCall, type TileHead, type TileHello, type TileView } from '@shared/ipc'
import { BRIDGE_VERSION } from '@shared/manifest'
import { DEFAULT_THEME, resolveVariant, themeVars } from '@shared/themes'
import { Door } from './door'
import { TileStore } from './storage'
import { MAX_INSTANCES, TILE_SCHEME, armSession, instanceKey, instanceOfPartition, loadTiles, ownsUrl, readTile, sessionsFor, tileInfo, type Registry, type Tile } from './tiles'
import { runSmoke } from './smoke'

const SMOKE = process.argv.includes('--smoke')
const devTilesIn = (argv: string[], cwd = process.cwd()): string[] =>
  argv.filter((a) => a.startsWith('--dev-tile=')).map((a) => resolve(cwd, a.slice('--dev-tile='.length)))
const devTiles = devTilesIn(process.argv)

if (SMOKE) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'workshop-smoke-')))
  devTiles.push(resolve(app.getAppPath(), 'test/fixtures/probe'))
}

// One app per profile. `workshop tile dev ./x` while it runs hands the folder to the running app.
if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0)

// Must happen before ready: tile:// behaves like https (its own origin, fetch, CORS, storage).
protocol.registerSchemesAsPrivileged([{ scheme: TILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

let win: BrowserWindow | null = null
let registry: Registry = { tiles: new Map(), problems: [] }

interface Guest {
  tile: Tile
  wc: WebContents
  /** Which instance: `<id>` for a tile's first, `<id>.<n>` for the others (manifest `multiple`). */
  key: string
  /** The ops the page has registered a handler for. */
  ops: Set<string>
  /** When the user last worked in it: door calls go to the most recent instance. */
  usedAt: number
}
/** Live tile pages by webContents id, and by instance key. A tile's first instance's key is its id. */
const guests = new Map<number, Guest>()
const liveByTile = new Map<string, Guest>()
const instancesOf = (id: string): Guest[] => [...liveByTile.values()].filter((g) => g.tile.manifest.id === id)
/** Keyed by instance. */
const views = new Map<string, TileView>()
const stores = new Map<string, TileStore>()
const lastNotify = new Map<string, number>()
const lastExternal = new Map<string, number>()

const tileDataDir = (): string => join(app.getPath('userData'), 'tile-data')
const vars = (): Record<string, string> => themeVars(resolveVariant(DEFAULT_THEME, 'system', nativeTheme.shouldUseDarkColors))

const door = new Door({
  manifest: (id) => registry.tiles.get(id)?.manifest,
  live: (id) => instancesOf(id).length > 0,
  answers: (id, op) => instancesOf(id).some((g) => g.ops.has(op)),
  deliver: (id, call: DoorCall) => {
    const g = instancesOf(id)
      .filter((x) => x.ops.has(call.op))
      .sort((a, b) => b.usedAt - a.usedAt)[0]
    g?.wc.send(CH.doorCall, call)
    return g?.key
  }
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
function guestOf(e: IpcMainEvent | IpcMainInvokeEvent): Guest | null {
  const g = guests.get(e.sender.id)
  const f = e.senderFrame
  if (!g || !f || e.sender.isDestroyed()) return null
  const top = e.sender.mainFrame
  if (f.processId !== top.processId || f.routingId !== top.routingId) return null
  if (!ownsUrl(g.tile, f.url)) return null
  return g
}
const tileOf = (e: IpcMainEvent | IpcMainInvokeEvent): Tile | null => guestOf(e)?.tile ?? null

function need(e: IpcMainInvokeEvent, perm?: 'storage' | 'notify'): Guest {
  const g = guestOf(e)
  if (!g) throw new Error('not a tile')
  if (perm && !g.tile.manifest.permissions[perm]) throw new Error(`this tile did not ask for "${perm}" in tile.json`)
  return g
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

/** URLs a smoke run would have opened in the browser (it never opens one). */
export const smokeOpened: string[] = []

/**
 * The one way a tile's URL reaches the browser: openExternal, a popup, or a link that leaves the
 * page all come here. http(s) only, and one a second per tile, so a page cannot open tabs in a loop.
 */
function openForTile(id: string, url: string): boolean {
  if (!isHttp(url)) return false
  const now = Date.now()
  if (now - (lastExternal.get(id) ?? 0) < 1000) return false
  lastExternal.set(id, now)
  if (SMOKE) smokeOpened.push(url)
  else void shell.openExternal(url)
  return true
}

/** Every webview core's window attaches must be a registered tile, and gets core's sandbox. */
function guardWebviews(w: BrowserWindow): void {
  w.webContents.on('will-attach-webview', (e, prefs, params) => {
    const inst = instanceOfPartition(registry.tiles, params.partition ?? '')
    if (!inst || params.src !== inst.tile.src) {
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
    let found: { tile: Tile; key: string } | undefined
    for (const tile of registry.tiles.values()) {
      const i = tile.sessions.indexOf(wc.session)
      if (i >= 0) found = { tile, key: instanceKey(tile.manifest.id, i + 1) }
    }
    if (!found) {
      wc.close()
      return
    }
    // Core's window asked for this page. If the instance already had one (the window reloading,
    // a dev tile loaded again), the new page takes over and the old one is on its way out.
    const { tile, key } = found
    const g: Guest = { tile, wc, key, ops: new Set(), usedAt: Date.now() }
    const id = tile.manifest.id
    guests.set(wc.id, g)
    liveByTile.set(key, g)
    wc.on('focus', () => (g.usedAt = Date.now()))
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // Popups go to the browser. The page itself stays on its own origin.
    wc.setWindowOpenHandler(({ url }) => {
      openForTile(id, url)
      return { action: 'deny' }
    })
    const own = (url: string): boolean => ownsUrl(tile, url)
    wc.on('will-navigate', (ev, url) => {
      if (own(url)) return
      ev.preventDefault()
      openForTile(id, url)
    })
    wc.on('will-redirect', (ev, url) => {
      if (!own(url)) ev.preventDefault()
    })
    wc.once('destroyed', () => {
      guests.delete(wc.id)
      if (liveByTile.get(key) === g) liveByTile.delete(key)
      door.dropInstance(key)
    })
  })
}

const devWatchers = new Map<string, FSWatcher>()

/**
 * Loads (or loads again) a tile folder under development. It may stand in for a core or installed
 * tile with the same id. A folder serving its own files is watched: a change to the page reloads
 * it, a change to tile.json or plugin/ loads the tile again. A dev-server entry reloads itself.
 */
async function addDevTile(folder: string): Promise<string> {
  const t = await readTile(folder, 'dev')
  registry.problems = registry.problems.filter((p) => p.folder !== folder)
  if ('errors' in t) {
    registry.problems.push(t)
    console.warn(`[tiles] refused ${folder}:\n  ${t.errors.join('\n  ')}`)
    win?.webContents.send(CH.tilesChanged)
    return t.errors.join('\n')
  }
  const id = t.manifest.id
  const old = registry.tiles.get(id)
  const tile: Tile = { ...t, rev: (old?.rev ?? 0) + 1, sessions: old?.sessions.length === (t.manifest.multiple ? MAX_INSTANCES : 1) ? old.sessions : sessionsFor(t) }
  registry.tiles.set(id, tile)
  await armSession(tile)
  if (!tile.devOrigin && !devWatchers.has(folder)) {
    let timer: NodeJS.Timeout | undefined
    let reload = false
    const w = watch(tile.root, { recursive: true }, (_ev, name) => {
      const file = String(name ?? '')
      if (file === 'tile.json' || file.startsWith('plugin')) reload = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        const again = reload
        reload = false
        if (again) void addDevTile(folder)
        else for (const g of instancesOf(id)) g.wc.reloadIgnoringCache()
      }, 150)
    })
    w.on('error', () => devWatchers.delete(folder))
    devWatchers.set(folder, w)
  }
  win?.webContents.send(CH.tilesChanged)
  return `loaded ${id} from ${tile.root}${tile.devOrigin ? ` (dev server ${tile.devOrigin})` : ', reloading on change'}`
}

function bridge(): void {
  ipcMain.on(CH.hello, (e) => {
    const t = tileOf(e)
    if (!t) {
      e.returnValue = null
      return
    }
    // Every new document says hello first, so a reloaded page starts with no door ops until it registers them again.
    const g = guests.get(e.sender.id)!
    g.ops = new Set()
    const hello: TileHello = { id: t.manifest.id, instance: g.key, view: views.get(g.key) ?? 'tile', vars: vars(), bridge: BRIDGE_VERSION, permissions: t.manifest.permissions }
    e.returnValue = hello
  })

  ipcMain.handle(CH.head, (e, head: TileHead) => {
    const g = need(e)
    const clean: TileHead = {}
    if (typeof head?.title === 'string') clean.title = head.title.slice(0, 60)
    if (typeof head?.badge === 'string') clean.badge = head.badge.slice(0, 12)
    win?.webContents.send(CH.tileHead, g.key, clean)
  })

  ipcMain.handle(CH.pane, (e, open: boolean) => {
    const g = need(e)
    if (open && !g.tile.manifest.pane) throw new Error('this tile did not set "pane": true in tile.json')
    win?.webContents.send(CH.tilePane, g.key, !!open)
  })

  ipcMain.handle(CH.external, (e, url: string) => {
    const { tile } = need(e)
    if (typeof url !== 'string' || !isHttp(url)) throw new Error('openExternal: http(s) URLs only')
    if (!openForTile(tile.manifest.id, url)) throw new Error('openExternal: one a second')
  })

  // One store per tile, shared by its instances: a write is seen by every one of them.
  ipcMain.handle(CH.storageGet, (e, key: string) => storeOf(need(e, 'storage').tile.manifest.id).get(key))
  ipcMain.handle(CH.storageSet, async (e, key: string, value: unknown) => {
    const id = need(e, 'storage').tile.manifest.id
    await storeOf(id).set(key, value)
    for (const g of instancesOf(id)) g.wc.send(CH.storageChanged, key, value ?? null)
  })

  ipcMain.handle(CH.notify, (e, n: { text?: unknown }) => {
    const g = need(e, 'notify')
    const t = g.tile
    const text = typeof n?.text === 'string' ? n.text.slice(0, 200) : ''
    if (!text) throw new Error('notify: { text }')
    const now = Date.now()
    if (now - (lastNotify.get(t.manifest.id) ?? 0) < 3000) return false
    lastNotify.set(t.manifest.id, now)
    win?.webContents.send(CH.tileNotify, g.key, text)
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
    const g = guestOf(e)
    if (!g || typeof callId !== 'string' || !reply || typeof reply !== 'object') return
    const r = reply as { ok?: unknown; result?: unknown; error?: unknown }
    door.answer(g.key, callId, r.ok === true ? { ok: true, result: r.result } : { ok: false, error: String(r.error ?? 'failed').slice(0, 500) })
  })

  // Core's own window.
  ipcMain.handle(CH.listTiles, (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return { tiles: [...registry.tiles.values()].map(tileInfo), problems: registry.problems, vars: vars() }
  })
  ipcMain.handle(CH.setView, (e, key: string, view: TileView) => {
    if (e.sender !== win?.webContents || (view !== 'tile' && view !== 'pane')) return
    views.set(key, view)
    const g = liveByTile.get(key)
    if (!g) return
    g.usedAt = Date.now()
    g.wc.send(CH.view, view)
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
    { dir: join(app.getAppPath(), 'tiles'), source: 'core' },
    { dir: join(app.getPath('userData'), 'tiles'), source: 'installed' }
  ])
  for (const p of registry.problems) console.warn(`[tiles] refused ${p.folder}:\n  ${p.errors.join('\n  ')}`)
  await Promise.all([...registry.tiles.values()].map(armSession))
  for (const dir of devTiles) console.log(`[tiles] ${await addDevTile(dir)}`)
  app.on('second-instance', (_e, argv, cwd) => {
    for (const dir of devTilesIn(argv, cwd)) void addDevTile(dir).then((m) => console.log(`[tiles] ${m}`))
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })

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
    const code = await runSmoke({ win: win!, door, liveByTile, userData: app.getPath('userData'), opened: smokeOpened, addDevTile })
    door.stop()
    app.exit(code)
  }
})

// The CLI reads door.json to find a running app; a stale one would point at a closed port.
app.on('will-quit', () => {
  try {
    unlinkSync(join(app.getPath('userData'), 'door.json'))
  } catch {
    // already gone
  }
})

app.on('window-all-closed', () => {
  door.stop()
  app.quit()
})
