// Core's main process: the tile host (it finds the tiles, arms a sandbox for each, guards every
// webview core's window attaches, answers the bridge and runs the door) and the sessions
// (main/core-sessions.ts).

import { BrowserWindow, Notification, app, dialog, ipcMain, nativeTheme, protocol, screen, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { CH, type DoorCall, type ThemeState, type TileHead, type TileHello, type TileView } from '@shared/ipc'
import { BRIDGE_VERSION } from '@shared/manifest'
import { FONT_VARS } from '@shared/fonts'
import { isRecorderKey, shortcutOf } from '@shared/shortcuts'
import { EMPTY_COLUMN, cleanColumn } from '@shared/column'
import { COSMOS_ID, forcesDark, resolveVariant, seeThrough, themeVars } from '@shared/themes'
import { SettingsStore, type Settings } from './settings'
import { Door } from './door'
import { TileGrants } from './files'
import { TileStore } from './storage'
import { MAX_INSTANCES, TILE_SCHEME, armSession, setNetStandIn, coreFile, setGrants, instanceKey, instanceOfPartition, loadTiles, ownsUrl, readTile, sessionsFor, tileInfo, type Registry, type Tile } from './tiles'
import { runRestarted, runSmoke } from './smoke'
import { scaffoldTile } from './scaffold'
import { startSessions, type CoreSessions } from './core-sessions'
import { MascotStore } from './mascot'
import { startTileMenu } from './tile-menu'
import { ProjectRoots } from './project'
import { Backends, utilitySpawn, type BackendTile, type UtilityProcessLike } from './backend'
import { backendEnv } from './backend-protocol'
import { shellEnv } from './env'
import { startMusic, type MusicBridge } from './music-bridge'
import { OAUTH_PORT, OAuthHost } from './oauth'
import { fetchSpotifyArt, osascriptRunner } from './music'
import { smokeMusicIo } from './smoke-music'
import { Recorder } from './recorder'
import { REC, REC_DEFAULTS } from '@shared/recorder'
import { launchRequest, type LaunchPrefill, type SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import type { Transcript } from '@shared/transcript'
import type { Activity } from '@shared/activity'
import { parseBuildInfo } from '@shared/update'
import { Updater, bundleOf } from './updates'
import { DevMode } from './devmode'
import { Accounts } from './accounts'
import { placeWindow } from './window-bounds'
import { reapTmuxWhenGone } from './smoke-reaper'
import { smokeNet } from './smoke-net'
import { doorTilesOf } from './door-tools'
import { escClosesViewer, keepShown, setSessionFolders } from './viewer'
import { cleanCaption } from '@shared/viewer'
import type { PreviewRef } from '@shared/preview'
import { VIEW_SCHEME } from '@shared/viewer'

/** A second core started by a smoke run on that run's profile, to check its sessions survive a restart (smoke.ts `restart`). */
const RESTARTED = process.argv.includes('--smoke-restarted')
const SMOKE = process.argv.includes('--smoke') || RESTARTED
const devTilesIn = (argv: string[], cwd = process.cwd()): string[] =>
  argv.filter((a) => a.startsWith('--dev-tile=')).map((a) => resolve(cwd, a.slice('--dev-tile='.length)))
const devTiles = devTilesIn(process.argv)

/**
 * The profile names the tmux socket and the folder everything lives in, so a dev build (`npm run
 * dev`) never sees the installed app's sessions and a session working ON workshop can run the dev
 * build inside the installed one. A smoke run gets a throwaway one.
 */
const DEV = !!process.env.ELECTRON_RENDERER_URL
/**
 * WORKSHOP_PROFILE=<name> runs on a profile of that name (its own tmux socket and its own folder
 * beside the usual one): a look at a build without touching your sessions, e.g. the packaged app
 * before it is installed (docs/progress/2026-11-10-dist.md).
 */
const NAMED = !SMOKE && /^[a-z0-9][a-z0-9-]{0,40}$/.test(process.env.WORKSHOP_PROFILE ?? '') ? process.env.WORKSHOP_PROFILE! : null
/** How long a smoke run's core may take to start before the run fails (smoke only). */
const SMOKE_START_S = 60
/** Running until the smoke checks begin; then cleared. */
let smokeStartDeadline: NodeJS.Timeout | null = null
function smokeStartFailed(why: string): void {
  console.log(`FAIL  core started  (${why.replace(/\s+/g, ' ').slice(0, 600)})`)
  console.log('\n0 passed, 1 failed')
  // app.exit has been seen to hang here (11 Nov 2026: the run sat four minutes after this line), so
  // the process goes regardless a moment later.
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 3000)
  app.exit(1)
}
const PROFILE = RESTARTED ? process.env.WORKSHOP_SMOKE_PROFILE! : SMOKE ? `workshop-smoke-${process.pid}` : NAMED ?? (DEV ? 'workshop-dev' : 'workshop')
if (SMOKE) {
  const tmp = tmpdir()
  const home = RESTARTED ? process.env.WORKSHOP_SMOKE_HOME! : mkdtempSync(join(tmp, 'workshop-smoke-'))
  app.setPath('userData', home)
  // Every folder the run makes (its projects, repos, dev tiles) goes inside its own, so one rm takes
  // them all; the second cores inherit this from the first.
  if (!RESTARTED) {
    mkdirSync(join(home, 'tmp'))
    process.env.TMPDIR = join(home, 'tmp')
  }
  devTiles.push(resolve(app.getAppPath(), 'test/fixtures/probe'))
  // However this run ends, its tmux server and its folder go with it (the second cores share the
  // first's socket and folder). WORKSHOP_SMOKE_KEEP=1 keeps the folder, to look through after a failure.
  if (!RESTARTED) reapTmuxWhenGone(PROFILE, shellEnv(), process.pid, process.env.WORKSHOP_SMOKE_KEEP === '1' ? undefined : { path: home, tmp })
  // No smoke run depends on the internet: the Wikipedia tile's hosts are answered from canned data
  // (smoke-net.ts). WORKSHOP_LIVE_NET=1 runs the same checks against the real services.
  if (process.env.WORKSHOP_LIVE_NET !== '1') setNetStandIn(smokeNet)
  // A core that cannot start must fail the run at once, not leave it waiting on a window that never
  // comes: a startup error, or no checks begun within the deadline, ends the run with a FAIL line.
  smokeStartDeadline = setTimeout(() => smokeStartFailed(`no checks began within ${SMOKE_START_S} s`), SMOKE_START_S * 1000)
  process.on('unhandledRejection', (err) => {
    if (smokeStartDeadline) smokeStartFailed(err instanceof Error ? (err.stack ?? err.message) : String(err))
  })
} else if (NAMED) app.setPath('userData', join(app.getPath('appData'), NAMED))
else if (DEV) app.setPath('userData', `${app.getPath('userData')}-dev`)
/**
 * A trusted tile for the smoke test, loaded as if it shipped in tiles/ (the only place a backend is
 * allowed), so the trusted tier is exercised without a fake tile in the app. Smoke runs only.
 */
const SMOKE_BUILTINS = SMOKE ? [{ dir: resolve(app.getAppPath(), 'test/fixtures/trusted'), source: 'core' as const, single: true }] : []

// One app per profile. `workshop tile dev ./x` while it runs hands the folder to the running app.
if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0)

