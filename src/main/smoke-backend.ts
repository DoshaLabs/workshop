// The smoke run's part for the trusted tier (track B). test/fixtures/trusted is loaded as if it
// shipped in tiles/ (smoke only, index.ts SMOKE_BUILTINS). From inside its page, through
// workshop.backend, as a built-in tile would: the round trip, an op the manifest does not list,
// a timeout, the backend's clean environment, the sessions list arriving, a crash and the restart,
// giving up after a few, and the process stopping when the tile is turned off.

import type { BrowserWindow, WebContents } from 'electron'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { BACKEND_ENV } from './backend-protocol'
import type { Backends } from './backend'
import type { Door } from './door'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  win: BrowserWindow
  door: Door
  liveByTile: Map<string, { wc: WebContents }>
  userData: string
  backends?: Backends
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const alive = (pid: number | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function backendSmoke(check: Check, { win, door, liveByTile, userData, backends }: Ctx): Promise<void> {
  if (!backends) throw new Error('no backends in the smoke context')
  const page = (): WebContents => liveByTile.get('trusted')!.wc
  const inPage = (code: string): Promise<any> => page().executeJavaScript(code)
  /** One call from the page: { ok, result } or { ok: false, error, ms }. */
  const call = (op: string, body: unknown = null): Promise<any> =>
    inPage(`(async () => { const t = Date.now(); try { return { ok: true, result: await workshop.backend.call(${JSON.stringify(op)}, ${JSON.stringify(body)}) } } catch (e) { return { ok: false, error: e.message, ms: Date.now() - t } } })()`)
  const state = (): string => backends.status('trusted').state
  const setOff = (off: boolean): Promise<unknown> =>
    win.webContents.executeJavaScript(`(async () => { const c = await window.core.column(); const o = c.off.filter((x) => x !== 'trusted'); await window.core.setColumn({ ...c, off: ${off} ? [...o, 'trusted'] : o }); return true })()`)

  await waitFor('the trusted tile and its backend', async () => !!liveByTile.get('trusted') && state() === 'running' && (await inPage('window.trustedReady === true').catch(() => false)) === true)
  const root = await realpath(resolve(app.getAppPath(), 'test/fixtures/trusted'))

  const echo = await call('echo', { a: [1, 2], s: 'x' })
  check('backend: a call from the page reaches the backend and its answer comes back', echo.ok && JSON.stringify(echo.result.body) === '{"a":[1,2],"s":"x"}', JSON.stringify(echo))
  check('backend: it runs in the tile\'s folder, as its own process', echo.ok && echo.result.cwd === root && echo.result.pid !== process.pid && echo.result.pid === backends.pid('trusted'), JSON.stringify(echo.result))
  check('backend: the page sees it running', (await inPage('workshop.backend.status()'))?.state === 'running')

  // An op the manifest does not list: refused in the page, and by core when asked directly.
  const before = (await call('count')).result
  const undeclared = await call('nope')
  check('backend: an undeclared op is refused in the page', !undeclared.ok && /not in backend.ops/.test(undeclared.error), JSON.stringify(undeclared))
  const direct = await backends.call('trusted', 'nope', null).then(() => 'answered', (e: Error) => e.message)
  check('backend: core refuses an undeclared op before the backend hears of it', /not one of this tile's backend ops/.test(direct) && (await call('count')).result === before, `${direct}; ${before}`)
  check('backend: a body that is not JSON is refused', /not JSON/.test(await backends.call('trusted', 'echo', { f: 1n }).then(() => '', (e: Error) => e.message)))
  const probeHas = await liveByTile.get('probe')?.wc.executeJavaScript('"backend" in window.workshop')
  check('backend: a tile without one has no workshop.backend', probeHas === false, String(probeHas))

  const slow = await call('slow')
  check('backend: a call is given up after the manifest\'s timeoutMs', !slow.ok && /within 500 ms/.test(slow.error) && slow.ms < 1500, JSON.stringify(slow))

  // Its environment: only what git and gh need, nothing of core's, no token.
  const env = (await call('env')).result as { keys: string[]; values: string[]; argv: string[] }
  const allowed = new Set<string>(BACKEND_ENV)
  // Chromium adds MACH_PORT_RENDEZVOUS_* to every child it starts on macOS; it is not core's to pass or keep.
  const ours = env.keys.filter((k) => !k.startsWith('MACH_PORT_RENDEZVOUS'))
  check('backend: its environment is the short list, nothing named WORKSHOP_', ours.every((k) => allowed.has(k)) && ours.includes('PATH') && ours.includes('HOME'), env.keys.join(' '))
  check('backend: no token or WORKSHOP_AUTH reaches it', !env.values.some((v) => v.includes(door.token)) && !env.argv.some((a) => a.includes(door.token)) && !env.keys.some((k) => /WORKSHOP|TOKEN/.test(k)), JSON.stringify(env.argv))

  // The sessions: a new one is told to the backend with its folder and project root.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'workshop-backend-')))
  const made = (await win.webContents.executeJavaScript(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'backend-watch' })`)) as { id: string }
  let seen: any = null
  await waitFor('the backend to hear of the session', async () => {
    seen = (await call('sessions')).result
    return !!seen?.list?.some((s: { id: string }) => s.id === made.id)
  }).catch(() => undefined)
  const mine = seen?.list?.find((s: { id: string }) => s.id === made.id)
  check('backend: the sessions arrive, with name, folder and root', !!mine && mine.name === 'backend-watch' && mine.folder === cwd && mine.root === cwd && seen.heard >= 1, JSON.stringify(seen))
  check('backend: a session as it sees one holds nothing to act as it', !!mine && Object.keys(mine).sort().join() === 'folder,id,name,root', JSON.stringify(mine))
  await win.webContents.executeJavaScript(`window.core.kill(${JSON.stringify(made.id)})`)

  // A crash: the call it was answering fails, the backend comes back, the page is told.
  const pid1 = backends.pid('trusted')
  const crash = await call('crash')
  await waitFor('the backend to come back', () => state() === 'running' && backends.pid('trusted') !== pid1, 5000).catch(() => undefined)
  const again = await call('echo', 1)
  const seenStates = (await inPage('window.statuses')) as string[]
  check('backend: a crash is restarted, and the page hears of it', again.ok && again.result.pid !== pid1 && seenStates.includes('restarting') && seenStates.at(-1) === 'running', `${JSON.stringify(crash)} ${JSON.stringify(seenStates)}`)

  // Three more in a row and core gives up (smoke restarts after 100, 200, 300 ms) and says why.
  for (let i = 0; i < 3; i++) {
    const was = backends.pid('trusted')
    await call('crash')
    await waitFor('a restart or giving up', () => (state() === 'running' && backends.pid('trusted') !== was) || state() === 'failed', 5000).catch(() => undefined)
  }
  const gaveUp = await call('echo', 1)
  const st = (await inPage('workshop.backend.status()')) as { state: string; error?: string }
  check('backend: after four quick crashes core gives up, and the page is told why', state() === 'failed' && st.state === 'failed' && /4 times/.test(st.error ?? '') && !gaveUp.ok && /stopped/.test(gaveUp.error), `${JSON.stringify(st)} ${JSON.stringify(gaveUp)}`)

  // Turning the tile off and on is what tries again; off stops the process.
  await setOff(true)
  await waitFor('the backend to stop', () => state() === 'stopped', 5000).catch(() => undefined)
  await setOff(false)
  await waitFor('the backend to start again', () => state() === 'running', 10_000).catch(() => undefined)
  const pid2 = backends.pid('trusted')
  check('backend: turning a failed tile off and on starts it again', state() === 'running' && alive(pid2), `${state()} ${pid2}`)
  await setOff(true)
  await waitFor('the backend to stop', () => state() === 'stopped' && !alive(pid2), 5000).catch(() => undefined)
  check('backend: turning the tile off stops its process', state() === 'stopped' && !alive(pid2), `${state()} ${pid2} ${alive(pid2)}`)
  await setOff(false)
  await waitFor('the backend to start again', () => state() === 'running', 10_000).catch(() => undefined)

  const log = await readFile(join(userData, 'logs', 'backend-trusted.log'), 'utf8').catch(() => '')
  check('backend: its starts and exits are logged in the profile', (log.match(/starting /g) ?? []).length >= 5 && log.includes('exited with code 3'), log.slice(-300))
}
