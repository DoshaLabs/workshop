// `npm run smoke`: starts core with a throwaway profile and the probe tile (test/fixtures/probe),
// then tries, from INSIDE the probe's page, every way out of the sandbox it can think of, and
// drives the door over HTTP. Prints one line per check and exits non-zero if any failed.

import type { BrowserWindow, WebContents } from 'electron'
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import type { Door } from './door'
import { installs } from './smoke-install'
import { gitSmoke } from './smoke-git'
import { worktreesSmoke } from './smoke-worktrees'
import { historySmoke } from './smoke-history'
import { backendSmoke } from './smoke-backend'
import type { Backends } from './backend'
import { previewSmoke, reorderSmoke } from './smoke-preview'
import { uiSmoke, wheelSmoke } from './smoke-ui'
import { musicSmoke } from './smoke-music'
import type { MusicHost } from './music'
import { recorderSmoke } from './smoke-recorder'
import { agentsSmoke, transcriptsSmoke } from './smoke-agents'
import type { Recorder } from './recorder'

interface Ctx {
  win: BrowserWindow
  door: Door
  liveByTile: Map<string, { wc: WebContents; ops: Set<string>; usedAt: number }>
  userData: string
  /** What the tiles asked the browser to open (a smoke run never opens one). */
  opened: string[]
  addDevTile: (folder: string) => Promise<string>
  core: import('./core-sessions').CoreSessions
  /** The profile's name (its tmux socket), for a second core started on it. */
  profile?: string
  /** The trusted tier's processes (main/backend.ts). */
  backends?: Backends
  /** `workshop.music`, driven by a stand-in for osascript (smoke-music.ts). */
  music?: MusicHost
  /** The screen recorder (main/recorder.ts). */
  recorder?: Recorder
  /** What tiles filled the launcher with (workshop.sessions.launch). */
  launches?: { cwd: string; worktree?: boolean; branch?: string; nonce: number }[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Runs inside the probe's page. Every value is what the check found; `true` means held. */
const IN_PAGE = (doorPort: number): string => `(async () => {
  const r = {}
  const fails = async (p) => { try { const res = await p; return !res || res.ok === false } catch { return true } }
  r.noRequire = typeof require === 'undefined'
  r.noProcess = typeof process === 'undefined'
  r.bridgeId = window.workshop && workshop.id === 'probe'
  r.viewIsTile = workshop.view === 'tile'
  r.themeVar = getComputedStyle(document.documentElement).getPropertyValue('--ws-bg').trim().startsWith('#')
  r.ownFile = await fetch('tile://probe/secret.txt').then((x) => x.text()).then((t) => t.trim() === 'served').catch(() => false)
  r.noDotDot = await fails(fetch('tile://probe/%2e%2e/outside.txt'))
  r.noOtherTile = await fails(fetch('tile://wikipedia/index.html'))
  r.noUndeclaredHost = await fails(fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Fox'))
  r.noHttp = await fails(fetch('http://example.com/'))
  r.noLocalDoor = await fails(fetch('http://127.0.0.1:${doorPort}/tile/probe', { method: 'POST', body: '{"op":"echo"}' }))
  r.noFile = await fails(fetch('file:///etc/hosts'))
  r.noImage = await new Promise((res) => { const i = new Image(); i.onload = () => res(false); i.onerror = () => res(true); i.src = 'https://upload.wikimedia.org/wikipedia/commons/7/70/Example.png' })
  r.noSocket = await new Promise((res) => { try { const s = new WebSocket('wss://echo.websocket.org'); s.onopen = () => res(false); s.onerror = () => res(true) } catch { res(true) } })
  r.noCamera = await fails(navigator.mediaDevices.getUserMedia({ video: true }))
  r.noScreen = await fails(navigator.mediaDevices.getDisplayMedia({ video: true }))
  r.noPopup = window.open('https://example.com') === null
  // Over the whole window: the probe did not ask for "overlay", so not even a real click lets it.
  r.noOverlay = await workshop.openOverlay().then(() => false, (e) => /overlay/.test(e.message))
  r.undeclaredOpThrows = (() => { try { workshop.door.handle('nope', () => 1); return false } catch { return true } })()
  let watched = null
  const stop = workshop.storage.watch('k', (v) => { watched = v })
  await workshop.storage.set('k', { a: 1, list: [1, 2] })
  r.storageRoundTrip = JSON.stringify(await workshop.storage.get('k')) === '{"a":1,"list":[1,2]}'
  await new Promise((res) => setTimeout(res, 100))
  r.storageWatch = watched && watched.a === 1
  stop()
  r.storageRejectsHuge = await fails(workshop.storage.set('big', 'x'.repeat(6 * 1024 * 1024)))
  r.notify = (await workshop.notify({ text: 'smoke' })) === true
  r.notifyRateLimited = (await workshop.notify({ text: 'again' })) === false
  await workshop.head.set({ title: 'Probe', badge: '1' })
  r.head = true
  return r
})()`

const WIKI_IN_PAGE = `(async () => {
  const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Fox')
  return res.ok && (await res.json()).title === 'Fox'
})()`

const WEATHER_IN_PAGE = `(async () => {
  const f = await fetch('https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.13&current=temperature_2m')
  const g = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=Lisbon&count=1')
  return f.ok && typeof (await f.json()).current?.temperature_2m === 'number' && g.ok && (await g.json()).results?.length === 1
})()`

async function post(port: number, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

export async function runSmoke(ctx: Ctx): Promise<number> {
  const { win, door, liveByTile, userData, opened, addDevTile } = ctx
  const results: [string, boolean, string?][] = []
  const check = (name: string, ok: boolean, detail?: string): void => void results.push([name, ok, detail])
  try {
    await waitFor('the probe tile to load', async () => {
      const g = liveByTile.get('probe')
      return !!g && g.ops.has('echo') && (await g.wc.executeJavaScript('window.probeReady === true').catch(() => false))
    })
    await waitFor('the wikipedia tile to answer its door', () => !!liveByTile.get('wikipedia')?.ops.has('show'))
    const probe = liveByTile.get('probe')!.wc

    const inPage = (await probe.executeJavaScript(IN_PAGE(door.port))) as Record<string, boolean>
    for (const [k, v] of Object.entries(inPage)) check(`probe page: ${k}`, v === true, String(v))

    // The view follows core: the page's workshop.view and onViewChange see the move to the pane.
    await probe.executeJavaScript(`window.seenView = null; workshop.onViewChange((v) => { window.seenView = v }); true`)
    probe.send(CH.view, 'pane')
    await sleep(200)
    const view = (await probe.executeJavaScript(`[workshop.view, window.seenView]`)) as string[]
    check('probe page: view follows core', view[0] === 'pane' && view[1] === 'pane', JSON.stringify(view))
    probe.send(CH.view, 'tile')

    // A page cannot hand itself another tile's identity or a permission it did not declare.
    const forged = (await probe.executeJavaScript(`(async () => { try { await workshop.openPane(); return 'pane ok' } catch (e) { return e.message } })()`)) as string
    check('probe page: openPane allowed (pane: true)', forged === 'pane ok', forged)

    // Leaving its own origin: the page must stay where it is.
    await probe.executeJavaScript(`location.href = 'https://example.com/'`)
    await sleep(800)
    check('probe page: cannot navigate away', probe.getURL().startsWith('tile://probe/'), probe.getURL())

    // The popup and the navigation were refused in the page and handed to the browser, but only
    // the first within the second: a page cannot open tabs in a loop.
    check('probe page: popups and links go to the browser, rate limited', opened.length === 1 && opened[0].startsWith('https://example.com'), JSON.stringify(opened))

    const auth = { Authorization: `Bearer ${door.token}` }
    const echo = await post(door.port, '/tile/probe', { op: 'echo', args: ['hi'], caller: 'evil' }, auth)
    check('door: echo answers', echo.status === 200 && echo.json.result?.args?.[0] === 'hi', JSON.stringify(echo))
    check('door: caller comes from the token, not the body', echo.json.result?.caller === 'outside', echo.json.result?.caller)
    const undeclared = await post(door.port, '/tile/probe', { op: 'nope' }, auth)
    check('door: undeclared op refused', undeclared.status === 403, JSON.stringify(undeclared))
    const noToken = await post(door.port, '/tile/probe', { op: 'echo' }, {})
    check('door: no token refused', noToken.status === 401)
    const badToken = await post(door.port, '/tile/probe', { op: 'echo' }, { Authorization: `Bearer ${'0'.repeat(48)}` })
    check('door: wrong token refused', badToken.status === 401)
    const browser = await post(door.port, '/tile/probe', { op: 'echo' }, { ...auth, Origin: 'https://evil.example' })
    check('door: browser origin refused', browser.status === 403)
    const missing = await post(door.port, '/tile/nothing-here', { op: 'echo' }, auth)
    check('door: unknown tile is 404', missing.status === 404)
    const t0 = Date.now()
    const slow = await post(door.port, '/tile/probe', { op: 'slow' }, auth)
    check('door: timeout honoured', slow.status === 502 && Date.now() - t0 < 2000, `${slow.status} after ${Date.now() - t0} ms`)

    const store = JSON.parse(await readFile(join(userData, 'tile-data', 'probe', 'store.json'), 'utf8')) as Record<string, unknown>
    check('storage: written to disk by main', JSON.stringify(store.k) === '{"a":1,"list":[1,2]}')
    check('storage: oversized value not written', store.big === undefined)

    const wiki = liveByTile.get('wikipedia')!.wc
    check('wikipedia page: declared host reachable', (await wiki.executeJavaScript(WIKI_IN_PAGE).catch((e) => String(e))) === true)
    check('wikipedia page: weather hosts reachable', (await wiki.executeJavaScript(WEATHER_IN_PAGE).catch((e) => String(e))) === true)
    const wjs = (code: string): Promise<any> => wiki.executeJavaScript(code)
    check('wikipedia page: the clock is drawn', /\d:\d\d/.test(await wjs(`document.getElementById('time').textContent`)))
    // A fresh profile has no place saved, so the tile asks for a city; one is found and picked
    // the way a person would, and the weather for it is drawn under the clock.
    await waitFor('the wikipedia tile to ask for a city', async () => (await wjs(`!!document.querySelector('.wiki-places .wiki-place-input')`)) === true)
    check('wikipedia page: first run asks for a city', (await wjs(`document.querySelector('.wiki-places .wiki-tag').textContent`)).includes('where are you'))
    check('wikipedia page: the city prompt draws no missing piece as the word null', !String(await wjs(`document.body.innerText`)).includes('null'))
    await wjs(`(() => { const i = document.querySelector('.wiki-place-input'); i.value = 'Lisbon, Portugal'; i.dispatchEvent(new Event('input')); return true })()`)
    await waitFor('a place to be found', async () => (await wjs(`!!document.querySelector('.wiki-place-hit')`)) === true)
    check('wikipedia page: first run offers "not now"', (await wjs(`document.querySelector('.wiki-places-head .wiki-back')?.textContent ?? ''`)) === 'not now')
    // Choosing the city is the whole job: the editor closes on its own, with no Done to press.
    await wjs(`document.querySelector('.wiki-place-hit').click(); true`)
    check('wikipedia page: choosing a city closes the editor', (await wjs(`!document.querySelector('.wiki-places')`)) === true)
    await waitFor('the weather to be drawn', async () => /\d°/.test(await wjs(`document.querySelector('.wiki-weather-now .wiki-weather-temp')?.textContent ?? ''`)))
    check('wikipedia page: a weather reading is drawn', (await wjs(`document.querySelector('.wiki-weather-place').textContent`)).startsWith('Lisbon'))
    // Opened again with a city saved, the editor draws no button of its own; Esc closes it.
    await wjs(`document.querySelector('.wiki-weather').click(); true`)
    check('wikipedia page: the places editor has no Done once a city is saved', (await wjs(`!!document.querySelector('.wiki-places') && !document.querySelector('.wiki-places-head .wiki-back')`)) === true)
    await wjs(`document.querySelector('.wiki-place-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
    check('wikipedia page: Esc closes the places editor', (await wjs(`!document.querySelector('.wiki-places')`)) === true)
    await sleep(200)
    const wikiStore = JSON.parse(await readFile(join(userData, 'tile-data', 'wikipedia', 'store.json'), 'utf8')) as { places?: { name: string }[] }
    check('wikipedia page: the place is kept in workshop.storage', wikiStore.places?.[0]?.name === 'Lisbon', JSON.stringify(wikiStore))
    await waitFor('the picture of the day', async () => (await wjs(`!!document.querySelector('.wiki-text .wiki-caption')`)) === true)
    const show = await post(door.port, '/tile/wikipedia', { op: 'show', args: ['Red fox'] }, auth)
    check('wikipedia door: show opens the article in the tile', (await wjs(`document.querySelector('.wiki-article .wiki-title')?.textContent ?? ''`)).includes('Red fox'))
    const found = await post(door.port, '/tile/wikipedia', { op: 'search', args: ['red', 'fox'] }, auth)
    check('wikipedia door: search', found.status === 200 && Array.isArray(found.json.result) && found.json.result.length > 0, JSON.stringify(found.json).slice(0, 200))
    const imgs = (await wiki.executeJavaScript(`new Promise((res) => setTimeout(() => res([...document.images].map((i) => i.complete && i.naturalWidth > 0)), 3000))`)) as boolean[]
    check('wikipedia page: images load', imgs.length > 0 && imgs.every(Boolean), JSON.stringify(imgs))
    check('wikipedia door: show', show.status === 200 && typeof show.json.result?.title === 'string', JSON.stringify(show.json))
    const today = await post(door.port, '/tile/wikipedia', { op: 'today' }, auth)
    check('wikipedia door: today', today.status === 200 && typeof today.json.result?.title === 'string' && (await wjs(`document.body.classList.contains('wiki-picture')`)) === true, JSON.stringify(today.json).slice(0, 200))

    await overlays(check, ctx)
    await devTiles(check, liveByTile, door.port, addDevTile)
    if (process.env.WORKSHOP_REAL_CLAUDE) {
      await realClaude(check, ctx)
      return finish(results, ctx)
    }
    await sessions(check, ctx)
    await files(check, ctx)
    await themes(check, ctx)
    await mascot(check, ctx)
    await projects(check, ctx)
    await sideDoors(check, ctx)
    await instances(check, ctx)
    await installs(check, ctx)
    await backendSmoke(check, ctx)
    await gitSmoke(check, ctx)
    await worktreesSmoke(check, ctx)
    await historySmoke(check, ctx)
    await musicSmoke(check, ctx)
    await knotClock(check, ctx)
    await recorderSmoke(check, ctx)
    // Last: it stops this core's sessions.
    await restart(check, ctx)
  } catch (err) {
    check('smoke ran to the end', false, (err as Error).message)
  }
  return finish(results, ctx)
}

async function finish(results: [string, boolean, string?][], { win }: Ctx): Promise<number> {
  // WORKSHOP_SHOT=<file.png>: a picture of the window as the smoke left it, to eyeball the layout.
  if (process.env.WORKSHOP_SHOT) {
    await sleep(1500)
    await writeFile(process.env.WORKSHOP_SHOT, (await win.webContents.capturePage()).toPNG())
  }
  let failed = 0
  for (const [name, ok, detail] of results) {
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  return failed ? 1 : 0
}

const DEV_MANIFEST = (id: string, entry: string): string => JSON.stringify({ id, name: id, version: '0.0.1', workshop: '^1', author: 'smoke', entry })

/** `workshop tile dev`: a folder that reloads when its page changes, and a page from a dev server. */
async function devTiles(
  check: (name: string, ok: boolean, detail?: string) => void,
  liveByTile: Ctx['liveByTile'],
  doorPort: number,
  addDevTile: Ctx['addDevTile']
): Promise<void> {
  const page = (v: number): string => `<!doctype html><script>window.v = ${v}</script>`
  const folder = await mkdtemp(join(tmpdir(), 'ws-devtile-'))
  await mkdir(join(folder, 'dist'))
  await writeFile(join(folder, 'tile.json'), DEV_MANIFEST('live-edit', 'dist/index.html'))
  await writeFile(join(folder, 'dist', 'index.html'), page(1))
  await addDevTile(folder)
  const v = async (): Promise<unknown> => liveByTile.get('live-edit')?.wc.executeJavaScript('window.v').catch(() => null)
  await waitFor('the dev tile to load', async () => (await v()) === 1)
  await writeFile(join(folder, 'dist', 'index.html'), page(2))
  let reloaded = true
  await waitFor('the dev tile to reload', async () => (await v()) === 2, 5000).catch(() => (reloaded = false))
  check('dev tile: a changed page reloads', reloaded)

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(req.url === '/index.html' ? '<!doctype html><script>window.devReady = true</script>' : 'ok')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const dev = await mkdtemp(join(tmpdir(), 'ws-devserver-'))
    await writeFile(join(dev, 'tile.json'), DEV_MANIFEST('dev-server', `http://127.0.0.1:${port}/index.html`))
    await addDevTile(dev)
    await waitFor('the dev-server tile to load', async () => (await liveByTile.get('dev-server')?.wc.executeJavaScript('window.devReady === true').catch(() => false)) === true)
    const wc = liveByTile.get('dev-server')!.wc
    const r = (await wc.executeJavaScript(`(async () => {
      const fails = async (p) => { try { const res = await p; return !res || res.ok === false } catch { return true } }
      return {
        bridge: window.workshop?.id === 'dev-server',
        ownServer: await fetch('/other').then((x) => x.ok).catch(() => false),
        noDoor: await fails(fetch('http://127.0.0.1:${doorPort}/tile/probe', { method: 'POST' })),
        noOtherHost: await fails(fetch('https://en.wikipedia.org/'))
      }
    })()`)) as Record<string, boolean>
    for (const [k, ok] of Object.entries(r)) check(`dev-server tile: ${k}`, ok === true)

    // A dev-server entry from anywhere but `workshop tile dev` is refused.
    const { checkManifest } = await import('@shared/manifest')
    check('dev-server entry refused outside dev', !checkManifest(JSON.parse(DEV_MANIFEST('x', `http://127.0.0.1:${port}/`))).ok)
  } finally {
    server.close()
  }
}

/**
 * The overlay view: the Wikipedia tile's picture over the whole window. It opens only on a real
 * click in the page (input core saw, not a script), under core's strip; Esc from inside the page
 * closes it without the page seeing the key; the strip's × and closeOverlay close it too; and a
 * tile without the permission is refused by main even when core's window asks.
 */
async function overlays(check: (name: string, ok: boolean, detail?: string) => void, { win, liveByTile }: Ctx): Promise<void> {
  const wiki = liveByTile.get('wikipedia')!.wc
  const wjs = (code: string, gesture = false): Promise<any> => wiki.executeJavaScript(code, gesture)
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const isOpen = async (): Promise<boolean> => (await js(`!!document.querySelector('.overlay-strip')`)) === true
  const closed = (what: string) => waitFor(what, async () => !(await isOpen()) && (await wjs('workshop.view')) === 'tile', 3000).then(() => true, () => false)
  /** A real click in the middle of the picture, through Chromium's input pipeline as a mouse would. */
  const click = async (): Promise<void> => {
    const [w, h] = (await wjs('[innerWidth, innerHeight]')) as number[]
    const at = { x: Math.round(w / 2), y: Math.round(h * 0.45) }
    wiki.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    wiki.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  }
  await waitFor('the picture to be up', async () => (await wjs(`document.body.classList.contains('wiki-picture') && !!document.querySelector('.wiki-text .wiki-caption')`)) === true)

  const bare = (await wjs(`workshop.openOverlay().then(() => 'opened', (e) => e.message)`)) as string
  check('overlay: refused without a click in the page', /click or key/.test(bare), bare)
  await wjs(`document.body.click(); true`, true)
  await sleep(500)
  check('overlay: a click made by a script does not count', !(await isOpen()))

  await click()
  const opened = await waitFor('the overlay to open', async () => (await isOpen()) && (await wjs('workshop.view')) === 'overlay', 3000).then(() => true, () => false)
  check('overlay: a real click on the picture opens it, and the page hears view = overlay', opened)
  await sleep(300)
  const cover = (await js(`(() => {
    const r = document.querySelector('.tile-page.over')?.getBoundingClientRect()
    const s = document.querySelector('.overlay-strip')?.getBoundingClientRect()
    return r && s ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, strip: s.bottom, w: innerWidth, h: innerHeight, name: document.querySelector('.overlay-strip .name').textContent } : null
  })()`)) as Record<string, number | string> | null
  check(
    'overlay: the page covers the window below core\'s strip',
    !!cover && cover.left === 0 && cover.right === cover.w && cover.bottom === cover.h && cover.top === cover.strip && cover.strip === 88 && cover.name === 'Today',
    JSON.stringify(cover)
  )
  // Nothing core draws comes through it: the middle of every cell is the overlay's page. (Session
  // tiles are checked with the session tiles, which do not exist yet here.)
  const through = (await js(`(() => {
    const over = document.querySelector('.tile-page.over')
    const seen = [...document.querySelectorAll('.tile')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.top + r.height / 2 > 88 && r.top + r.height / 2 < innerHeight)
    return { seen: seen.length, through: seen.filter((r) => !over.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).length }
  })()`)) as { seen: number; through: number }
  check('overlay: no cell of either column shows through it', through.seen > 0 && through.through === 0, JSON.stringify(through))
  await waitFor('the large picture', async () => (await wjs(`(() => { const i = document.querySelector('.wikibox-img'); return !!i && i.complete && i.naturalWidth > 0 })()`)) === true, 15_000).catch(() => undefined)
  const big = (await wjs(`(() => {
    const i = document.querySelector('.wikibox-img'), r = i?.getBoundingClientRect()
    return { loaded: !!i && i.complete && i.naturalWidth > 0, wide: r ? r.width / innerWidth : 0, fit: i ? getComputedStyle(i).objectFit : '', title: document.querySelector('.wikibox-title')?.textContent ?? '', tag: document.querySelector('.wikibox-tag')?.textContent ?? '', commons: !!document.querySelector('.wikibox-link'), face: getComputedStyle(document.getElementById('main')).display }
  })()`)) as { loaded: boolean; wide: number; fit: string; title: string; tag: string; commons: boolean; face: string }
  check('overlay: the Wikipedia page shows the picture large and whole, with its caption', big.loaded && big.wide > 0.6 && big.fit === 'contain' && !!big.title && big.tag.startsWith('picture of the day') && big.commons && big.face === 'none', JSON.stringify(big))
  if (process.env.WORKSHOP_SHOT_OVERLAY) {
    await sleep(800)
    await writeFile(process.env.WORKSHOP_SHOT_OVERLAY, (await win.webContents.capturePage()).toPNG())
  }

  // Esc from inside the page: main takes it before the page does, so a page cannot swallow it.
  await wjs(`window.sawEsc = false; addEventListener('keydown', (e) => { if (e.key === 'Escape') window.sawEsc = true }, true); true`)
  wiki.focus()
  wiki.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  wiki.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  check('overlay: Esc from inside the page closes it', await closed('Esc to close the overlay'))
  check('overlay: the page never sees that Esc', (await wjs('window.sawEsc')) === false)
  const again = (await wjs(`workshop.openOverlay().then(() => 'opened', (e) => e.message)`)) as string
  check('overlay: the click that opened it cannot open it again', /click or key/.test(again), again)

  await click()
  await waitFor('the overlay again', isOpen, 3000).catch(() => undefined)
  await js(`document.querySelector('.overlay-close').click(); true`)
  check('overlay: the × on core\'s strip closes it', await closed('the strip to close the overlay'))
  await click()
  await waitFor('the overlay again', isOpen, 3000).catch(() => undefined)
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  check('overlay: Esc with the focus in core\'s window closes it', await closed('Esc in core to close the overlay'))
  await click()
  await waitFor('the overlay again', isOpen, 3000).catch(() => undefined)
  await wjs(`document.querySelector('.wikibox-scrim').click(); true`)
  check('overlay: a click outside the picture closes it (closeOverlay)', await closed('the page to close its overlay'))

  // Core's window asking to lay the probe (no "overlay" in its manifest) over the window: main refuses.
  await js(`window.core.setView('probe', 'overlay')`)
  await sleep(200)
  const probeView = (await liveByTile.get('probe')!.wc.executeJavaScript('workshop.view')) as string
  check('overlay: main refuses the view for a tile without the permission', probeView !== 'overlay', probeView)
}

/** `multiple`: a second probe, its own page and web storage, the same workshop.storage, and the door. */
async function instances(check: (name: string, ok: boolean, detail?: string) => void, { win, door, liveByTile, userData }: Ctx): Promise<void> {
  const js = (key: string, code: string): Promise<unknown> => liveByTile.get(key)!.wc.executeJavaScript(code)
  await js('probe', `localStorage.setItem('mine', 'first'); true`)
  // Open a second probe the way the column's + does, then reload the window (every page remounts).
  // The column's state is core's (settings.json), so the window's own storage is wiped first: the
  // second probe must come back from settings alone.
  await win.webContents.executeJavaScript(`(async () => { const c = await window.core.column(); await window.core.setColumn({ ...c, extra: ['probe.2'], spans: { ...c.spans, probe: 2 } }); return true })()`)
  await win.webContents.session.clearStorageData({ storages: ['localstorage'] })
  win.webContents.reload()
  await waitFor('the second probe', async () => !!liveByTile.get('probe.2') && (await js('probe.2', 'window.probeReady === true').catch(() => false)) === true)
  await waitFor('the first probe again', async () => !!liveByTile.get('probe')?.ops.has('echo'))
  check('column: extra instances and heights come back from core\'s settings with the window\'s storage cleared', !!liveByTile.get('probe.2'))
  await waitFor('the probe to be drawn', async () => (await win.webContents.executeJavaScript(`!!document.querySelector('[data-face="probe"]')`)) === true, 3000).catch(() => undefined)
  check('column: a height set with ↕ is kept', (await win.webContents.executeJavaScript(`document.querySelector('[data-face="probe"]').closest('.tile').style.getPropertyValue('--span')`)) === '2')
  // ↕ and × in the column write through to settings.json; two rows is the most, so ↕ goes back to one.
  await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('[data-face="probe"]').closest('.tile'); [...t.querySelectorAll('.head .ghost')].find((b) => b.textContent.includes('↕')).click(); return true })()`)
  await waitFor('the height to be saved', async () => JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).column?.spans?.probe === 1, 3000).catch(() => undefined)
  const savedColumn = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).column
  check('column: ↕ is saved in settings.json, not the window\'s storage', savedColumn?.spans?.probe === 1 && savedColumn?.extra?.includes('probe.2') && (await win.webContents.executeJavaScript(`localStorage.getItem('workshop.span')`)) === null, JSON.stringify(savedColumn))
  check('instances: the second page knows it is probe.2', (await js('probe.2', 'workshop.instance')) === 'probe.2')
  check('instances: web storage is per instance', (await js('probe.2', `localStorage.getItem('mine')`)) === null)
  check('instances: workshop.storage is per tile', JSON.stringify(await js('probe.2', `workshop.storage.get('k')`)) === '{"a":1,"list":[1,2]}')

  const auth = { Authorization: `Bearer ${door.token}` }
  for (const key of ['probe.2', 'probe']) {
    liveByTile.get(key)!.usedAt = Date.now() + (key === 'probe.2' ? 10_000 : 20_000)
    const r = await post(door.port, '/tile/probe', { op: 'echo' }, auth)
    check(`instances: the door goes to the instance used last (${key})`, r.json.result?.instance === key, JSON.stringify(r.json))
  }

  // A webview for an instance of a tile without `multiple` is refused.
  await win.webContents.executeJavaScript(`(() => {
    for (const p of ['persist:tile-wikipedia.2']) {
      const w = document.createElement('webview'); w.setAttribute('partition', p)
      w.setAttribute('src', p.includes('wikipedia') ? 'tile://wikipedia/index.html' : 'tile://probe/index.html'); document.body.append(w)
    }
    return true
  })()`)
  await sleep(1500)
  check('instances: no second instance of a tile without multiple', !liveByTile.has('wikipedia.2'))
}

/** `files`: what the user picked is readable, streamed, by that tile only; nothing outside it is. */
async function files(check: (name: string, ok: boolean, detail?: string) => void, { liveByTile }: Ctx): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ws-files-')))
  await mkdir(join(base, 'games', 'gb'), { recursive: true })
  await writeFile(join(base, 'games', 'gb', 'a.gb'), 'rom bytes')
  await writeFile(join(base, 'games', 'big.bin'), Buffer.alloc(32 * 1024 * 1024, 7))
  await writeFile(join(base, 'secret.txt'), 'secret')
  await symlink(join(base, 'secret.txt'), join(base, 'games', 'escape.txt'))
  process.env.WORKSHOP_SMOKE_PICK = join(base, 'games')

  const r = (await liveByTile.get('probe')!.wc.executeJavaScript(`(async () => {
    const fails = async (p) => { try { const res = await p; return !res || res.ok === false } catch { return true } }
    const g = await workshop.files.pick({ title: 'games' })
    const listed = await workshop.files.entries(g.handle, '')
    const big = await workshop.files.read(g.handle, 'big.bin')
    return {
      picked: g.name === 'games' && g.kind === 'folder' && !('path' in g),
      listed: JSON.stringify(listed.map((e) => e.name)) === '["gb","big.bin"]',
      readText: (await workshop.files.read(g.handle, 'gb/a.gb', 'text')) === 'rom bytes',
      viaUrl: await fetch(workshop.files.url(g.handle, 'gb/a.gb')).then((x) => x.text()).then((t) => t === 'rom bytes'),
      bigStreamed: big.byteLength === 32 * 1024 * 1024,
      noDotDot: await fails(fetch('tile://probe/~files/' + g.handle + '/%2e%2e/secret.txt')),
      noSymlinkOut: await fails(fetch(workshop.files.url(g.handle, 'escape.txt'))),
      noBadHandle: await fails(fetch('tile://probe/~files/000000000000/gb/a.gb')),
      remembered: (await workshop.files.list()).some((x) => x.handle === g.handle),
      handle: g.handle
    }
  })()`)) as Record<string, unknown>
  const handle = String(r.handle)
  delete r.handle
  for (const [k, ok] of Object.entries(r)) check(`files: ${k}`, ok === true, String(ok))

  const w = (await liveByTile.get('wikipedia')!.wc.executeJavaScript(`(async () => ({
    noBridge: await workshop.files.pick().then(() => false, () => true),
    noOtherTilesGrant: await fetch('tile://wikipedia/~files/${handle}/gb/a.gb').then((x) => !x.ok, () => true)
  }))()`)) as Record<string, boolean>
  for (const [k, ok] of Object.entries(w)) check(`files, tile without the permission: ${k}`, ok === true)
}

/** The theme picker's choice reaches every tile at once, is saved, and Deep Space puts up its sky. */
async function themes(check: (name: string, ok: boolean, detail?: string) => void, { win, liveByTile, userData }: Ctx): Promise<void> {
  const panel = (): Promise<unknown> => liveByTile.get('probe')!.wc.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--ws-panel').trim()`)
  await liveByTile.get('probe')!.wc.executeJavaScript(`window.themeSeen = null; workshop.theme.onChange((v) => { window.themeSeen = v['--ws-panel'] }); true`)
  check('themes: Deep Space is the default, with its sky', (await win.webContents.executeJavaScript(`!!document.querySelector('.cosmos-wall') && document.documentElement.dataset.wall === 'true'`)) === true)
  await win.webContents.executeJavaScript(`window.core.setSettings({ theme: 'gruvbox', appearance: 'light' }).then(() => true)`)
  await sleep(200)
  check('themes: a tile is repainted', (await panel()) === '#fbf1c7', String(await panel()))
  check('themes: a tile follows light and dark', (await liveByTile.get('probe')!.wc.executeJavaScript(`document.documentElement.style.colorScheme`)) === 'light')
  check('themes: a tile hears onChange', (await liveByTile.get('probe')!.wc.executeJavaScript('window.themeSeen')) === '#fbf1c7')
  check('themes: workshop.theme.vars is live', (await liveByTile.get('probe')!.wc.executeJavaScript(`workshop.theme.vars['--ws-panel']`)) === '#fbf1c7')
  check('themes: the sky comes down', (await win.webContents.executeJavaScript(`!document.querySelector('.cosmos-wall')`)) === true)
  const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as Record<string, string>
  check('themes: saved', saved.theme === 'gruvbox' && saved.appearance === 'light')
  await win.webContents.executeJavaScript(`window.core.setSettings({ theme: 'no-such-theme' }).then(() => true)`)
  check('themes: an unknown theme is ignored', (await panel()) === '#fbf1c7')
  await win.webContents.executeJavaScript(`window.core.setSettings({ theme: 'cosmos', appearance: 'system' }).then(() => true)`)
  await sleep(200)
  check('themes: back to Deep Space', (await win.webContents.executeJavaScript(`!!document.querySelector('.cosmos-wall')`)) === true)
  const bridged = (await liveByTile.get('probe')!.wc.executeJavaScript(`typeof window.core`)) as string
  check('themes: a tile cannot reach core\'s settings', bridged === 'undefined')
}

/**
 * Sessions, with the stand-in CLI (test/fixtures/fake-claude): started in tmux with our settings,
 * hooks and the status line reaching core with the session's own token, the door attributing a
 * call to the session, tiles seeing sessions and usage as their permissions allow, park / resume / kill.
 */
/**
 * Session tiles: the conversation, tailed by main from the transcript the stand-in writes the way
 * the CLI does, drawn in the column (prompts, markdown prose, tool lines; nothing meta or from a
 * subagent), the terminal only in the center, and parked
 * sessions at the foot. `id` is a session that has had one turn ("hello") and is focused.
 */
async function sessionTiles(check: (name: string, ok: boolean, detail?: string) => void, { win, core, userData }: Ctx, id: string): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const tile = `document.querySelector('.session-tile[data-session="${id}"]')`
  const terminals = (): Promise<number> => js(`document.querySelectorAll('.term-host .xterm').length`)