// Must happen before ready: tile:// behaves like https (its own origin, fetch, CORS, storage).
protocol.registerSchemesAsPrivileged([
  { scheme: TILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  // The file viewer's (main/viewer.ts): each grant its own origin. Standard, so a web page's
  // relative links resolve; stream, so a film seeks. No CORS headers are sent: one grant cannot read another.
  { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let win: BrowserWindow | null = null
let core: CoreSessions | null = null
let registry: Registry = { tiles: new Map(), problems: [] }
/** `workshop.music` (main/music.ts). A smoke run gets a stand-in for osascript and never touches the real apps. */
let music: MusicBridge | null = null
/** `workshop.oauth` (main/oauth.ts): the loopback listener for a tile's sign-in. A smoke run gets a free port, never 47800. */
let oauth: OAuthHost | null = null
/** The screen recorder (main/recorder.ts): core's own, never a tile's. */
let recorder: Recorder | null = null
/** Install update (main/updates.ts). Offers nothing unless this is a packaged app built by `npm run dist`. */
let updater: Updater | null = null
let devMode: DevMode | null = null
let accounts: Accounts | null = null

interface Guest {
  tile: Tile
  wc: WebContents
  /** Which instance: `<id>` for a tile's first, `<id>.<n>` for the others (manifest `multiple`). */
  key: string
  /** The ops the page has registered a handler for. */
  ops: Set<string>
  /** When the user last worked in it: door calls go to the most recent instance. */
  usedAt: number
  /** When the user last clicked or typed in this page (0 once an overlay has used it up). */
  gestureAt: number
  /** Which document the webContents holds: a reload keeps the webContents (and its id) but is a new page. */
  doc: number
}
/** Live tile pages by webContents id, and by instance key. A tile's first instance's key is its id. */
const guests = new Map<number, Guest>()
const liveByTile = new Map<string, Guest>()
/** One page of an instance, for the door: a reload gives the instance a new page, and a call belongs to the page it went to. */
const pageOf = (g: Guest): string => `${g.key}@${g.wc.id}#${g.doc}`
const instancesOf = (id: string): Guest[] => [...liveByTile.values()].filter((g) => g.tile.manifest.id === id)
/** Keyed by instance. */
const views = new Map<string, TileView>()
const stores = new Map<string, TileStore>()
const lastNotify = new Map<string, number>()
const lastExternal = new Map<string, number>()
/** The session that last called each tile through the door: a tile's call for attention goes to that session's mascot. */
const lastCaller = new Map<string, { session: string; at: number }>()
/** A call older than this no longer makes a session the one a tile's call for attention is about. */
const CALLER_MS = 10 * 60_000
let mascots: MascotStore
/** The instance whose page is over the whole window, if any. Only one at a time. */
let overlayKey: string | null = null
/** How recent a click or key in the page must be for it to open its overlay (Chromium's own window for a user activation). */
const GESTURE_MS = 5000

/**
 * Takes the page that is over the window back to where it was. Core, not the tile, owns this: it
 * runs on Esc from any page in the window (main sees the key before the page does) and from the
 * strip core draws above the overlay, so a tile that ignores closeOverlay still cannot keep it.
 */
function closeOverlay(): void {
  if (!overlayKey) return
  win?.webContents.send(CH.tileOverlay, overlayKey, false)
}

/** Esc closes the overlay wherever the focus is; while it is open, the page under focus never sees that Esc. */
function escClosesOverlay(wc: WebContents): void {
  wc.on('before-input-event', (ev, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && overlayKey) {
      ev.preventDefault()
      closeOverlay()
    }
  })
}

/**
 * Core's shortcuts (⌘1–9, ⌘[ ⌘], ⌘N) work wherever the focus is: a key pressed in a tile's
 * webview or in a terminal is caught here, before the page sees it, and handed to core's window.
 * Registered before a tile's gesture listener, so a shortcut never counts as a click in the tile.
 */
function coreShortcuts(wc: WebContents): void {
  wc.on('before-input-event', (ev, input) => {
    if (isRecorderKey(input)) {
      ev.preventDefault()
      recorder?.toggle()
      return
    }
    const s = shortcutOf(input)
    if (!s) return
    ev.preventDefault()
    win?.webContents.send(CH.shortcut, s)
  })
}

const tileDataDir = (): string => join(app.getPath('userData'), 'tile-data')
let settings: SettingsStore
const isDark = (s: Settings): boolean => forcesDark(s.theme) || s.appearance === 'dark' || (s.appearance === 'system' && nativeTheme.shouldUseDarkColors)
const variant = () => {
  const s = settings.get()
  return resolveVariant(s.theme, s.appearance, nativeTheme.shouldUseDarkColors)
}
/** The theme for a tile: the colours, and light or dark (core sets `color-scheme` from it, so native scrollbars and form controls follow). */
const vars = (): Record<string, string> => ({ ...themeVars(variant()), ...FONT_VARS, '--ws-scheme': isDark(settings.get()) ? 'dark' : 'light' })
/** What core's window needs to paint itself: the settings, the live variables, and whether there is a wall. */
const themeState = (): ThemeState => {
  const s = settings.get()
  // Glass's wall is Wikipedia's picture of the day in deck; until it comes over, Glass is solid here.
  return { ...s, dark: isDark(s), wall: seeThrough(s.theme) && s.theme === COSMOS_ID, vars: vars(), term: variant().term }
}

/** The theme changed (settings or the OS): repaint the window and every tile. */
function pushTheme(): void {
  const v = vars()
  win?.setBackgroundColor(v['--ws-bg'])
  core?.settings.setDark(isDark(settings.get()))
  win?.webContents.send(CH.themeChanged, themeState())
  recorder?.page()?.send(REC.theme, v)
  for (const g of liveByTile.values()) g.wc.send(CH.theme, v)
}

const door = new Door({
  manifest: (id) => registry.tiles.get(id)?.manifest,
  live: (id) => instancesOf(id).length > 0,
  answers: (id, op) => instancesOf(id).some((g) => g.ops.has(op)),
  deliver: (id, call: DoorCall) => {
    if (call.session) lastCaller.set(id, { session: call.session, at: Date.now() })
    const g = instancesOf(id)
      .filter((x) => x.ops.has(call.op))
      .sort((a, b) => b.usedAt - a.usedAt)[0]
    g?.wc.send(CH.doorCall, call)
    return g && pageOf(g)
  },
  hook: (name, token, payload) => core?.hook(name, token, payload),
  core: (name, token, payload) => (core ? core.call(name, token, payload) : Promise.reject(new Error('workshop is starting'))),
  ask: (name, token, payload, gone) => (core ? core.ask(name, token, payload, gone) : Promise.reject(new Error('workshop is starting')))
})

/**
 * The trusted tier's processes (main/backend.ts): one per built-in tile with a backend, while it is
 * on. Their output goes to <profile>/logs/backend-<id>.log. A smoke run restarts them sooner, so
 * it can watch one give up.
 */
const backends = new Backends({
  spawn: utilitySpawn(utilityProcess as unknown as UtilityProcessLike, join(__dirname, 'backend-host.js'), join(app.getPath('userData'), 'logs'), () => backendEnv(shellEnv())),
  onStatus: (id, st) => {
    for (const g of instancesOf(id)) g.wc.send(CH.backendStatusChanged, st)
  },
  onEvent: (id, name, data) => {
    for (const g of instancesOf(id)) g.wc.send(CH.backendEvent, { name, data })
  },
  delays: SMOKE ? [100, 200, 300] : undefined
})

/** Whether any instance of a tile is turned on in the column (shared/column.ts). */
function tileIsOn(id: string): boolean {
  const c = settings.get().column ?? EMPTY_COLUMN
  return !c.off.includes(id) || c.extra.some((k) => k.startsWith(`${id}.`))
}

/**
 * Starts the backends of the built-in tiles that are on and stops the rest. Run whenever the
 * column or the registry changes: a tile turned off, or a dev folder standing in for a built-in
 * tile (a dev tile never has a backend), stops its backend.
 */
function syncBackends(): void {
  const wanted: BackendTile[] = []
  for (const t of registry.tiles.values()) {
    if (t.source !== 'core' || !t.backend || !t.manifest.backend || !tileIsOn(t.manifest.id)) continue
    wanted.push({ id: t.manifest.id, name: t.manifest.name, program: t.backend, root: t.root, decl: t.manifest.backend })
  }
  backends.sync(wanted)
}

const grants = new Map<string, TileGrants>()
function grantsOf(id: string): TileGrants {
  let g = grants.get(id)
  if (!g) grants.set(id, (g = TileGrants.forTile(tileDataDir(), id)))
  return g
}
setGrants(grantsOf)
/** One chooser at a time, whoever asks. */
let picking = false

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

function need(e: IpcMainInvokeEvent | IpcMainEvent, perm?: 'storage' | 'notify' | 'files' | 'sessions' | 'usage' | 'overlay' | 'viewer' | 'transcripts' | 'activity'): Guest {
  const g = guestOf(e)
  if (!g) throw new Error('not a tile')
  if (perm && !g.tile.manifest.permissions[perm]) throw new Error(`this tile did not ask for "${perm}" in tile.json`)
  return g
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

/** URLs a smoke run would have opened in the browser (it never opens one). */
export const smokeOpened: string[] = []
/** What tiles asked the launcher to be filled with in a smoke run. */
export const smokeLaunches: LaunchPrefill[] = []

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

/** A port nothing is using now, for a smoke run's sign-ins (the installed app may be using 47800). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
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
    // DNS prefetch goes around the dead proxy and the request filter: a page's <link
    // rel=dns-prefetch> would send any name it likes to the resolver (smoke's sideDoors).
    prefs.additionalArguments = ['--blink-settings=dnsPrefetchingEnabled=false']
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
    const g: Guest = { tile, wc, key, ops: new Set(), usedAt: Date.now(), gestureAt: 0, doc: 0 }
    const id = tile.manifest.id
    guests.set(wc.id, g)
    liveByTile.set(key, g)
    wc.on('focus', () => (g.usedAt = Date.now()))
    // What counts as the user acting in this page, for openOverlay: input that reached it through
    // the window (a script in the page cannot make these), never the Esc that closed an overlay.
    wc.on('input-event', (_ev, input) => {
      if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap') g.gestureAt = Date.now()
    })
    escClosesOverlay(wc)
    coreShortcuts(wc)
    wc.on('before-input-event', (ev, input) => {
      if (input.type === 'keyDown' && input.key !== 'Escape' && !ev.defaultPrevented) g.gestureAt = Date.now()
    })
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
    // A reload (a dev tile saved, smoke, a crash) keeps this webContents but ends its document.
    // When the new one commits (not when a navigation starts: one the sandbox cancels must leave
    // the page answering), its ops are its own to register (until then the door says "not
    // answering yet"), and a call the old one took and never answered fails at once rather than
    // waiting out the tile's timeout.
    wc.on('did-navigate', () => {
      g.ops.clear()
      door.dropPage(pageOf(g))
      g.doc++
    })
    wc.once('destroyed', () => {
      guests.delete(wc.id)
      if (liveByTile.get(key) === g) liveByTile.delete(key)
      door.dropPage(pageOf(g))
      oauth?.dropPage(wc.id)
    })
  })
}

const devWatchers = new Map<string, FSWatcher>()
/** A dev tile's id → the folder it was given as (a tile's own `root` is that folder's real path). */
const devFolders = new Map<string, string>()

/**
 * Loads (or loads again) a tile folder under development. It may stand in for a core or installed
 * tile with the same id. A folder serving its own files is watched: a change to the page reloads
 * it, a change to tile.json or plugin/ loads the tile again. A dev-server entry reloads itself.
 */
async function addDevTile(folder: string): Promise<string> {
  // Remembered, so it is there at the next start too (the + menu's "stop loading" forgets it).
  if (!SMOKE && !settings.get().devTiles.includes(folder)) await settings.patch({ devTiles: [...settings.get().devTiles, folder] })
  const t = await readTile(folder, 'dev')
  registry.problems = registry.problems.filter((p) => p.folder !== folder)
  if ('errors' in t) {
    registry.problems.push(t)
    console.warn(`[tiles] refused ${folder}:\n  ${t.errors.join('\n  ')}`)
    win?.webContents.send(CH.tilesChanged)
    return t.errors.join('\n')
  }
  const id = t.manifest.id
  devFolders.set(id, folder)
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
  syncBackends()
  win?.webContents.send(CH.tilesChanged)
  return `loaded ${id} from ${tile.root}${tile.devOrigin ? ` (dev server ${tile.devOrigin})` : ', reloading on change'}`
}

/** Stops loading a tile under development. Its folder and what it stored are left alone. */
async function forgetDevTile(id: string): Promise<void> {
  const t = registry.tiles.get(id)
  if (!t || t.source !== 'dev') return
  const folder = devFolders.get(id) ?? t.root
  await settings.patch({ devTiles: settings.get().devTiles.filter((d) => d !== folder) })
  devWatchers.get(folder)?.close()
  devWatchers.delete(folder)
  devFolders.delete(id)
  registry.tiles.delete(id)
  syncBackends()
  win?.webContents.send(CH.tilesChanged)
}

/** Where the + menu makes new tiles: a folder the user can find, open in an editor and push to GitHub. */
const newTilesDir = (): string => (SMOKE ? join(app.getPath('userData'), 'workshop-tiles') : join(homedir(), 'workshop-tiles'))

/**
 * "Make a tile with Claude": the starter tile in a new folder, loaded at once as a dev tile (it
 * reloads on every save), and a session in that folder told what to build. The folder's CLAUDE.md
 * is the tile contract, so the session has it without being handed a plugin.
 */
async function createTile(name: string, idea: string): Promise<{ id: string; folder: string }> {
  if (!core) throw new Error('sessions are not running')
  const want = String(idea ?? '').trim().slice(0, 4000)
  const made = await scaffoldTile(coreFile('template'), newTilesDir(), String(name ?? ''), want.split('\n')[0], (id) => registry.tiles.has(id))
  await addDevTile(made.folder)
  const prompt = [
    `Build the workshop tile "${made.name}" in this folder.`,
    want ? `What it should do: ${want}` : 'Ask me what it should do before you write anything.',
    'This folder already holds a working starter tile, and workshop is showing it in its right-hand column now: it reloads whenever you save a file. Read CLAUDE.md here first. It is the tile contract: the manifest, the permissions, and everything window.workshop can do.',
    'Ask for the fewest permissions that do the job. When it works, tell me what you built, which permissions it asks for, and anything the sandbox would not let it do.'
  ].join('\n\n')
  await core.sessions.newSession({ cwd: made.folder, name: `tile: ${made.name}`.slice(0, 60), prompt })
  return { id: made.id, folder: made.folder }
}

/**
 * What a tile with "sessions" sees of them: no ids it could not use, no titles (they quote the
 * conversation). `project` is the folder the session started in; `root` the project it belongs
 * to (the repository's root, shared by its worktrees: project.ts).
 */
function tileSessions(s: SessionsState): { id: string; name: string; project: string; root: string; status: string; focused: boolean; open: boolean }[] {
  return s.sessions.map((v) => ({ id: v.id, name: v.name, project: v.cwd, root: roots.get(v.id, v.cwd), status: v.status, focused: v.id === s.focus, open: v.open }))
}
const lastPaste = new Map<string, number>()
const roots = new ProjectRoots()
// The file viewer's rule for web pages: their folder only inside an open session's folder or project.
setSessionFolders(async () => {
  const open = (core?.sessions.getState().sessions ?? []).filter((v) => v.open)
  await roots.ready(open)
  return open.flatMap((v) => [v.cwd, roots.get(v.id, v.cwd)])
})

/** Every session's root is resolved before a tile hears of it; then the latest state goes out. */
function pushSessions(s: SessionsState): void {
  void (async () => {
    await roots.ready(s.sessions)
    // A session may have started while git answered: resolve it too (nothing to wait for otherwise).
    const latest = core?.sessions.getState() ?? s
    await roots.ready(latest.sessions)
    const list = tileSessions(latest)
    // A backend hears of every session, whatever its tile's permissions: folders, never tokens.
    const views = new Map(latest.sessions.map((v) => [v.id, v]))
    backends.setSessions(list.map((v) => ({ id: v.id, name: v.name, folder: v.project, root: v.root, status: v.status, started: views.get(v.id)?.createdAt ?? 0, active: views.get(v.id)?.activeAt ?? null })))
    for (const g of liveByTile.values()) if (g.tile.manifest.permissions.sessions) g.wc.send(CH.tileSessionsChanged, list)
  })()
}
/**
 * "transcripts" (bridge 1.7): which sessions' conversations each tile page watches, by webContents
 * id. A page hears only the sessions it asked for, and only while it has the permission.
 */
const transcriptWatch = new Map<number, { g: Guest; ids: Set<string> }>()
/** A session's conversation as core parses it (what a session tile shows), for a tile; only a session's, never a subagent's. */
function tileTranscript(id: unknown): Transcript | null {
  const sid = String(id)
  if (!/^[0-9a-f]{6}$/.test(sid) || !core?.sessions.find(sid)) throw new Error('sessions.transcript: no such session')
  return core.transcripts.get(sid)
}
function pushTranscript(t: Transcript): void {
  for (const { g, ids } of transcriptWatch.values()) if (ids.has(t.id) && g.tile.manifest.permissions.transcripts && !g.wc.isDestroyed()) g.wc.send(CH.tileTranscriptChanged, t.id, t)
}
/** "activity" (bridge 1.10): which sessions' activity each tile page watches, by webContents id. */
const activityWatch = new Map<number, { g: Guest; ids: Set<string> }>()
function tileActivity(id: unknown): Activity | null {
  const sid = String(id)
  if (!/^[0-9a-f]{6}$/.test(sid) || !core?.sessions.find(sid)) throw new Error('sessions.activity: no such session')
  return core.activity(sid)
}
/** Computed once per change, and only when some page watches that session. */
function pushActivity(sid: string): void {
  let a: Activity | null | undefined
  for (const { g, ids } of activityWatch.values()) {
    if (!ids.has(sid) || !g.tile.manifest.permissions.activity || g.wc.isDestroyed()) continue
    if (a === undefined) a = core?.activity(sid) ?? null
    if (a) g.wc.send(CH.tileActivityChanged, sid, a)
  }
}
function pushUsage(u: Usage): void {
  for (const g of liveByTile.values()) if (g.tile.manifest.permissions.usage) g.wc.send(CH.tileUsageChanged, u)
}

function bridge(): void {
  ipcMain.handle(CH.tileSessionsList, async (e) => {
    need(e, 'sessions')
    if (!core) return []
    await roots.ready(core.sessions.getState().sessions)
    return tileSessions(core.sessions.getState())
  })
  ipcMain.handle(CH.tileSessionsPaste, (e, id: string, text: string) => {
    const { tile } = need(e, 'sessions')
    if (tile.manifest.permissions.sessions !== 'write') throw new Error(`this tile asked for "sessions": "${tile.manifest.permissions.sessions}"; pasting needs "write"`)
    if (typeof text !== 'string' || !text.trim() || text.length > 10_000) throw new Error('sessions.paste: text of 1 to 10,000 characters')
    const rec = core?.sessions.find(String(id))
    if (!rec || !rec.open) throw new Error('sessions.paste: no such open session')
    const now = Date.now()
    if (now - (lastPaste.get(tile.manifest.id) ?? 0) < 2000) throw new Error('sessions.paste: one every two seconds')
    lastPaste.set(tile.manifest.id, now)
    core!.sessions.paste(rec.id, text)
  })
  // The new-session form, filled in: the user presses Start. A tile can never start a session or
  // write its first prompt, and it may open the form only in answer to a click or key in its page
  // (the overlay's rule), so it cannot take the center on a timer.
  ipcMain.handle(CH.tileSessionsLaunch, (e, opts: unknown) => {
    const g = need(e, 'sessions')
    const level = g.tile.manifest.permissions.sessions
    if (level !== 'launch' && level !== 'write') throw new Error(`this tile asked for "sessions": "${level}"; launching needs "launch"`)
    const req = launchRequest(opts)
    if (Date.now() - g.gestureAt > GESTURE_MS) throw new Error('sessions.launch: only in answer to a click or key in the tile')
    let dir = false
    try {
      dir = statSync(req.folder).isDirectory()
    } catch {
      // not there
    }
    if (!dir) throw new Error('sessions.launch: no such folder')
    g.gestureAt = 0
    const prefill: LaunchPrefill = { cwd: resolve(req.folder), worktree: req.worktree, ...(req.branch ? { branch: req.branch } : {}), nonce: Date.now() }
    if (SMOKE) smokeLaunches.push(prefill)
    win?.webContents.send(CH.sessionsLaunch, prefill)
  })
  ipcMain.handle(CH.tileTranscriptGet, (e, id: unknown) => {
    need(e, 'transcripts')
    return tileTranscript(id)
  })
  ipcMain.on(CH.tileTranscriptWatch, (e, id: unknown, on: unknown) => {
    let g: Guest
    try {
      g = need(e, 'transcripts')
      tileTranscript(id)
    } catch {
      return
    }
    let w = transcriptWatch.get(g.wc.id)
    if (!w) {
      const wcId = g.wc.id
      transcriptWatch.set(wcId, (w = { g, ids: new Set() }))
      g.wc.once('destroyed', () => transcriptWatch.delete(wcId))
    }
    if (on === true) w.ids.add(String(id))
    else w.ids.delete(String(id))
  })
  ipcMain.handle(CH.tileActivityGet, (e, id: unknown) => {
    need(e, 'activity')
    return tileActivity(id)
  })
  ipcMain.on(CH.tileActivityWatch, (e, id: unknown, on: unknown) => {
    let g: Guest
    try {
      g = need(e, 'activity')
      tileActivity(id)
    } catch {
      return
    }
    let w = activityWatch.get(g.wc.id)
    if (!w) {
      const wcId = g.wc.id
      activityWatch.set(wcId, (w = { g, ids: new Set() }))
      g.wc.once('destroyed', () => activityWatch.delete(wcId))
    }
    if (on === true) w.ids.add(String(id))
    else w.ids.delete(String(id))
  })
  ipcMain.handle(CH.tileUsageGet, (e) => {
    need(e, 'usage')
    return core?.usage.get() ?? null
  })

  ipcMain.on(CH.hello, (e) => {
    const t = tileOf(e)
    if (!t) {
      e.returnValue = null
      return
    }
    // Every new document says hello first, so a reloaded page starts with no door ops until it registers them again.
    const g = guests.get(e.sender.id)!
    g.ops = new Set()
    music?.forget(e.sender.id)
    oauth?.dropPage(e.sender.id)
    const hello: TileHello = { id: t.manifest.id, instance: g.key, view: views.get(g.key) ?? 'tile', vars: vars(), bridge: BRIDGE_VERSION, permissions: t.manifest.permissions }
    if (t.manifest.permissions.oauth && oauth) hello.oauthRedirect = oauth.redirectUri(t.manifest.id)
    if (t.backend && t.manifest.backend) hello.backendOps = [...t.manifest.backend.ops]
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

  ipcMain.handle(CH.overlay, (e, open: boolean) => {
    if (!open) {
      const g = need(e)
      if (overlayKey === g.key) closeOverlay()
      return
    }
    const g = need(e, 'overlay')
    // Only straight after the user clicked or typed in this page, and once per click: a page
    // cannot open itself over the window on a timer, or reopen in the moment it was closed.
    if (Date.now() - g.gestureAt > GESTURE_MS) throw new Error('openOverlay: only in answer to a click or key in the tile')
    g.gestureAt = 0
    win?.webContents.send(CH.tileOverlay, g.key, true)
  })

  // A picture for core's viewer (bridge 1.9): only straight after a click or key in this page, once
  // per input (the overlay's rule). Kept in the profile's viewer/ and opened like any file; the
  // tile's own overlay, if it is up, steps aside so the viewer is on top.
  ipcMain.handle(CH.tileViewerShow, async (e, data: Uint8Array, name: string, caption: unknown) => {
    const g = need(e, 'viewer')
    if (Date.now() - g.gestureAt > GESTURE_MS) throw new Error('viewer.show: only in answer to a click or key in the tile')
    g.gestureAt = 0
    const path = await keepShown(join(app.getPath('userData'), 'viewer'), data, typeof name === 'string' ? name : '')
    if (overlayKey === g.key) closeOverlay()
    const ref: PreviewRef = { path, line: null, ...(cleanCaption(caption) ? { caption: cleanCaption(caption)! } : {}) }
    win?.webContents.send(CH.previewOpen, ref, '')
  })

  ipcMain.handle(CH.external, (e, url: string) => {
    const { tile } = need(e)
    if (typeof url !== 'string' || !isHttp(url)) throw new Error('openExternal: http(s) URLs only')
    if (!openForTile(tile.manifest.id, url)) throw new Error('openExternal: one a second')
  })

  // A sign-in (bridge 1.5): only for a declared host, only straight after a click or key in this
  // page (once per input, like the overlay), and the redirect pinned to this tile's own path.
  ipcMain.handle(CH.oauthAuthorize, async (e, url: unknown) => {
    const g = need(e)
    const hosts = g.tile.manifest.permissions.oauth
    if (!hosts || !oauth) throw new Error('this tile did not ask for "oauth" in tile.json')
    if (Date.now() - g.gestureAt > GESTURE_MS) throw new Error('oauth: needs a click in the tile')
    g.gestureAt = 0
    return oauth.authorize(g.tile.manifest.id, g.wc.id, hosts, url)
  })
  ipcMain.handle(CH.oauthCancel, (e) => {
    const g = need(e)
    if (g.tile.manifest.permissions.oauth) oauth?.cancel(g.tile.manifest.id)
  })

  // One store per tile, shared by its instances: a write is seen by every one of them.
  ipcMain.handle(CH.storageGet, (e, key: string) => storeOf(need(e, 'storage').tile.manifest.id).get(key))
  ipcMain.handle(CH.storageSet, async (e, key: string, value: unknown) => {
    const id = need(e, 'storage').tile.manifest.id
    await storeOf(id).set(key, value)
    for (const g of instancesOf(id)) g.wc.send(CH.storageChanged, key, value ?? null)
  })

  ipcMain.handle(CH.notify, (e, n: { text?: unknown; attention?: unknown }) => {
    const g = need(e, 'notify')
    const t = g.tile
    const text = typeof n?.text === 'string' ? n.text.slice(0, 200) : ''
    if (!text) throw new Error('notify: { text }')
    const now = Date.now()
    if (now - (lastNotify.get(t.manifest.id) ?? 0) < 3000) return false
    lastNotify.set(t.manifest.id, now)
    win?.webContents.send(CH.tileNotify, g.key, text)
    if (n?.attention === true) {
      // The relevant mascot: the session that last called this tile through the door, else the one in focus.
      const c = lastCaller.get(t.manifest.id)
      const state = core?.sessions.getState()
      const live = (id: string | null | undefined): boolean => !!id && !!state?.sessions.some((s) => s.id === id && s.open)
      const target = c && now - c.at < CALLER_MS && live(c.session) ? c.session : live(state?.focus) ? state!.focus : null
      if (target) win?.webContents.send(CH.attention, target)
    }
    if (!SMOKE && Notification.isSupported()) new Notification({ title: t.manifest.name, body: text, silent: true }).show()
    return true
  })

  ipcMain.handle(CH.filesPick, async (e, opts: { folder?: unknown; title?: unknown }) => {
    const { tile } = need(e, 'files')
    if (picking) throw new Error('files: a chooser is already open')
    picking = true
    try {
      const folder = opts?.folder !== false
      let path: string | undefined
      if (SMOKE) path = process.env.WORKSHOP_SMOKE_PICK // the smoke test stands in for the user
      else {
        const title = typeof opts?.title === 'string' ? opts.title.slice(0, 80) : ''
        const r = await dialog.showOpenDialog(win!, {
          title: `${tile.manifest.name}${title ? `: ${title}` : ''}`,
          message: `${tile.manifest.name} will be able to read what you choose here, and nothing else.`,
          buttonLabel: `Let ${tile.manifest.name} read it`,
          properties: folder ? ['openDirectory'] : ['openFile']
        })
        path = r.canceled ? undefined : r.filePaths[0]
      }
      if (!path) return null
      return TileGrants.public(await grantsOf(tile.manifest.id).add(path))
    } finally {
      picking = false
    }
  })
  ipcMain.handle(CH.filesList, async (e) => (await grantsOf(need(e, 'files').tile.manifest.id).list()).map(TileGrants.public))
  ipcMain.handle(CH.filesEntries, (e, handle: string, rel: string) => grantsOf(need(e, 'files').tile.manifest.id).entries(String(handle), String(rel ?? '')))
  ipcMain.handle(CH.filesForget, (e, handle: string) => grantsOf(need(e, 'files').tile.manifest.id).forget(String(handle)))

  // The trusted tier: the page asks, core checks who is asking and that the op is declared, the
  // backend answers. Only a built-in tile's own page, from its top frame, on its own origin.
  const withBackend = (e: IpcMainInvokeEvent): Tile => {
    const { tile } = need(e)
    if (!tile.backend || !tile.manifest.backend || tile.source !== 'core') throw new Error('this tile has no backend')
    return tile
  }
  ipcMain.handle(CH.backendCall, (e, op: unknown, body: unknown) => backends.call(withBackend(e).manifest.id, String(op), body))
  ipcMain.handle(CH.backendStatus, (e) => backends.status(withBackend(e).manifest.id))

  // A wheel the page had no use for goes to the tile column (deck's rule: a tile never eats the
  // wheel). Only from a live tile's top frame, only while it is in the column, never a pinch.
  ipcMain.on(CH.wheel, (e, dy: unknown) => {
    const g = guestOf(e)
    if (!g || (views.get(g.key) ?? 'tile') !== 'tile' || typeof dy !== 'number' || !Number.isFinite(dy) || dy === 0) return
    win?.webContents.send(CH.tileWheel, g.key, Math.max(-4000, Math.min(4000, dy)))
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
    door.answer(pageOf(g), callId, r.ok === true ? { ok: true, result: r.result } : { ok: false, error: String(r.error ?? 'failed').slice(0, 500) })
  })

  // Core's own window.
  ipcMain.handle(CH.listTiles, (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return { tiles: [...registry.tiles.values()].map(tileInfo), problems: registry.problems, theme: themeState() }
  })
  ipcMain.handle(CH.setSettings, async (e, patch: Partial<Settings>) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    await settings.patch(patch && typeof patch === 'object' ? patch : {})
    pushTheme()
    return themeState()
  })
  // The tile column's state, in settings (null until first saved: the window then migrates its old
  // localStorage). Writes are queued, so two quick changes cannot race on the settings file.
  let columnWrites: Promise<unknown> = Promise.resolve()
  ipcMain.handle(CH.columnGet, (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return settings.get().column ?? null
  })
  ipcMain.handle(CH.columnSet, (e, c: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    const column = cleanColumn(c)
    if (!column) throw new Error('not a column')
    const write = columnWrites.then(() => settings.patch({ column })).then(syncBackends)
    columnWrites = write.catch(() => undefined)
    return write.then(() => undefined)
  })
  ipcMain.handle(CH.tileCreate, (e, name: string, idea: string) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return createTile(name, idea)
  })
  ipcMain.handle(CH.tileForget, (e, id: string) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return forgetDevTile(String(id))
  })
  // The mascot (§8). Only core's window may change it, never a tile.
  ipcMain.handle(CH.mascotGet, (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    return mascots.load(settings.get().mascot)
  })
  ipcMain.handle(CH.mascotSave, async (e, pack: unknown, png: unknown, workerPng: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    const was = settings.get().mascot
    const id = await mascots.save(pack, png, workerPng)
    await settings.patch({ mascot: id })
    if (was && was !== id) await mascots.remove(was)
    const active = await mascots.load(id)
    win?.webContents.send(CH.mascotChanged, active)
    return active
  })
  ipcMain.handle(CH.mascotRemove, async (e) => {
    if (e.sender !== win?.webContents) throw new Error('core only')
    const was = settings.get().mascot
    await settings.patch({ mascot: null })
    await mascots.remove(was)
    win?.webContents.send(CH.mascotChanged, null)
  })
  ipcMain.handle(CH.setView, (e, key: string, view: TileView) => {
    if (e.sender !== win?.webContents || (view !== 'tile' && view !== 'pane' && view !== 'overlay' && view !== 'float')) return
    if (view === 'overlay' && !registry.tiles.get(key.replace(/\.\d$/, ''))?.manifest.permissions.overlay) return
    if (view === 'float' && !registry.tiles.get(key.replace(/\.\d$/, ''))?.manifest.float) return
    const was = views.get(key)
    views.set(key, view)
    if (view === 'overlay') overlayKey = key
    else if (overlayKey === key) overlayKey = null
    const g = liveByTile.get(key)
    if (!g) return
    // Leaving the overlay uses up whatever click was made in it.
    if (was === 'overlay' && view !== 'overlay') g.gestureAt = 0
    g.usedAt = Date.now()
    g.wc.send(CH.view, view)
  })
}

const MIN_WINDOW = { width: 900, height: 600 }

/** Where the window opens: smoke's fixed size (its layout checks and pictures), else window-bounds.ts. */
function windowBounds(): { x?: number; y?: number; width: number; height: number } {
  if (SMOKE) return { width: 1500, height: 950 }
  return placeWindow(settings.get().window, screen.getAllDisplays().map((d) => d.workArea), screen.getPrimaryDisplay().workArea, MIN_WINDOW)
}

/** Saves where the window is, a moment after it stops moving or changing size (not in smoke). */
function rememberBounds(w: BrowserWindow): void {
  if (SMOKE) return
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // Full screen and minimised are states, not places: what is kept is the normal window.
      if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return
      settings.patch({ window: w.getNormalBounds() }).catch((err) => console.error('[window] its place could not be saved:', err))
    }, 500)
  }
  w.on('resize', save)
  w.on('move', save)
}

