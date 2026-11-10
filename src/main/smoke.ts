// `npm run smoke`: starts core with a throwaway profile and the probe tile (test/fixtures/probe),
// then tries, from INSIDE the probe's page, every way out of the sandbox it can think of, and
// drives the door over HTTP. Prints one line per check and exits non-zero if any failed.

import type { BrowserWindow, WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import type { Door } from './door'

interface Ctx {
  win: BrowserWindow
  door: Door
  liveByTile: Map<string, { wc: WebContents; ops: Set<string> }>
  userData: string
  /** What the tiles asked the browser to open (a smoke run never opens one). */
  opened: string[]
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

export async function runSmoke({ win, door, liveByTile, userData, opened }: Ctx): Promise<number> {
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