  await waitFor('main to find the transcript', () => !!core.transcripts.pathOf(id), 5000).catch(() => undefined)
  const path = core.transcripts.pathOf(id) ?? ''
  check('session tiles: main finds the transcript by session id under the CLI\'s config folder', path.startsWith(join(userData, 'claude-config', 'projects')) && path.endsWith('.jsonl'), path)

  // While its terminal is in the center, the focused session leaves the column (as in deck).
  check('session tiles: the focused session gives its tile way to the terminal', (await js(`!${tile} && !document.querySelector('.sessions [data-session="${id}"]') && !!document.querySelector('.focus-pane[data-session="${id}"]')`)) === true && (await terminals()) === 1)

  // The launcher takes the center: the session becomes a tile, and no terminal is mounted at all.
  await js(`document.querySelector('.session-plus').click(); true`)
  await waitFor('the session tile', async () => (await js(`!!${tile}?.querySelector('.chat-text')`)) === true, 5000).catch(() => undefined)
  const seen = (await js(`(() => {
    const t = ${tile}
    if (!t) return null
    const font = (sel) => getComputedStyle(t.querySelector(sel)).fontFamily
    return {
      user: t.querySelector('.chat-user')?.textContent,
      bold: t.querySelector('.chat-text strong')?.textContent,
      list: t.querySelectorAll('.chat-text li').length,
      tool: t.querySelector('.chat-tool')?.textContent,
      done: t.querySelector('.chat-tool')?.className,
      title: t.querySelector('.subname')?.textContent,
      // The status mark: the Knot, a sprite, or the dot where no canvas can be had.
      dot: !!t.querySelector('.head > canvas.knot, .head > .sprite, .head > span.dot'),
      badges: [...t.querySelectorAll('.head .badge')].map((b) => b.textContent).join(' '),
      text: t.innerText,
      prose: font('.chat-text'), prompt: font('.chat-user'), toolFont: font('.chat-tool')
    }
  })()`)) as Record<string, any> | null
  check('session tiles: the prompt, the prose as markdown and the tool call are drawn', !!seen && seen.user === 'hello' && seen.bold === 'hello' && seen.list === 2 && /Read\s*README\.md/.test(seen.tool) && seen.tool.includes('✓') && seen.done.includes('is-done'), JSON.stringify(seen))
  check('session tiles: nothing meta or from a subagent is shown', !!seen && !seen.text.includes('NOT SHOWN'), seen?.text)
  check('session tiles: Claude\'s title, the status mark, model, context and cost on the head', !!seen && seen.title === 'Smoke conversation' && seen.dot && seen.badges.includes('Sonnet') && seen.badges.includes('ctx 17%') && seen.badges.includes('$1.23'), JSON.stringify(seen))
  check('session tiles: prose in the reading face, prompts and tools in the interface and mono faces', !!seen && seen.prose.includes('Source Serif 4') && seen.prompt.includes('Nunito') && seen.toolFont.includes('JetBrains Mono'), JSON.stringify(seen && [seen.prose, seen.prompt, seen.toolFont]))
  check('session tiles: no terminal mounted while no session is in the center', (await terminals()) === 0)
  // A tile page over the window (the overlay's class and box, set and undone in one task, so
  // nothing repaints in between) covers a session tile: a tile's insides once had a z-index of
  // their own and came through the Wikipedia lightbox.
  const under = (await js(`(() => {
    const chat = ${tile}?.querySelector('.chat'), page = document.querySelector('.tile-page')
    if (!chat || !page) return { chat: !!chat, page: !!page }
    const r = chat.getBoundingClientRect(), was = page.getAttribute('style')
    page.classList.add('over')
    Object.assign(page.style, { visibility: 'visible', left: '0px', top: '88px', width: innerWidth + 'px', height: (innerHeight - 88) + 'px' })
    const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 8)
    page.classList.remove('over')
    page.setAttribute('style', was)
    return { chat: true, page: true, covered: page.contains(hit), hit: hit?.className }
  })()`)) as { chat: boolean; page: boolean; covered?: boolean; hit?: string }
  check('session tiles: the overlay covers a session tile', under.covered === true, JSON.stringify(under))
  // WORKSHOP_SHOT_TILES=<file.png>: the window with the session as a tile and the launcher in the center.
  if (process.env.WORKSHOP_SHOT_TILES) {
    await sleep(800)
    await writeFile(process.env.WORKSHOP_SHOT_TILES, (await win.webContents.capturePage()).toPNG())
  }

