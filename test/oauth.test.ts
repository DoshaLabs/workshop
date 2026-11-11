import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { checkManifest } from '@shared/manifest'
import { needsAsking, permissionKeys, permissionWords } from '@shared/permissions'
import { OAuthHost, PAGES, checkAuthorizeUrl, redirectUriFor } from '../src/main/oauth'

const base = { id: 'spotify', name: 'Spotify', version: '0.1.0', workshop: '^1.5', author: 'someone', entry: 'dist/index.html' }

describe('the oauth permission', () => {
  it('takes host names, as net does', () => {
    const r = checkManifest({ ...base, permissions: { oauth: ['accounts.spotify.com'], net: ['accounts.spotify.com'] } })
    expect(r.ok && r.manifest.permissions.oauth).toEqual(['accounts.spotify.com'])
    for (const bad of [['127.0.0.1'], ['localhost'], ['*'], ['https://x.com'], ['x.com:443'], 'x.com'])
      expect(checkManifest({ ...base, permissions: { oauth: bad } }).ok).toBe(false)
  })

  it('needs a workshop range of 1.5 or later', () => {
    const r = checkManifest({ ...base, workshop: '^1.3', permissions: { oauth: ['accounts.spotify.com'] } })
    expect(r.ok ? [] : r.errors).toEqual([expect.stringMatching(/permissions\.oauth: bridge 1\.5/)])
  })

  it('is shown in words, one key per host, and a new host asks again', () => {
    expect(permissionWords({ oauth: ['accounts.spotify.com'] })).toEqual(['sign you in at accounts.spotify.com'])
    expect(permissionKeys({ oauth: ['a.com', 'b.com'] })).toEqual(['oauth:a.com', 'oauth:b.com'])
    expect(needsAsking({ oauth: ['a.com'] }, { oauth: ['a.com'] })).toBe(false)
    expect(needsAsking({ oauth: ['a.com'] }, { oauth: ['a.com', 'b.com'] })).toBe(true)
    expect(needsAsking({ net: ['a.com'] }, { net: ['a.com'], oauth: ['a.com'] })).toBe(true)
  })
})

const REDIRECT = redirectUriFor('spotify')
const good = (extra: Record<string, string> = {}): string => {
  const u = new URL('https://accounts.spotify.com/authorize')
  for (const [k, v] of Object.entries({ client_id: 'abc', response_type: 'code', redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'tiles-own', ...extra })) u.searchParams.set(k, v)
  return u.toString()
}
const check = (url: unknown, hosts = ['accounts.spotify.com']): string => {
  const r = checkAuthorizeUrl(url, { hosts, redirectUri: REDIRECT, state: 'core-state' })
  return 'error' in r ? r.error : r.url
}

describe('checkAuthorizeUrl', () => {
  it('gives each tile its own redirect path on the fixed port', () => {
    expect(REDIRECT).toBe('http://127.0.0.1:47800/oauth/spotify/callback')
  })

  it('puts core\'s state in place of the tile\'s', () => {
    const u = new URL(check(good()))
    expect(u.searchParams.getAll('state')).toEqual(['core-state'])
    expect(u.searchParams.get('client_id')).toBe('abc')
  })

  it('refuses an undeclared host, a non-https URL, a port or a user name', () => {
    expect(check(good().replace('accounts.spotify.com', 'evil.com'))).toMatch(/evil\.com is not in permissions\.oauth/)
    expect(check(good().replace('https:', 'http:'))).toMatch(/https/)
    expect(check(good().replace('accounts.spotify.com', 'accounts.spotify.com:8443'))).toMatch(/port/)
    expect(check(good().replace('https://', 'https://me@'))).toMatch(/user name/)
    expect(check('not a url')).toMatch(/not a URL/)
    expect(check(42)).toMatch(/string/)
  })

  it('refuses another tile\'s redirect, an implicit grant, and no PKCE', () => {
    expect(check(good({ redirect_uri: redirectUriFor('other') }))).toMatch(/redirect_uri must be/)
    expect(check(good({ redirect_uri: 'http://localhost:47800/oauth/spotify/callback' }))).toMatch(/redirect_uri must be/)
    expect(check(good({ response_type: 'token' }))).toMatch(/response_type/)
    expect(check(good({ code_challenge_method: 'plain' }))).toMatch(/PKCE/)
    const u = new URL(good())
    u.searchParams.delete('code_challenge')
    expect(check(u.toString())).toMatch(/PKCE/)
  })
})

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => resolve(p))
    })
  })

