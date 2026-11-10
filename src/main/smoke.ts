// `npm run smoke`: starts core with a throwaway profile and the probe tile (test/fixtures/probe),
// then tries, from INSIDE the probe's page, every way out of the sandbox it can think of, and
// drives the door over HTTP. Prints one line per check and exits non-zero if any failed.

import type { BrowserWindow, WebContents } from 'electron'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import type { Door } from './door'

interface Ctx {
  win: BrowserWindow
  door: Door
  liveByTile: Map<string, { wc: WebContents; ops: Set<string>; usedAt: number }>
  userData: string
  /** What the tiles asked the browser to open (a smoke run never opens one). */
  opened: string[]
  addDevTile: (folder: string) => Promise<string>
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
    const show = await post(door.port, '/tile/wikipedia', { op: 'show', args: ['Red fox'] }, auth)
    const found = await post(door.port, '/tile/wikipedia', { op: 'search', args: ['red', 'fox'] }, auth)
    check('wikipedia door: search', found.status === 200 && Array.isArray(found.json.result) && found.json.result.length > 0, JSON.stringify(found.json).slice(0, 200))
    const imgs = (await wiki.executeJavaScript(`new Promise((res) => setTimeout(() => res([...document.images].map((i) => i.complete && i.naturalWidth > 0)), 3000))`)) as boolean[]
    check('wikipedia page: images load', imgs.length > 0 && imgs.every(Boolean), JSON.stringify(imgs))
    check('wikipedia door: show', show.status === 200 && typeof show.json.result?.title === 'string', JSON.stringify(show.json))

    await devTiles(check, liveByTile, door.port, addDevTile)
    await files(check, ctx)
    await instances(check, ctx)
  } catch (err) {
    check('smoke ran to the end', false, (err as Error).message)
  }
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

/** `multiple`: a second probe, its own page and web storage, the same workshop.storage, and the door. */
async function instances(check: (name: string, ok: boolean, detail?: string) => void, { win, door, liveByTile }: Ctx): Promise<void> {
  const js = (key: string, code: string): Promise<unknown> => liveByTile.get(key)!.wc.executeJavaScript(code)
  await js('probe', `localStorage.setItem('mine', 'first'); true`)
  // Open a second probe the way the column's + does, then reload the window (every page remounts).
  await win.webContents.executeJavaScript(`localStorage.setItem('workshop.extra', '["probe.2"]'); true`)
  win.webContents.reload()
  await waitFor('the second probe', async () => !!liveByTile.get('probe.2') && (await js('probe.2', 'window.probeReady === true').catch(() => false)) === true)
  await waitFor('the first probe again', async () => !!liveByTile.get('probe')?.ops.has('echo'))
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