  // A click on the tile opens its terminal in the center, and the tile gives way again.
  await js(`${tile}.querySelector('.chat').click(); true`)
  await waitFor('the terminal in the center', async () => (await terminals()) === 1, 3000).catch(() => undefined)
  check('session tiles: a click opens the session\'s terminal in the center', (await terminals()) === 1 && (await js(`!${tile}`)) === true)

  // The overlay covers the terminal too, xterm's own positioned layers included (helpers at 5, link
  // decorations at 6–8): they once came through the Wikipedia lightbox, because the tile pages'
  // layer was a stacking context of its own at level 0. Set and undone in one task, as above.
  const overTerm = (await js(`(() => {
    const app = document.querySelector('.app'), page = document.querySelector('.tile-page')
    const parts = [...document.querySelectorAll('.term-host .xterm, .term-host .xterm *')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.top + r.height / 2 > 88)
    if (!app || !page || !parts.length) return { page: !!page, parts: parts.length }
    const was = page.getAttribute('style')
    app.classList.add('overlaid'); page.classList.add('over')
    Object.assign(page.style, { visibility: 'visible', left: '0px', top: '88px', width: innerWidth + 'px', height: (innerHeight - 88) + 'px' })
    const through = parts.filter((r) => !page.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).length
    app.classList.remove('overlaid'); page.classList.remove('over')
    page.setAttribute('style', was)
    return { page: true, parts: parts.length, through }
  })()`)) as { page: boolean; parts: number; through?: number }
  check('session tiles: the overlay covers the terminal in the center, xterm\'s layers and all', overTerm.parts > 0 && overTerm.through === 0, JSON.stringify(overTerm))
}