/** A GET as the browser makes it after the provider's redirect. */
const get = (port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host }, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('OAuthHost', () => {
  let host: OAuthHost | null = null
  afterEach(() => host?.stop())

  const start = async (o: { timeoutMs?: number; open?: (id: string, url: string) => boolean } = {}) => {
    const port = await freePort()
    const opened: string[] = []
    host = new OAuthHost({ port, timeoutMs: o.timeoutMs, open: o.open ?? ((_id, url) => (opened.push(url), true)) })
    const url = (id = 'spotify'): string => good({ redirect_uri: host!.redirectUri(id) })
    return { port, opened, url, host }
  }

  it('listens only while a sign-in is pending, and hands the tile the query without state', async () => {
    const { port, opened, url, host } = await start()
    expect(host.listening).toBe(false)
    const p = host.authorize('spotify', 1, ['accounts.spotify.com'], url())
    await tick()
    expect(host.listening).toBe(true)
    const state = new URL(opened[0]).searchParams.get('state')!
    expect(state).toHaveLength(43)
    const res = await get(port, `/oauth/spotify/callback?code=AQB123&state=${state}`)
    expect(res.status).toBe(200)
    expect(res.body).toBe(PAGES.done)
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/)
    await expect(p).resolves.toBe('code=AQB123')
    await tick()
    expect(host.listening).toBe(false)
  })

  it('a refused sign-in comes back as the provider\'s error, on a page that does not say signed in', async () => {
    const { port, opened, url, host } = await start()
    const p = host.authorize('spotify', 1, ['accounts.spotify.com'], url())
    await tick()
    const state = new URL(opened[0]).searchParams.get('state')!
    const res = await get(port, `/oauth/spotify/callback?error=access_denied&state=${state}`)
    expect(res.body).toBe(PAGES.refused)
    await expect(p).resolves.toBe('error=access_denied')
  })

  it('a callback reaches only the tile whose state it carries, at that tile\'s path', async () => {
    const { port, opened, url, host } = await start()
    const a = host.authorize('spotify', 1, ['accounts.spotify.com'], url('spotify'))
    const b = host.authorize('other', 2, ['accounts.spotify.com'], url('other'))
    await tick()
    const stateA = new URL(opened[0]).searchParams.get('state')!
    expect((await get(port, `/oauth/other/callback?code=x&state=${stateA}`)).status).toBe(400)
    expect((await get(port, `/oauth/spotify/callback?code=x&state=nope`)).body).toBe(PAGES.expired)
    expect((await get(port, `/oauth/spotify/callback?code=x`)).status).toBe(400)
    expect(host.size).toBe(2)
    expect((await get(port, `/oauth/spotify/callback?code=x&state=${stateA}`)).status).toBe(200)
    await expect(a).resolves.toBe('code=x')
    host.cancel('other')
    await expect(b).rejects.toThrow('oauth: cancelled')
  })

  it('answers nothing but a GET to a callback path with its own Host', async () => {
    const { port, opened, url, host } = await start()
    const p = host.authorize('spotify', 1, ['accounts.spotify.com'], url())
    await tick()
    const state = new URL(opened[0]).searchParams.get('state')!
    const path = `/oauth/spotify/callback?code=x&state=${state}`
    expect((await get(port, '/')).status).toBe(404)
    expect((await get(port, path, `rebound.example.com:${port}`)).status).toBe(404)
    expect((await get(port, path, `localhost:${port}`)).status).toBe(404)
    expect((await get(port, path, undefined, 'POST')).status).toBe(404)
    expect(host.size).toBe(1)
    await get(port, path)
    await expect(p).resolves.toBe('code=x')
  })

  it('one sign-in per tile: a new one cancels the old', async () => {
    const { url, host } = await start()
    const first = host.authorize('spotify', 1, ['accounts.spotify.com'], url())
    const second = host.authorize('spotify', 1, ['accounts.spotify.com'], url())
    await expect(first).rejects.toThrow('oauth: cancelled')
    await tick()
    expect(host.size).toBe(1)
    expect(host.listening).toBe(true)
    host.cancel('spotify')
    await expect(second).rejects.toThrow('oauth: cancelled')
  })

  it('ends a sign-in when its page goes, and when it times out', async () => {
    const { url, host } = await start({ timeoutMs: 50 })
    const a = host.authorize('spotify', 7, ['accounts.spotify.com'], url())
    await tick()
    host.dropPage(7)
    await expect(a).rejects.toThrow('oauth: cancelled')
    // A page that goes while the listener is still starting.
    const b = host.authorize('spotify', 8, ['accounts.spotify.com'], url())
    host.dropPage(8)
    await expect(b).rejects.toThrow('oauth: cancelled')
    await tick()
    expect(host.listening).toBe(false)
    await expect(host.authorize('spotify', 7, ['accounts.spotify.com'], url())).rejects.toThrow('oauth: timed out')
    await tick()
    expect(host.listening).toBe(false)
  })

  it('refuses a bad URL before it listens or opens anything', async () => {
    const { opened, host } = await start()
    await expect(host.authorize('spotify', 1, ['accounts.spotify.com'], good())).rejects.toThrow(/redirect_uri/)
    expect(opened).toEqual([])
    expect(host.listening).toBe(false)
  })

  it('says so when the port is taken, and when the browser was not opened', async () => {
    const { port, url, host } = await start({ open: () => false })
    const squat = createServer().listen(port, '127.0.0.1')
    await new Promise((r) => squat.once('listening', r))
    await expect(host.authorize('spotify', 1, ['accounts.spotify.com'], url())).rejects.toThrow(`oauth: port ${port} is in use`)
    await new Promise((r) => squat.close(r))
    await expect(host.authorize('spotify', 1, ['accounts.spotify.com'], url())).rejects.toThrow(/browser was not opened/)
    await tick()
    expect(host.listening).toBe(false)
  })
})
