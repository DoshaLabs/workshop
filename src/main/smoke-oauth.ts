// The smoke run's part for `workshop.oauth` (bridge 1.5). test/fixtures/oauth is loaded as a dev
// tile; its page starts a sign-in on each real click. No provider exists: the run reads the URL
// core would have opened in the browser, then plays the browser and GETs the callback itself.

import type { WebContents } from 'electron'
import { request } from 'node:http'
import { resolve } from 'node:path'
import { app } from 'electron'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  liveByTile: Map<string, { wc: WebContents }>
  addDevTile: (folder: string) => Promise<string>
  opened: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** What the browser does with the provider's redirect. */
const browse = (url: string, host?: string): Promise<{ status: number; body: string }> =>
  new Promise((done) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host: host ?? u.host }, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => done({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', (e) => done({ status: 0, body: e.message }))
    req.end()
  })

export async function oauthSmoke(check: Check, { liveByTile, addDevTile, opened }: Ctx): Promise<void> {
  await addDevTile(resolve(app.getAppPath(), 'test/fixtures/oauth'))
  await waitFor('the sign-in tile to load', async () => (await liveByTile.get('oauth-probe')?.wc.executeJavaScript('window.oauthReady === true').catch(() => false)) === true)
  const page = liveByTile.get('oauth-probe')!.wc
  const inPage = (code: string): Promise<any> => page.executeJavaScript(code)
  const click = (): void => {
    page.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 })
  }
  const results = (): Promise<any[]> => inPage('window.results')
  /** The next URL core sent to the browser, once it is there. */
  const nextOpened = async (n: number): Promise<string | undefined> => {
    await waitFor('the browser to be sent somewhere', () => opened.length > n, 3000).catch(() => undefined)
    return opened[n]
  }

  const probeHas = await liveByTile.get('probe')?.wc.executeJavaScript('"oauth" in window.workshop')
  check('oauth: a tile without the permission has no workshop.oauth', probeHas === false, String(probeHas))
  const redirect = (await inPage('workshop.oauth.redirectUri')) as string
  check('oauth: redirectUri is this tile\'s own path on loopback', /^http:\/\/127\.0\.0\.1:\d+\/oauth\/oauth-probe\/callback$/.test(redirect) && !redirect.includes(':47800/'), redirect)

  const bare = await inPage(`workshop.oauth.authorize(authorizeUrl()).then(() => 'ran', (e) => e.message)`)
  check('oauth: refused without a click in the page', bare === 'oauth: needs a click in the tile', bare)

  // A real click: core opens the provider's page with its own state, and catches the callback.
  await sleep(1100) // openExternal's once a second, from any earlier smoke step
  let n = opened.length
  click()
  const url = await nextOpened(n)
  const state = url ? new URL(url).searchParams.get('state') : null
  check('oauth: a click opens the authorize page, with core\'s state in place of the tile\'s', !!url && url.startsWith('https://auth.example.com/authorize?') && !!state && state !== 'the-tiles-own' && state.length === 43, url)
  const again = await inPage(`workshop.oauth.authorize(authorizeUrl()).then(() => 'ran', (e) => e.message)`)
  check('oauth: one sign-in per click', again === 'oauth: needs a click in the tile', again)
  const fromPage = await inPage(`fetch(${JSON.stringify(redirect)}).then((r) => r.status, () => 'refused')`)
  check('oauth: the tile itself cannot reach the listener', fromPage === 'refused', String(fromPage))
  const wrong = await browse(`${redirect.replace('oauth-probe', 'probe')}?code=stolen&state=${state}`)
  const rebound = await browse(`${redirect}?code=stolen&state=${state}`, 'evil.example.com')
  check('oauth: a callback at another tile\'s path, or under another Host, is refused', wrong.status === 400 && rebound.status === 404, `${wrong.status} ${rebound.status}`)
  const res = await browse(`${redirect}?code=AQB-smoke&state=${state}`)
  check('oauth: the browser lands on core\'s own page', res.status === 200 && res.body.includes('Signed in') && !res.body.includes('AQB'), `${res.status}`)
  await waitFor('the tile to hear back', async () => (await results()).length > 0, 3000).catch(() => undefined)
  const got = (await results())[0]
  check('oauth: the tile gets the query, state removed', got?.ok === true && got.query === 'code=AQB-smoke', JSON.stringify(got))
  const late = await browse(`${redirect}?code=again&state=${state}`)
  check('oauth: a state is used once, and the listener closes after', late.status === 0, `${late.status} ${late.body}`)

  // Refusals that reach the page as words, and open nothing.
  for (const [what, extra, want] of [
    ['an undeclared host', `authorizeUrl().replace('auth.example.com', 'evil.example.com')`, /evil\.example\.com is not in permissions\.oauth/],
    ['another tile\'s redirect', `authorizeUrl({ redirect_uri: workshop.oauth.redirectUri.replace('oauth-probe', 'probe') })`, /redirect_uri must be/],
    ['no PKCE', `authorizeUrl({ code_challenge_method: 'plain' })`, /PKCE/]
  ] as const) {
    await inPage(`window.results = []; window.next = ${extra}; true`)
    n = opened.length
    await sleep(1100)
    click()
    await waitFor('the refusal', async () => (await results()).length > 0, 3000).catch(() => undefined)
    const r = (await results())[0]
    check(`oauth: ${what} is refused, and nothing is opened`, r?.ok === false && want.test(r.error) && opened.length === n, JSON.stringify(r))
  }

  // Cancel, and a reload, end a sign-in.
  await inPage('window.results = []; true')
  await sleep(1100)
  n = opened.length
  click()
  await nextOpened(n)
  await sleep(200)
  await inPage('workshop.oauth.cancel()')
  await waitFor('the cancel', async () => (await results()).length > 0, 3000).catch(() => undefined)
  const cancelled = (await results())[0]
  check('oauth: cancel() ends the sign-in', cancelled?.ok === false && cancelled.error === 'oauth: cancelled', JSON.stringify(cancelled))
  const closed = await browse(`${redirect}?code=x&state=y`)
  check('oauth: nothing pending, nothing listening', closed.status === 0, String(closed.status))
}