/**
 * ⌘1–9, ⌘[ ⌘], ⌘N from wherever the focus is: core's window, a terminal, inside a tile's webview
 * (whose key events never reach core's window, so main catches them; the page must not see them).
 * `first` is a session that is open and focused; a second one is started and ended here.
 */
async function shortcuts(check: (name: string, ok: boolean, detail?: string) => void, { win, core, liveByTile }: Ctx, first: string, cwd: string): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const focus = (): string | null => core.sessions.getState().focus
  const press = (wc: WebContents, keyCode: string): void => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] })
  }
  const lands = (what: string, id: string): Promise<boolean> => waitFor(what, () => focus() === id, 3000).then(() => true, () => false)
  const launcher = (): Promise<boolean> => js(`!!document.querySelector('.launcher')`)

  const two = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'smoke-two' })`)).id)
  await waitFor('the second session', async () => ((await core.tmux.screen(`ws-${two}`))?.text ?? '').includes('FAKE CLAUDE READY'))
  check('shortcuts: each session tile wears its ⌘ number, in the order they were started', (await js(`document.querySelector('.session-tile[data-session="${first}"] .key')?.textContent`)) === '⌘1')

  win.webContents.focus()
  press(win.webContents, '1')
  check('shortcuts: ⌘1 in core\'s window focuses the first session', await lands('⌘1', first))

  const probe = liveByTile.get('probe')!.wc
  await probe.executeJavaScript(`window.metaKeys = 0; addEventListener('keydown', (e) => { if (e.metaKey) window.metaKeys++ }, true); true`)
  probe.focus()
  press(probe, '2')
  check('shortcuts: ⌘2 inside a tile\'s page focuses the second session', await lands('⌘2 from a tile', two))
  press(probe, '[')
  check('shortcuts: ⌘[ inside a tile\'s page steps back', await lands('⌘[ from a tile', first))
  press(probe, 'N')
  check('shortcuts: ⌘N inside a tile\'s page opens the launcher', await waitFor('the launcher', launcher, 3000).then(() => true, () => false))
  check('shortcuts: the tile\'s page never sees them', (await probe.executeJavaScript('window.metaKeys')) === 0)

  // From inside the terminal: xterm has the keyboard, main still takes the key first.
  press(win.webContents, '1')
  await waitFor('the terminal', async () => (await js(`document.querySelectorAll('.term-host .xterm').length`)) === 1, 3000).catch(() => undefined)
  check('shortcuts: ⌘1 takes the center back from the launcher', !(await launcher()) && focus() === first)
  await js(`document.querySelector('.term-host .xterm-helper-textarea')?.focus(); true`)
  win.webContents.focus()
  press(win.webContents, ']')
  check('shortcuts: ⌘] with the focus in a terminal steps on', await lands('⌘] from a terminal', two))
  press(win.webContents, ']')
  check('shortcuts: ⌘] wraps around', await lands('⌘] wrapping', first))
  press(win.webContents, '9')
  await sleep(300)
  check('shortcuts: a number with no session does nothing', focus() === first)

  await js(`window.core.kill(${JSON.stringify(two)})`)
  await waitFor('the second session to end', () => !core.sessions.getState().sessions.some((s) => s.id === two), 3000).catch(() => undefined)
  await js(`window.core.focusSession(${JSON.stringify(first)})`)
}

async function sessions(check: (name: string, ok: boolean, detail?: string) => void, ctx: Ctx): Promise<void> {
  const { win, door, liveByTile, userData, core } = ctx
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const state = () => core.sessions.getState()
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-project-')))

  // A fresh profile: no window reported yet, and the meters are there anyway, empty, saying why.
  const meters = (await js(`[...document.querySelectorAll('.topbar .meter')].map((m) => [m.className, m.textContent, m.title])`)) as string[][]
  check('usage: both meters show before anything is known, empty, with why', meters.length === 2 && meters.every(([c, t, title]) => c.includes('unknown') && t.includes('—') && /first reply/.test(title)), JSON.stringify(meters))

  const made = await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'smoke-one', model: 'sonnet', permissionMode: 'plan' })`)
  const id = String(made.id)
  await waitFor('the session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))
  const started = JSON.parse(await readFile(join(userData, `fake-${id}.json`), 'utf8')) as { args: string[]; auth: string; session: string }
  const a = started.args
  check('sessions: the CLI gets our settings, its id, model and mode', a.includes('--settings') && a.includes('--session-id') && a.join(' ').includes('--model sonnet') && a.join(' ').includes('--permission-mode plan') && a.join(' ').includes('--name smoke-one'), a.join(' '))
  check('sessions: each tile plugin is handed over', a.some((x) => x.endsWith('tiles/wikipedia/plugin')), a.join(' '))
  check('sessions: no token on the command line', !a.some((x) => /[0-9a-f]{48}/.test(x)))
  const authMode = (await stat(started.auth)).mode & 0o777
  check('sessions: the auth file is private', authMode === 0o600, authMode.toString(8))
  check('sessions: state lists it, open and focused', state().focus === id && state().sessions[0]?.open === true && state().sessions[0]?.cwd === cwd)

  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'hello\\r'); true`)
  await waitFor('the first turn', async () => (await screen(id)).includes('DONE hello'))
  await sleep(300)
  const v = state().sessions.find((s) => s.id === id)!
  check('sessions: hooks arrive (turn ended: idle, needs you)', v.status === 'idle' && v.attention === true, `${v.status} ${v.attention}`)
  const u = core.usage.get()
  check('sessions: the status line reaches usage', u.fiveHour?.pct === 42 && u.sessions[id]?.costUsd === 1.23 && u.sessions[id]?.context === 17, JSON.stringify(u))
  check('sessions: the window hears usage', (await js(`window.core.usage().then((u) => u.fiveHour && u.fiveHour.pct)`)) === 42)
  await waitFor('the meter to fill', async () => (await js(`document.querySelector('.topbar .meter')?.textContent ?? ''`)).includes('42%'), 3000).catch(() => undefined)
  check('usage: the 5-hour meter fills once a session reports', String(await js(`document.querySelector('.topbar .meter').textContent`)).includes('42%'))
  const badges = (await js(`[...document.querySelectorAll('.pane .head .badge')].map((b) => b.textContent).join(' ')`)) as string
  check('usage: the session shows its context and cost', badges.includes('ctx 17%') && badges.includes('$1.23'), badges)
  await sessionTiles(check, ctx, id)
  await shortcuts(check, ctx, id, cwd)
  await previewSmoke(check, ctx, id, cwd)
  await reorderSmoke(check, ctx, id, cwd)
  await uiSmoke(check, ctx, id, cwd)
  await wheelSmoke(check, ctx)

  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'door\\r'); true`)
  await waitFor('the door call from the session', async () => (await screen(id)).includes('DONE door'))
  const scr = await screen(id)
  check('sessions: a door call from a session carries its name', scr.includes('"caller": "smoke-one"') || scr.includes('"caller":"smoke-one"'), scr.slice(-400))
  check('sessions: and its id, which a name cannot stand in for', scr.replace(/\s+/g, '').includes(`"session":"${id}"`), scr.slice(-400))

  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'spoof\\r'); true`)
  await waitFor('the spoof turn', async () => (await screen(id)).includes('DONE spoof'))
  await sleep(300)
  check('sessions: a hook claiming another session is ignored', state().sessions.find((s) => s.id === id)!.status === 'busy')

  // Tiles: the probe has "sessions": "write" and "usage"; Wikipedia has neither.
  const probe = liveByTile.get('probe')!.wc
  const list = (await probe.executeJavaScript(`workshop.sessions.list()`)) as { id: string; name: string; project: string; focused: boolean }[]
  check('tiles: sessions.list', list.some((s) => s.id === id && s.name === 'smoke-one' && s.project === cwd && s.focused), JSON.stringify(list))
  check('tiles: no titles or tokens in the list', !JSON.stringify(list).includes('title') && !/[0-9a-f]{48}/.test(JSON.stringify(list)))
  check('tiles: usage.get', (await probe.executeJavaScript(`workshop.usage.get().then((u) => u.fiveHour.pct)`)) === 42)
  await probe.executeJavaScript(`workshop.sessions.paste(${JSON.stringify(id)}, 'pasted by a tile')`)
  await waitFor('the pasted turn', async () => (await screen(id)).includes('DONE pasted by a tile'))
  check('tiles: sessions.paste types into the session', true)
  const wiki = liveByTile.get('wikipedia')!.wc
  const refused = (await wiki.executeJavaScript(`Promise.all([workshop.sessions.list().then(() => false, () => true), workshop.usage.get().then(() => false, () => true)])`)) as boolean[]
  check('tiles: no sessions or usage without the permission', refused.every(Boolean))

  // The Reminders tile: storage, sessions and the door at once. A session adds a reminder with no
  // project named; the tile finds the session's folder from the call's session id.
  await waitFor('the reminders tile to answer its door', () => !!liveByTile.get('reminders')?.ops.has('add'))
  const rem = (code: string): Promise<any> => liveByTile.get('reminders')!.wc.executeJavaScript(code)
  const outside = (op: string, ...args: string[]) => post(door.port, '/tile/reminders', { op, args }, { Authorization: `Bearer ${door.token}` })
  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'tile reminders add "Rotate the test key" --priority high --due tomorrow\\r'); true`)
  await waitFor('the reminder from the session', async () => (await screen(id)).includes('DONE tile reminders add'))
  const headOf = (sel: string): Promise<string> => js(`document.querySelector('[data-face="reminders"]').closest('.tile').querySelector('${sel}')?.textContent ?? ''`)
  check('reminders: a session adding one notifies', (await headOf('.chip')).includes('smoke-one: Rotate the test key'), await headOf('.head'))
  check('reminders: the open count is on the tile head', (await headOf('.badge')) === '1', await headOf('.head'))
  const all = await outside('list', '--all')
  const mine = (all.json.result?.reminders ?? []).find((r: { text: string }) => r.text === 'Rotate the test key')
  check('reminders: a session adds one, filed under its own folder and name', !!mine && mine.project === cwd && mine.by === 'smoke-one' && mine.priority === 'high' && /^\d{4}-\d\d-\d\d$/.test(mine.due), JSON.stringify(all.json).slice(0, 300))
  const nowhere = await outside('add', 'from nowhere')
  check('reminders: a caller with no session must name the project', nowhere.status === 502 && /which project/.test(nowhere.json.error ?? ''), JSON.stringify(nowhere.json))
  const named = await outside('note', 'The staging DB is a **copy** from Oct 3', '--project', cwd.split('/').pop()!)
  check('reminders: a known project goes by its folder name', named.json.result?.note?.project === cwd && named.json.result?.note?.by === 'outside', JSON.stringify(named.json))
  const badFlag = await outside('add', 'x', '--shout')
  check('reminders: an unknown flag is refused, not swallowed', badFlag.status === 502 && /no --shout/.test(badFlag.json.error ?? ''), JSON.stringify(badFlag.json))
  await waitFor('the page to draw it', async () => (await rem(`document.querySelector('.row .text')?.textContent ?? ''`)).includes('Rotate the test key'))
  check('reminders: the page draws it under its project', (await rem(`document.querySelector('.group h4')?.textContent ?? ''`)).startsWith(cwd.split('/').pop()!))
  await rem(`document.querySelector('.row .check').click(); true`)
  await waitFor('the click to complete it', async () => (await outside('history', '--all')).json.result?.log?.length === 1)
  const hist = await outside('history', '--all')
  check('reminders: ticking it in the tile writes the log line', hist.json.result?.log?.[0]?.text === 'Rotate the test key' && hist.json.result.log[0].by === 'you', JSON.stringify(hist.json))
  const undone = await outside('undo', mine?.id ?? '')
  check('reminders: undo from the door takes the line back', undone.status === 200 && (await outside('history', '--all')).json.result?.log?.length === 0)
  await sleep(200)
  const stored = JSON.parse(await readFile(join(userData, 'tile-data', 'reminders', 'store.json'), 'utf8')) as { state?: { reminders?: unknown[]; notes?: unknown[] } }
  check('reminders: the state is in workshop.storage', stored.state?.reminders?.length === 1 && stored.state?.notes?.length === 1, JSON.stringify(stored).slice(0, 200))
  // The page reloads (a dev tile after an edit, the window after a crash): what it kept comes back,
  // and a call the NEW page takes is not failed by the old page going away (open issue B).
  const oldPage = liveByTile.get('reminders')!.wc
  oldPage.reload()
  await waitFor('the reminders page to come back', async () => (await outside('list', '--all')).status === 200)
  const back = await outside('list', '--all')
  check('reminders: a reloaded page has what it kept', back.json.result?.reminders?.[0]?.text === 'Rotate the test key', JSON.stringify(back.json).slice(0, 200))
  await rem(`document.querySelector('[role=tab]:nth-child(2)').click(); true`)
  await waitFor('the notes tab', async () => (await rem(`document.querySelector('.note-body b')?.textContent ?? ''`)) === 'copy')
  check('reminders: a note is drawn as markdown', true)
  check('reminders: no tab draws a missing piece as the word null', !String(await rem(`document.body.innerText`)).includes('null'))
  check('tiles: core\'s fonts reach a tile through its own origin', (await rem(`document.fonts.load('13px Nunito').then((f) => f.length > 0 && getComputedStyle(document.body).fontFamily.includes('Nunito'))`)) === true)
  await rem(`document.querySelector('[role=tab]').click(); true`)

  // The + at the foot of the tile column: its menu, and "make one with Claude" (a starter tile in a
  // new folder, live at once, and a session in that folder told what to build).
  await js(`document.querySelector('.tiles .tile-plus').click(); true`)
  await waitFor('the + menu', async () => (await js(`!!document.querySelector('.picker')`)) === true)
  await js(`document.querySelector('.picker [data-tab="yours"]').click(); true`)
  await sleep(100)
  check('plus: the menu offers another instance of a tile that allows it', (await js(`!!document.querySelector('.picker [title="Another Probe"]')`)) === true)
  await js(`document.querySelector('.picker .head .ghost').click(); true`)
  await sleep(300)
  check('plus: closing the menu puts the + back and leaves the window standing', (await js(`!!document.querySelector('.app') && !!document.querySelector('.tiles .tile-plus') && !document.querySelector('.picker')`)) === true)
  const newTile = (await js(`window.core.createTile('Smoke Timer', 'Count down 25 minutes')`)) as { id: string; folder: string }
  await waitFor('the new tile to load', () => !!liveByTile.get('smoke-timer'))
  await waitFor('the starter to draw', async () => String(await liveByTile.get('smoke-timer')!.wc.executeJavaScript(`document.body.textContent`).catch(() => '')).includes('Smoke Timer is running'))
  const builder = state().sessions.find((s) => s.name === 'tile: Smoke Timer')
  if (builder) await waitFor('the builder session to start', () => stat(join(userData, `fake-${builder.id}.json`)).then(() => true, () => false)).catch(() => undefined)
  const builderArgs = builder ? (JSON.parse(await readFile(join(userData, `fake-${builder.id}.json`), 'utf8').catch(() => '{"args":[]}')) as { args: string[] }).args : []
  check('plus: make one with Claude starts a session in the new tile’s folder', newTile.id === 'smoke-timer' && !!builder && (await realpath(builder.cwd)) === (await realpath(newTile.folder)), JSON.stringify(newTile))
  check('plus: the session is told what to build and where the contract is', builderArgs.some((a) => a.includes('Count down 25 minutes') && a.includes('CLAUDE.md')), builderArgs.slice(-1).join().slice(0, 200))
  check('plus: the folder carries the tile contract', (await readFile(join(newTile.folder, 'CLAUDE.md'), 'utf8')).includes('window.workshop'))
  await js(`window.core.forgetTile('smoke-timer')`)
  await waitFor('the tile to go', () => !liveByTile.get('smoke-timer'))
  check('plus: a dev tile can be dropped, its folder left alone', await stat(join(newTile.folder, 'tile.json')).then(() => true, () => false))
  if (builder) await js(`window.core.kill(${JSON.stringify(builder.id)})`)
  await js(`window.core.focusSession(${JSON.stringify(id)})`)
  await sleep(200)
  await agentsSmoke(check, ctx, id)
  await transcriptsSmoke(check, ctx, id)

  if (process.env.WORKSHOP_SHOT_SESSION) {
    await sleep(800)
    await writeFile(process.env.WORKSHOP_SHOT_SESSION, (await win.webContents.capturePage()).toPNG())
  }
  await js(`window.core.park(${JSON.stringify(id)})`)
  await waitFor('the session to park', async () => state().sessions.find((s) => s.id === id)?.open === false)
  check('sessions: park keeps tmux', await core.tmux.hasSession(`ws-${id}`))
  await waitFor('the closed card', async () => (await js(`!!document.querySelector('.parked [data-session="${id}"]')`)) === true, 3000).catch(() => undefined)
  check('session tiles: a parked session waits in the Closed card, its tile and terminal gone', (await js(`!!document.querySelector('.parked [data-session="${id}"]') && !document.querySelector('.session-tile[data-session="${id}"]') && document.querySelectorAll('.term-host .xterm').length === 0`)) === true)
  check('session tiles: a parked session is no longer tailed', core.transcripts.get(id) === null)
  await js(`window.core.resume(${JSON.stringify(id)})`)
  await sleep(300)
  check('sessions: resume reattaches', state().sessions.find((s) => s.id === id)?.attached === true && (await screen(id)).includes('DONE pasted by a tile'))
  await js(`window.core.kill(${JSON.stringify(id)})`)
  await sleep(300)
  const gone = await stat(started.auth).then(() => false, () => true)
  check('sessions: kill ends tmux, the record and the token', !(await core.tmux.hasSession(`ws-${id}`)) && !state().sessions.some((s) => s.id === id) && gone)
}