function createWindow(): void {
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: !SMOKE,
    title: 'workshop',
    titleBarStyle: 'hiddenInset',
    // The window's buttons sit at the middle of the top bar (`--bar` in styles.css, 88 px): they
    // are 14 px tall, so 37 from the top, where deck puts them in a bar of the same height.
    trafficLightPosition: { x: 14, y: 37 },
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
  // Core's window never leaves its own page. Under `npm run dev` that page is Vite's, and Vite
  // reloads it (a full reload is a navigation to the same origin), so that one is let through.
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null
  win.webContents.on('will-navigate', (e, url) => {
    if (devOrigin && URL.canParse(url) && new URL(url).origin === devOrigin) return
    e.preventDefault()
  })
  guardWebviews(win)
  escClosesOverlay(win.webContents)
  escClosesViewer(win.webContents)
  coreShortcuts(win.webContents)
  if (SMOKE) {
    win.webContents.on('console-message', (e) => console.log(`[window] ${e.message}`))
    win.webContents.on('did-attach-webview', (_e, wc) => {
      wc.on('console-message', (e) => console.log(`[tile ${wc.getURL()}] ${e.message}`))
      wc.on('preload-error', (_e, path, err) => console.log(`[tile preload ${path}] ${err.message}`))
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(devMode?.index() ?? BUNDLED_PAGE)
  rememberBounds(win)
  win.on('closed', () => (win = null))
}

/** What this app was built from, if it is a packaged app built by `npm run dist` on its usual profile. */
function buildInfo() {
  if (!app.isPackaged || SMOKE || NAMED) return null
  try {
    const info = parseBuildInfo(readFileSync(join(__dirname, '../build-info.json'), 'utf8'))
    return info && existsSync(info.repo) ? info : null
  } catch {
    return null // an app built without the stamp
  }
}

/** Core's window as it ships inside the app. */
const BUNDLED_PAGE = join(__dirname, '../renderer/index.html')

/**
 * Dev mode: offered when the app was built from a checkout (the updater's build info), never under
 * `npm run dev` (live already) or in a smoke run. WORKSHOP_DEV_REPO=<checkout> offers it on an
 * unpackaged build (`npx electron .`), to try it without installing.
 */
function startDevMode(): void {
  const repo = buildInfo()?.repo ?? (!app.isPackaged && !DEV && !SMOKE && process.env.WORKSHOP_DEV_REPO?.startsWith('/') ? process.env.WORKSHOP_DEV_REPO : null)
  devMode = new DevMode({
    repo,
    outDir: join(app.getPath('userData'), 'devmode'),
    env: shellEnv,
    onChange: (s) => win?.webContents.send(CH.devState, s),
    load: (index) => {
      if (!win || win.isDestroyed()) return
      // The new page's terminals start blank and modeless: once they have mounted, every session is reattached.
      const w = win
      w.webContents.once('did-finish-load', () => setTimeout(() => core?.sessions.reattachAll(), 800))
      // The same page again is a reload (what a save looks like); the first build is a load.
      if (win.webContents.getURL() === pathToFileURL(index).href) win.webContents.reloadIgnoringCache()
      else void win.loadFile(index)
    },
    unload: () => {
      if (!win || win.isDestroyed()) return
      win.webContents.once('did-finish-load', () => setTimeout(() => core?.sessions.reattachAll(), 800))
      void win.loadFile(BUNDLED_PAGE)
    }
  })
  const coreOnly = (e: IpcMainInvokeEvent): void => {
    if (e.sender !== win?.webContents) throw new Error('not core')
  }
  ipcMain.handle(CH.devGet, (e) => (coreOnly(e), devMode!.get()))
  ipcMain.handle(CH.devSet, (e, on: unknown) => (coreOnly(e), devMode!.set(on === true)))
}

/** Who each CLI is signed in as (main/accounts.ts). Not in a smoke run: its CLIs are stand-ins. */
function startAccounts(): void {
  accounts = new Accounts({ env: shellEnv, onChange: (s) => win?.webContents.send(CH.accountsState, s) })
  const coreOnly = (e: IpcMainInvokeEvent): void => {
    if (e.sender !== win?.webContents) throw new Error('not core')
  }
  ipcMain.handle(CH.accountsGet, (e) => (coreOnly(e), accounts!.get()))
  ipcMain.handle(CH.accountsSignIn, (e, cli: unknown, how: unknown) => {
    coreOnly(e)
    const way = how === 'console' || how === 'sso' || how === 'claudeai' ? how : undefined
    if (cli === 'claude') accounts!.signIn(cli, way)
    else if (cli === 'codex') accounts!.signIn(cli)
  })
  ipcMain.handle(CH.accountsSignOut, async (e, cli: unknown) => {
    coreOnly(e)
    if (cli === 'claude' || cli === 'codex') await accounts!.signOut(cli)
  })
  ipcMain.handle(CH.accountsCancel, (e) => (coreOnly(e), accounts!.cancel()))
  if (SMOKE) return
  accounts.start()
  app.on('browser-window-focus', () => accounts?.focused())
}

function startUpdater(): void {
  updater = new Updater({
    info: buildInfo(),
    env: shellEnv,
    logPath: join(app.getPath('userData'), 'update.log'),
    onChange: (u) => win?.webContents.send(CH.updateState, u),
    bundle: bundleOf(app.getPath('exe')) ?? '',
    bundleName: `${app.getName()}.app`,
    quit: () => app.quit()
  })
  const coreOnly = (e: IpcMainInvokeEvent): void => {
    if (e.sender !== win?.webContents) throw new Error('not core')
  }
  ipcMain.handle(CH.updateGet, (e) => (coreOnly(e), updater!.get()))
  ipcMain.handle(CH.updateInstall, async (e) => (coreOnly(e), await updater!.install()))
  updater.start()
  app.on('browser-window-focus', () => void updater?.check())
}

app.whenReady().then(async () => {
  // The packaged app's icon is the bundle's (build/icon.icns); the dev build is Electron's own
  // binary, so it is given the Knot here, or the Dock shows Electron's atom.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = join(app.getAppPath(), 'build', 'icon.png')
    if (existsSync(icon)) app.dock?.setIcon(icon)
  }
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  mascots = new MascotStore(join(app.getPath('userData'), 'mascots'))
  registry = await loadTiles([
    { dir: coreFile('tiles'), source: 'core' },
    ...SMOKE_BUILTINS,
    { dir: join(app.getPath('userData'), 'tiles'), source: 'installed' }
  ])
  for (const p of registry.problems) console.warn(`[tiles] refused ${p.folder}:\n  ${p.errors.join('\n  ')}`)
  await Promise.all([...registry.tiles.values()].map(armSession))
  // A remembered folder that is gone (moved, deleted) is forgotten, not shown as a refused tile for ever.
  const kept = settings.get().devTiles.filter((d) => existsSync(join(d, 'tile.json')))
  if (kept.length !== settings.get().devTiles.length) await settings.patch({ devTiles: kept })
  for (const dir of new Set([...kept, ...devTiles])) console.log(`[tiles] ${await addDevTile(dir)}`)
  app.on('second-instance', (_e, argv, cwd) => {
    for (const dir of devTilesIn(argv, cwd)) void addDevTile(dir).then((m) => console.log(`[tiles] ${m}`))
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })

  // The last port, if it is free: sessions that outlived the app find core where they left it.
  let lastPort = 0
  try {
    lastPort = Number(readFileSync(join(app.getPath('userData'), 'port'), 'utf8')) || 0
  } catch {
    // first launch
  }
  await door.start(lastPort)
  // Where the CLI finds the door from outside a session. Readable by this user only.
  writeFileSync(join(app.getPath('userData'), 'door.json'), JSON.stringify({ port: door.port, token: door.token }), { mode: 0o600 })

  oauth = new OAuthHost({ port: SMOKE ? await freePort() : OAUTH_PORT, open: openForTile })
  bridge()
  music = startMusic({ guest: guestOf, ...(SMOKE ? smokeMusicIo : { runner: osascriptRunner, fetchArt: fetchSpotifyArt }) })
  recorder = new Recorder({
    userData: app.getPath('userData'),
    audioSource: coreFile('native', 'recaudio.swift'),
    env: shellEnv,
    page: { url: process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/recorder.html` : undefined, file: join(__dirname, '../renderer/recorder.html') },
    preload: join(__dirname, '../preload/recorder.js'),
    core: () => win,
    // The center column on the screen, in points: its place in the page plus the page's on the screen.
    centerRect: async () => {
      if (!win || win.isDestroyed() || win.isMinimized()) return null
      const r = (await win.webContents
        .executeJavaScript(`(() => { const r = document.querySelector('.col.center')?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null })()`)
        .catch(() => null)) as { x: number; y: number; width: number; height: number } | null
      if (!r || r.width < 1 || r.height < 1) return null
      const c = win.getContentBounds()
      return { x: c.x + r.x, y: c.y + r.y, width: r.width, height: r.height }
    },
    hello: () => ({ vars: vars(), prefs: settings.get().recorder ?? REC_DEFAULTS }),
    savePrefs: async (recorderPrefs) => void (await settings.patch({ recorder: recorderPrefs })),
    outDir: SMOKE ? join(app.getPath('userData'), 'recordings') : join(homedir(), 'Movies', 'workshop'),
    smoke: SMOKE
  })
  await startTileMenu({ win: () => win, registry: () => registry, settings: () => settings, userData: app.getPath('userData'), addDevTile, dropData: (id) => (stores.delete(id), grants.delete(id)), smoke: SMOKE })
  core = await startSessions({
    win: () => win,
    door,
    home: app.getPath('userData'),
    profile: PROFILE,
    appPath: coreFile(),
    // Core's own plugin (its skills: workshop:doc) first, then every tile's.
    pluginDirs: () => [coreFile('plugin'), ...[...registry.tiles.values()].map((t) => t.plugin).filter((p): p is string => !!p)],
    doorTiles: () => doorTilesOf([...registry.tiles.values()]),
    dark: isDark(settings.get()),
    poll: !SMOKE,
    // The smoke run's stand-in CLIs: `claude`, and `codex` with its app-server.
    pathFirst: SMOKE && !process.env.WORKSHOP_REAL_CLAUDE ? ['fake-claude', 'fake-codex'].map((d) => join(app.getAppPath(), 'test/fixtures', d)).join(':') : undefined,
    claudeConfigDir: SMOKE && !process.env.WORKSHOP_REAL_CLAUDE ? join(app.getPath('userData'), 'claude-config') : undefined,
    onState: pushSessions,
    onUsage: pushUsage,
    onTranscript: pushTranscript,
    onActivity: pushActivity,
    // Which session made a commit (main/commits.ts): to the backends, whose History tab tags with it.
    onCommits: (all) => backends.setCommits(all)
  })
  startUpdater()
  startDevMode()
  startAccounts()
  backends.setCommits(core.commits.store.all())
  // The backends start with the sessions they will be told about already listed.
  pushSessions(core.sessions.getState())
  syncBackends()
  createWindow()

  nativeTheme.on('updated', pushTheme)

  if (SMOKE) {
    const ctx = { win: win!, door, liveByTile, backends, music: music.host, recorder: recorder!, userData: app.getPath('userData'), opened: smokeOpened, launches: smokeLaunches, addDevTile, core: core!, profile: PROFILE }
    if (smokeStartDeadline) clearTimeout(smokeStartDeadline)
    smokeStartDeadline = null
    const code = RESTARTED ? await runRestarted(ctx) : await runSmoke(ctx)
    core?.stop()
    backends.stopAll()
    music.host.stop()
    oauth?.stop()
    // The run that started this one cleans up the tmux server it still needs.
    if (!RESTARTED) await core?.tmux.killServer()
    door.stop()
    app.exit(code)
  }
})

// Sessions are parked, not killed: the next launch reattaches them.
app.on('before-quit', () => {
  updater?.stop()
  devMode?.dispose()
  accounts?.stop()
  core?.stop()
  backends.stopAll()
  music?.host.stop()
  oauth?.stop()
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