/**
 * WORKSHOP_REAL_CLAUDE=1: one turn of the REAL CLI (Haiku, a few cents), to prove it accepts our
 * settings file and that its hooks and status line reach core. Run in this repo, which must be a
 * folder the CLI already trusts (else it stops at the trust question).
 */
async function realClaude(check: (name: string, ok: boolean, detail?: string) => void, { win, core }: Ctx): Promise<void> {
  const cwd = process.cwd()
  const made = (await win.webContents.executeJavaScript(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, model: 'haiku', name: 'real-smoke', prompt: 'Reply with exactly: OK' })`)) as { id: string }
  const seen = new Set<string>()
  let usage = false
  await waitFor(
    'the real turn to end',
    () => {
      const v = core.sessions.getState().sessions.find((s) => s.id === made.id)
      if (v) seen.add(v.status)
      usage ||= !!core.usage.get().sessions[made.id]
      return !!v && v.status === 'idle' && v.attention && usage
    },
    120_000
  ).catch(() => undefined)
  const v = core.sessions.getState().sessions.find((s) => s.id === made.id)
  const text = (await core.tmux.screen(`ws-${made.id}`))?.text ?? ''
  check('real CLI: the turn ran and its hooks came back (idle, needs you)', !!v && v.status === 'idle' && v.attention, `${[...seen].join(' → ')}`)
  check('real CLI: the status line reached usage', usage, JSON.stringify(core.usage.get()))
  check('real CLI: it answered', /\bOK\b/.test(text), text.slice(-600))
  // The real transcript, found by session id and tailed: the prompt, then the answer as prose.
  await waitFor('the real transcript', () => (core.transcripts.get(made.id)?.blocks ?? []).some((b) => b.kind === 'text' && /\bOK\b/.test(b.text)), 10_000).catch(() => undefined)
  const t = core.transcripts.get(made.id)
  check(
    'real CLI: its transcript is found and tailed (the prompt, then the answer)',
    !!t && t.found && t.blocks[0]?.kind === 'user' && t.blocks[0].text.includes('Reply with exactly') && t.blocks.some((b) => b.kind === 'text' && /\bOK\b/.test(b.text)),
    JSON.stringify(t?.blocks.map((b) => b.kind)) + ' ' + (core.transcripts.pathOf(made.id) ?? 'no file')
  )
  await core.sessions.kill(made.id)
}

/**
 * The status mark (CLAUDE.md §8). With no sprite pack a session shows the Knot, whose mode follows
 * its status; a call for attention (a tile's notify, a turn finishing) flares it. A synthetic sprite pack (plain
 * coloured frames drawn here, never a real sheet) replaces it with a sprite whose pose follows the
 * status and which leaps on a call for attention; removing the pack brings the Knot back.
 *
 * WORKSHOP_SHOT_MASCOT=<folder>: pictures of the heads and the top-left mark in three themes, and
 * of the setup screen. WORKSHOP_SMOKE_SHEET=<png>: a sheet to try in the setup screen and install,
 * for looking at by eye (it stays in the throwaway profile).
 */
async function mascot(check: (name: string, ok: boolean, detail?: string) => void, { win, liveByTile, core }: Ctx): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const shots = process.env.WORKSHOP_SHOT_MASCOT
  const shot = async (name: string): Promise<void> => {
    if (!shots) return
    await sleep(900)
    await mkdir(shots, { recursive: true })
    await writeFile(join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-mascot-')))
  const made = await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'mascot' })`)
  const id = String(made.id)
  // A session is a tile, the center's head while its terminal is there, or a row under Closed.
  const row = `document.querySelector('[data-session="${id}"]')`
  const mark = (sel: string): Promise<string | null> => js(`(() => { const r = ${row}; const m = r?.querySelector('${sel}'); return m ? (m.dataset.mode ?? m.dataset.pose ?? '') : null })()`)
  const modeIs = (want: string) => waitFor(`the knot to read ${want}`, async () => (await mark('canvas.knot')) === want, 5000).then(() => true, () => false)
  const flare = (): Promise<string | undefined> => js(`(${row}).querySelector('canvas.knot').dataset.flare`)
  await waitFor('the session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))

  check('mark: no pack and no dot: the session shows the Knot', (await mark('canvas.knot')) !== null && (await mark('.dot')) === null)
  check('mark: the Knot is drawn', (await js(`(() => { const c = (${row}).querySelector('canvas.knot'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n })()`)) > 20)
  check('mark: the app mark is in the top bar, left', (await js(`(() => { const r = document.querySelector('.app-mark canvas.knot')?.getBoundingClientRect(); return !!r && r.left > 60 && r.left < 140 && r.top < 20 })()`)) === true)

  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'hello\\r'); true`)
  check('mark: a finished turn needs you (needs)', await modeIs('needs'))
  check('mark: and flares once, a call for attention', (await waitFor('a flare', async () => (await flare()) === '1', 2000).then(() => true, () => false)))
  await js(`window.core.ptyInput(${JSON.stringify(id)}, ' '); true`)
  check('mark: looked at, it rests (small, slow)', await modeIs('rest'))
  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'spoof\\r'); true`)
  check('mark: working (full size, fast)', await modeIs('work'))
  check('mark: the app mark works while a session does', (await js(`document.querySelector('.app-mark canvas.knot').dataset.mode`)) === 'work')
  await shot('knot-cosmos')
  for (const [theme, appearance] of [['gruvbox', 'light'], ['nord', 'dark']]) {
    await js(`window.core.setSettings({ theme: '${theme}', appearance: '${appearance}' }).then(() => true)`)
    await shot(`knot-${theme}-${appearance}`)
  }
  await js(`window.core.setSettings({ theme: 'cosmos', appearance: 'system' }).then(() => true)`)

  // A tile's call for attention goes to the session in focus (this one: no live session has called the probe lately).
  await sleep(3200)
  // The contract's old word is gone, not kept as an alias: notify still shows, but nothing flares.
  await js(`(${row}).querySelector('canvas.knot').dataset.flare = ''; true`)
  const old = await liveByTile.get('probe')!.wc.executeJavaScript(`workshop.notify({ text: 'old word', bark: true })`)
  await sleep(1500)
  check('mark: notify({ bark: true }) is only a notification now', old === true && (await flare()) !== '1', `${old} ${await flare()}`)
  await sleep(2000)
  await js(`(${row}).querySelector('canvas.knot').dataset.flare = ''; true`)
  const called = await liveByTile.get('probe')!.wc.executeJavaScript(`workshop.notify({ text: 'attention', attention: true })`)
  const flared = await waitFor('the flare', async () => (await flare()) === '1', 3000).then(() => true, () => false)
  check('mark: notify({ attention: true }) flares the session’s Knot', called === true && flared, String(called))

  // A synthetic pack: 4 × 3 frames of 16 px, a colour per row, drawn on a canvas here.
  const pack = { format: 1, name: 'Blocky', image: 'sheet.png', sheet: { w: 64, h: 48 }, frame: { w: 16, h: 16 }, box: { x: 2, y: 4, w: 12, h: 10 }, states: { run: { row: 0, from: 0, frames: 4, ms: 60 }, leap: { row: 1, from: 0, frames: 3, ms: 80 }, sleep: { row: 2, from: 0, frames: 2, ms: 300 } } }
  const saved = await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48
    const g = c.getContext('2d')
    ;['#e0663a', '#3a9be0', '#7a7a7a'].forEach((col, r) => { g.fillStyle = col; for (let i = 0; i < 4; i++) g.fillRect(i * 16 + 2, r * 16 + 4, 12, 10) })
    const b = atob(c.toDataURL('image/png').split(',')[1]); const bytes = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i)
    const m = await window.core.saveMascot(${JSON.stringify(pack)}, bytes)
    return m && m.id
  })()`)
  check('pack: a synthetic pack saves', saved === 'blocky', String(saved))
  const sprite = await waitFor('the sprite', async () => (await mark('.sprite')) !== null, 3000).then(() => true, () => false)
  check('pack: it replaces the Knot on the session', sprite && (await mark('canvas.knot')) === null)
  // (The tile's call a moment ago may still be playing its leap.)
  const running = await waitFor('the run pose', async () => (await mark('.sprite')) === 'run', 2000).then(() => true, () => false)
  check('pack: the pose follows the status (working: run)', running, String(await mark('.sprite')))
  check('pack: drawn crisp', (await js(`getComputedStyle((${row}).querySelector('.sprite')).imageRendering`)) === 'pixelated')
  await sleep(3200) // past the last call, which a new one this soon would be taken for
  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'again\\r'); true`)
  const leapt = await waitFor('the leap', async () => (await mark('.sprite')) === 'leap', 4000).then(() => true, () => false)
  check('pack: a turn finishing plays Leap once', leapt)
  const after = await waitFor('the leap to end', async () => (await mark('.sprite')) === 'look', 3000).then(() => true, () => false)
  check('pack: then the pose for needing you (look, borrowed from the nearest mapped)', after, String(await mark('.sprite')))
  check('pack: remembered', (await js(`window.core.mascot().then((m) => m && m.pack.name)`)) === 'Blocky')

  await js(`window.core.removeMascot().then(() => true)`)
  const back = await waitFor('the knot to come back', async () => (await mark('canvas.knot')) !== null, 3000).then(() => true, () => false)
  check('pack: removing it brings the Knot back', back && (await mark('.sprite')) === null)

  // The setup screen, with a sheet chosen through its file input as a person would.
  await js(`[...document.querySelectorAll('.topbar button')].find((b) => b.textContent.includes('Mascot')).click(); true`)
  await waitFor('the setup screen', async () => (await js(`!!document.querySelector('.mascot-setup')`)) === true)
  check('setup: recommends Elthen’s fox, with the licence lines', (await js(`(() => { const t = document.querySelector('.mascot-reco').textContent; return t.includes('Elthen') && t.includes('redistribute') && t.includes('blockchain') && t.includes('Credit is not required') })()`)) === true)
  const sheetFile = process.env.WORKSHOP_SMOKE_SHEET
  const b64 = sheetFile ? (await readFile(sheetFile)).toString('base64') : ''
  await js(`(async () => {
    let bytes
    if (${JSON.stringify(b64)}) { const b = atob(${JSON.stringify(b64)}); bytes = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i) }
    else {
      // The fox sheet's LAYOUT (448 × 224, 32-pixel frames, 5/14/8/11/5/6/7 frames a row) in plain blocks.
      const c = document.createElement('canvas'); c.width = 448; c.height = 224
      const g = c.getContext('2d'); g.fillStyle = '#c86a3a'
      ;[5, 14, 8, 11, 5, 6, 7].forEach((n, r) => { for (let i = 0; i < n; i++) g.fillRect(i * 32 + 4, r * 32 + 14, 22, 18) })
      const b = atob(c.toDataURL('image/png').split(',')[1]); bytes = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i)
    }
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'sheet.png', { type: 'image/png' }))
    const input = document.querySelector('.mascot-drop input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  const known = await waitFor('the sheet to be read', async () => (await js(`!!document.querySelector('.mascot-known')`)) === true, 5000).then(() => true, () => false)
  check('setup: a sheet laid out like Elthen’s fox is recognised, every pose mapped', known && (await js(`document.querySelectorAll('.mascot-preview .sprite').length`)) === 5)
  await shot('setup')
  if (shots) {
    await js(`document.querySelector('.mascot-states').scrollIntoView(); true`)
    await shot('setup-states')
  }
  if (sheetFile) {
    await js(`[...document.querySelectorAll('.mascot-setup button.primary')].find((b) => b.textContent === 'Save').click(); true`)
    await waitFor('the fox', async () => (await mark('.sprite')) !== null, 3000).catch(() => undefined)
    await js(`document.querySelector('.mascot-setup .close').click(); true`)
    await shot('fox-head')
    await js(`window.core.removeMascot().then(() => true)`)
  } else await js(`document.querySelector('.mascot-setup .close').click(); true`)
  await js(`window.core.kill(${JSON.stringify(id)})`)
  if (process.env.WORKSHOP_MEASURE_CPU) await measureCpu(ctx0(win, core))
}

const ctx0 = (win: BrowserWindow, core: Ctx['core']) => ({ win, core })

/**
 * WORKSHOP_MEASURE_CPU=1: the window's renderer CPU with ten sessions resting, then working, then
 * with every Knot off screen (the cost of everything else), ten seconds each. Printed, not checked.
 */
async function measureCpu({ win, core }: { win: BrowserWindow; core: Ctx['core'] }): Promise<void> {
  const { app } = await import('electron')
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const pid = win.webContents.getOSProcessId()
  const sample = async (what: string): Promise<void> => {
    app.getAppMetrics() // starts the interval
    await sleep(10_000)
    const m = app.getAppMetrics().find((x) => x.pid === pid)
    console.log(`[cpu] ${what}: renderer ${m?.cpu.percentCPUUsage.toFixed(1)}% of one core`)
  }
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-cpu-')))
  const ids: string[] = []
  for (let i = 0; i < 10; i++) ids.push(String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'cpu-${i}' })`)).id))
  await sleep(3000)
  for (const id of ids) await js(`window.core.ptyInput(${JSON.stringify(id)}, 'x\\r'); true`)
  await sleep(2000)
  // Typing into a session is looking at it: no longer needing you, so resting.
  for (const id of ids) await js(`window.core.ptyInput(${JSON.stringify(id)}, ' '); true`)
  // The center shows the launcher, so no terminal is drawing: only the column and the mark.
  await js(`window.core.focusSession(null)`)
  await sleep(2000)
  console.log(`[cpu] modes: ${JSON.stringify(await js(`[...document.querySelectorAll('.sessions canvas.knot')].map((c) => c.dataset.mode)`))}`)
  await sample('10 sessions resting')
  for (const id of ids) await js(`window.core.ptyInput(${JSON.stringify(id)}, 'spoof\\r'); true`)
  await sleep(2000)
  console.log(`[cpu] modes: ${JSON.stringify(await js(`[...document.querySelectorAll('.sessions canvas.knot')].map((c) => c.dataset.mode)`))}`)
  await sample('10 sessions working')
  await js(`document.querySelectorAll('canvas.knot').forEach((c) => (c.style.transform = 'translateX(-5000px)')); true`)
  await sleep(1000)
  await sample('10 sessions working, every Knot off screen')
  for (const id of ids) await core.sessions.kill(id)
}

// ── Track F ──────────────────────────────────────────────────────────────────

/**
 * A session's project is its repository's root (project.ts): a session started in a worktree
 * reports the main repo as `root` beside its own start folder as `project`, and Reminders files
 * what it adds under the repo.
 */
async function projects(check: (name: string, ok: boolean, detail?: string) => void, { win, door, liveByTile, core }: Ctx): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd, stdio: 'ignore' })
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ws-repo-')))
  git(repo, 'init', '-q')
  await writeFile(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  const wt = join(repo, '.claude', 'worktrees', 'smoke')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'smoke')
  const made = await js(`window.core.newSession({ cwd: ${JSON.stringify(wt)}, name: 'in-a-worktree' })`)
  const id = String(made.id)
  const plainDir = await realpath(await mkdtemp(join(tmpdir(), 'ws-plain-')))
  const other = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(plainDir)}, name: 'no-repo' })`)).id)
  await waitFor('the worktree session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))
  const list = (await liveByTile.get('probe')!.wc.executeJavaScript(`workshop.sessions.list()`)) as { id: string; project: string; root: string }[]
  const me = list.find((s) => s.id === id)
  check('projects: a worktree session reports its start folder and its repo’s root', me?.project === wt && me?.root === repo, JSON.stringify(me))
  const plain = list.find((s) => s.id === other)
  check('projects: a session outside any repo is its own project', plain?.project === plainDir && plain?.root === plainDir, JSON.stringify(plain))
  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'tile reminders add "From the worktree"\\r'); true`)
  await waitFor('the reminder from the worktree', async () => (await screen(id)).includes('DONE tile reminders add'))
  const all = await post(door.port, '/tile/reminders', { op: 'list', args: ['--all'] }, { Authorization: `Bearer ${door.token}` })
  const r = (all.json.result?.reminders ?? []).find((x: { text: string }) => x.text === 'From the worktree')
  check('projects: Reminders files a worktree session’s reminder under the repo', r?.project === repo, JSON.stringify(r))
  if (r) await post(door.port, '/tile/reminders', { op: 'rm', args: [r.id] }, { Authorization: `Bearer ${door.token}` })
  await core.sessions.kill(id)
  await core.sessions.kill(other)
}

/**
 * The two side doors a request filter cannot see, tried from inside the probe's page. Each is
 * tried from core's own window too, which has no such guard, as the control: a door that is shut
 * for the tile but open for the control is shut by the sandbox, not by the network the smoke ran on.
 *
 * WebRTC: a STUN request for a server-reflexive candidate is UDP leaving the machine (and the
 * public address coming back). DNS: a prefetch or preconnect to a host the tile did not declare,
 * looked for in Chromium's own net log of the tile's session.
 */
async function sideDoors(check: (name: string, ok: boolean, detail?: string) => void, { win, liveByTile, userData }: Ctx): Promise<void> {
  const probe = liveByTile.get('probe')!.wc
  const STUN = `(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] })
    const seen = []
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) seen.push(e.candidate.type + '/' + e.candidate.protocol + ' ' + e.candidate.address) }
    pc.createDataChannel('x')
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((r) => { const t = setTimeout(r, 6000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r() } } })
    pc.close()
    return seen
  })()`
  const [tile, control] = (await Promise.all([probe.executeJavaScript(STUN), win.webContents.executeJavaScript(STUN)])) as string[][]
  const reflexive = (xs: string[]): boolean => xs.some((x) => x.startsWith('srflx') || x.startsWith('relay'))
  check('side doors: WebRTC from a tile reaches no STUN server', !reflexive(tile), JSON.stringify(tile))
  check('side doors: (control) core’s own window does reach one, so the check can see a leak', reflexive(control), JSON.stringify(control))
  check('side doors: WebRTC from a tile shows no local address', !tile.some((x) => /\d+\.\d+\.\d+\.\d+/.test(x) && !x.endsWith('.local')), JSON.stringify(tile))

  const tag = Math.random().toString(36).slice(2, 10)
  // A page that tries to turn prefetching back on first, then hints from itself and from a srcdoc frame.
  const hint = (who: string): string => `(() => {
    const m = document.createElement('meta'); m.httpEquiv = 'x-dns-prefetch-control'; m.content = 'on'; document.head.appendChild(m)
    for (const rel of ['dns-prefetch', 'preconnect']) { const l = document.createElement('link'); l.rel = rel; l.href = 'https://ws-' + rel + '-${who}-${tag}.example.com/'; document.head.appendChild(l) }
    const f = document.createElement('iframe'); f.style.display = 'none'
    f.srcdoc = '<meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="https://ws-frame-${who}-${tag}.example.com/">'
    document.body.appendChild(f)
    return true
  })()`
  const logged = async (wc: WebContents, who: string): Promise<string> => {
    const file = join(process.env.WORKSHOP_NETLOG_DIR ?? userData, `netlog-${who}.json`)
    await wc.session.netLog.startLogging(file)
    await wc.executeJavaScript(hint(who))
    await sleep(2500)
    await wc.session.netLog.stopLogging()
    return readFile(file, 'utf8')
  }
  const tileLog = await logged(probe, 'tile')
  const controlLog = await logged(win.webContents, 'core')
  // A name was looked up when the resolver took a request for it or a DNS query asked for it.
  const looked = (log: string, who: string): string[] =>
    ['dns-prefetch', 'preconnect', 'frame'].filter((rel) => new RegExp(`"(host|hostname|qname)":"[^"]*ws-${rel}-${who}-${tag}\\.example\\.com`).test(log))
  // The dead proxy does not stop <link rel=dns-prefetch>, nor does an X-DNS-Prefetch-Control
  // header or a default-src 'self' CSP (core's window has one, and still looks names up). Tile
  // pages are started with Blink's DNS prefetching off (index.ts, will-attach-webview).
  const leaked = looked(tileLog, 'tile')
  check('side doors: a tile’s DNS prefetch, preconnect and a srcdoc frame’s prefetch look nothing up', leaked.length === 0, leaked.join(', '))
  check('side doors: (control) the net log shows core’s window looking a prefetched name up', looked(controlLog, 'core').includes('dns-prefetch'), looked(controlLog, 'core').join(', '))
}

/**
 * The Knots' one clock (Knot.tsx): under reduced motion each knot draws one still frame and the
 * clock stops; in a hidden window it does not wake at all. Reduced motion is the system setting
 * emulated through the devtools protocol, which fires the same media-query change. The hidden
 * window is real: the smoke window (never shown) is shown at zero opacity, without focus, then hidden.
 */
async function knotClock(check: (name: string, ok: boolean, detail?: string) => void, { win }: Ctx): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const counts = (): Promise<{ draws: number; wakes: number }> => js(`({ ...window.knotCounts })`)
  const over = async (ms: number): Promise<{ draws: number; wakes: number }> => {
    const a = await counts()
    await sleep(ms)
    const b = await counts()
    return { draws: b.draws - a.draws, wakes: b.wakes - a.wakes }
  }
  const knots = (await js(`document.querySelectorAll('canvas.knot').length`)) as number
  const moving = await over(2000)
  check('knot clock: it runs (the app mark rests at 6 frames a second; a busy machine gets fewer)', knots > 0 && moving.draws >= 3, `${knots} knots, ${JSON.stringify(moving)}`)

  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  try {
    const before = await counts()
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await sleep(400)
    const after = await counts()
    const still = await over(2000)
    check('knot clock: reduced motion draws one still frame per knot', (await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`)) === true && after.draws - before.draws === knots, `${after.draws - before.draws} frames for ${knots} knots`)
    check('knot clock: then nothing more under reduced motion', still.draws === 0 && still.wakes === 0, JSON.stringify(still))
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await sleep(300)
    check('knot clock: and moves again without it', (await over(2000)).draws >= 3)
  } finally {
    cdp.detach()
  }

  const neverShown = (await js(`document.visibilityState`)) as string
  // Smoke turns background throttling off, and with it Electron keeps the page "visible" when hidden;
  // the app runs with it on, so it is on for this check.
  win.webContents.setBackgroundThrottling(true)
  win.setOpacity(0)
  win.showInactive()
  await waitFor('the window to be visible', async () => (await js(`document.visibilityState`)) === 'visible', 5000).catch(() => undefined)
  const shown = await over(1500)
  win.hide()
  await waitFor('the window to be hidden', async () => (await js(`document.hidden`)) === true, 5000).catch(() => undefined)
  const hidden = (await js(`document.hidden`)) as boolean
  const asleep = await over(2500)
  check('knot clock: a hidden window wakes it not once', hidden && shown.draws > 0 && asleep.wakes === 0 && asleep.draws === 0, `never shown: ${neverShown}; shown ${JSON.stringify(shown)}; hidden ${hidden} ${JSON.stringify(asleep)}`)
  win.webContents.setBackgroundThrottling(false)
  win.setOpacity(1)
}

/**
 * Sessions outlive core. This core quits the way the app does (sessions parked in tmux, the door
 * closed), and a second core is started on the same profile (`--smoke-restarted`, runRestarted
 * below), which must find the session, reattach it and hear its hooks. Then the tmux server is
 * killed, as a reboot would, and a third core must show the session closed and resume it with
 * `--resume` into the same conversation. Their checks are reported here as this run's.
 */
async function restart(check: (name: string, ok: boolean, detail?: string) => void, ctx: Ctx): Promise<void> {
  const { win, door, core, userData } = ctx
  const { app } = await import('electron')
  const { spawn } = await import('node:child_process')
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-survivor-')))
  const id = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'survivor' })`)).id)
  await waitFor('the survivor to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))
  await js(`window.core.ptyInput(${JSON.stringify(id)}, 'before the restart\\r'); true`)
  await waitFor('its turn', async () => (await screen(id)).includes('DONE before the restart'))
  await waitFor('its transcript', () => (core.transcripts.get(id)?.blocks.length ?? 0) > 0)

  core.stop()
  door.stop()
  const second = (mode: 'restart' | 'reboot'): Promise<string> =>
    new Promise((done) => {
      const env = { ...process.env, WORKSHOP_SMOKE_HOME: userData, WORKSHOP_SMOKE_PROFILE: ctx.profile ?? '', WORKSHOP_SMOKE_RESTART: mode, WORKSHOP_SMOKE_SURVIVOR: id }
      const p = spawn(process.execPath, [app.getAppPath(), '--smoke-restarted'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', () => {})
      const kill = setTimeout(() => p.kill(), 60_000)
      p.on('exit', () => {
        clearTimeout(kill)
        done(out)
      })
    })
  const report = (mode: string, out: string): void => {
    const lines = out.split('\n').filter((l) => /^(ok {4}|FAIL {2})/.test(l))
    for (const l of lines) check(`${mode}: ${l.slice(6).replace(/ {2}\(.*\)$/, '')}`, l.startsWith('ok'), l.slice(6))
    if (!lines.length) check(`${mode}: the second core ran its checks`, false, out.slice(-400))
  }
  report('restart', await second('restart'))
  // A reboot takes the tmux server with it.
  await core.tmux.killServer()
  report('reboot', await second('reboot'))
}

/** The second core's half of `restart` (index.ts starts it with --smoke-restarted). */
export async function runRestarted(ctx: Ctx): Promise<number> {
  const { win, core } = ctx
  const results: [string, boolean, string?][] = []
  const check = (name: string, ok: boolean, detail?: string): void => void results.push([name, ok, detail])
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const id = process.env.WORKSHOP_SMOKE_SURVIVOR ?? ''
  const view = () => core.sessions.getState().sessions.find((s) => s.id === id)
  const userTexts = (): string[] => (core.transcripts.get(id)?.blocks ?? []).flatMap((b) => (b.kind === 'user' ? [b.text] : []))
  try {
    await waitFor('the window', async () => (await js(`!!document.querySelector('.app')`)) === true)
    if (process.env.WORKSHOP_SMOKE_RESTART === 'restart') {
      const v = view()
      check('the session is still there, open, its tmux session alive', !!v && v.open && v.tmuxAlive, JSON.stringify(v && { open: v.open, tmuxAlive: v.tmuxAlive }))
      check('it is reattached', await waitFor('the pty', () => !!view()?.attached, 5000).then(() => true, () => false))
      check('its conversation is read again', await waitFor('the transcript', () => userTexts().includes('before the restart'), 5000).then(() => true, () => false), JSON.stringify(userTexts()))
      check('its tile is drawn', await waitFor('the tile', async () => (await js(`!!document.querySelector('[data-session="${id}"]')`)) === true, 5000).then(() => true, () => false))
      await js(`window.core.ptyInput(${JSON.stringify(id)}, 'after the restart\\r'); true`)
      const typed = await waitFor('the turn', async () => (await screen(id)).includes('DONE after the restart'), 10_000).then(() => true, () => false)
      // The hooks find the new core through <profile>/port, with the token kept on disk.
      const heard = await waitFor('its hooks', () => view()?.status === 'idle' && view()?.attention === true, 5000).then(() => true, () => false)
      check('a new prompt runs, and its hooks reach the new core', typed && heard, JSON.stringify(view() && { status: view()!.status, attention: view()!.attention }))
    } else {
      const v = view()
      check('the session is listed, closed, its tmux session gone', !!v && !v.open && !v.tmuxAlive, JSON.stringify(v && { open: v.open, tmuxAlive: v.tmuxAlive }))
      await js(`window.core.resume(${JSON.stringify(id)}).then(() => true)`)
      const back = await waitFor('the resumed session', async () => (await screen(id)).includes('FAKE CLAUDE READY'), 10_000).then(() => true, () => false)
      const started = JSON.parse(await readFile(join(ctx.userData, `fake-${id}.json`), 'utf8')) as { args: string[] }
      const rec = core.sessions.find(id)
      check('it resumes with --resume and its own conversation id', back && started.args.join(' ').includes(`--resume ${rec?.claudeSessionId}`), started.args.join(' '))
      await js(`window.core.ptyInput(${JSON.stringify(id)}, 'after the reboot\\r'); true`)
      await waitFor('the turn', async () => (await screen(id)).includes('DONE after the reboot'), 10_000).catch(() => undefined)
      const both = await waitFor('the whole conversation', () => ['before the restart', 'after the restart', 'after the reboot'].every((t) => userTexts().includes(t)), 5000).then(() => true, () => false)
      check('the conversation goes on in the same transcript', both, JSON.stringify(userTexts()))
    }
  } catch (err) {
    check('ran to the end', false, (err as Error).message)
  }
  return finish(results, ctx)
}
