// `workshop.oauth` (bridge 1.5): core catches a sign-in's loopback redirect for a tile. A tile can
// run no server and cannot reach 127.0.0.1, so a desktop OAuth flow (RFC 8252) has nowhere to land.
// Core listens on 127.0.0.1:<port> only while a sign-in is pending, hands the tile the callback's
// query, and holds nothing else: with PKCE the code is useless without the verifier, which never
// leaves the tile, and the tile exchanges it itself through `net`.
//
// Each tile has its own redirect path, /oauth/<id>/callback. A public client has no secret, so the
// redirect URI registered with the provider is the only thing that ties a client id to a tile: with
// one shared path, any tile could sign in as another tile's app. Core makes the `state`, so a
// callback reaches only the page that started that sign-in. CLAUDE.md §5.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { hostAllowed } from '@shared/manifest'

/** The one port, the same on every Mac and every run: providers compare redirect URIs exactly. */
export const OAUTH_PORT = 47800
/** How long a sign-in waits for its callback. */
export const OAUTH_TIMEOUT_MS = 5 * 60_000

export const redirectUriFor = (id: string, port = OAUTH_PORT): string => `http://127.0.0.1:${port}/oauth/${id}/callback`

/**
 * The authorize URL a tile handed core, checked, with core's own `state` in place of any the tile
 * set. Returns the URL to open, or why it is refused. Only the authorization-code flow with PKCE
 * (S256): an implicit grant puts the token after `#`, which never reaches a server.
 */
export function checkAuthorizeUrl(raw: unknown, o: { hosts: string[] | undefined; redirectUri: string; state: string }): { url: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length > 4096) return { error: 'oauth: the authorize URL must be a string' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { error: 'oauth: not a URL' }
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return { error: 'oauth: the authorize URL must be https, with no port or user name' }
  if (!hostAllowed(u.hostname, o.hosts)) return { error: `oauth: ${u.hostname} is not in permissions.oauth` }
  const q = u.searchParams
  if (q.get('redirect_uri') !== o.redirectUri) return { error: `oauth: redirect_uri must be workshop.oauth.redirectUri (${o.redirectUri})` }
  if (q.get('response_type') !== 'code') return { error: 'oauth: response_type must be "code"' }
  if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') return { error: 'oauth: PKCE is required (code_challenge, with code_challenge_method=S256)' }
  q.set('state', o.state)
  return { url: u.toString() }
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d17;color:#e6e8f0}@media(prefers-color-scheme:light){body{background:#f6f6f8;color:#1b1d26}}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

/** Fixed pages: nothing from the tile or the query is ever written into them. */
export const PAGES = {
  done: PAGE('Signed in', 'You can close this tab and go back to workshop.'),
  refused: PAGE('Sign-in not completed', 'You can close this tab and try again from the tile in workshop.'),
  expired: PAGE('This sign-in has expired', 'Start it again from the tile in workshop.'),
  missing: PAGE('Not found', 'There is nothing here.')
}

/** Opens the URL in the browser for that tile; false if it would not (core's once-a-second limit). */
export type Opener = (tileId: string, url: string) => boolean

interface Pending {
  tileId: string
  /** Which authorize() call: the tile's latest, until it ends. */
  me: symbol
  /** The page that asked (a webContents id): its reload or close ends the sign-in. */
  page: number
  resolve(query: string): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

export class OAuthHost {
  readonly port: number
  private readonly open: Opener
  private readonly timeoutMs: number
  /** state → the sign-in it belongs to. */
  private readonly pending = new Map<string, Pending>()
  /** Each tile's latest authorize(): an older one still waiting for the listener gives way to it. */
  private readonly latest = new Map<string, { me: symbol; page: number }>()
  private server: Server | null = null
  private starting: Promise<void> | null = null

  constructor(o: { port?: number; open: Opener; timeoutMs?: number }) {
    this.port = o.port ?? OAUTH_PORT
    this.open = o.open
    this.timeoutMs = o.timeoutMs ?? OAUTH_TIMEOUT_MS
  }

  redirectUri(tileId: string): string {
    return redirectUriFor(tileId, this.port)
  }

  /** Whether the listener is up (it is only while a sign-in is pending). */
  get listening(): boolean {
    return !!this.server?.listening
  }

  get size(): number {
    return this.pending.size
  }

  /**
   * Starts a sign-in for `tileId` from page `page`: checks the URL, cancels this tile's earlier one,
   * listens, opens the browser. Resolves with the callback's query string, its `state` removed.
   */
  async authorize(tileId: string, page: number, hosts: string[] | undefined, raw: unknown): Promise<string> {
    const state = randomBytes(32).toString('base64url')
    const checked = checkAuthorizeUrl(raw, { hosts, redirectUri: this.redirectUri(tileId), state })
    if ('error' in checked) throw new Error(checked.error)
    this.cancel(tileId)
    const me = Symbol(tileId)
    this.latest.set(tileId, { me, page })
    const mine = (): boolean => this.latest.get(tileId)?.me === me
    try {
      await this.listen()
    } catch (err) {
      if (mine()) this.latest.delete(tileId)
      throw err
    }
    // Cancelled, superseded, or its page gone while the listener started.
    if (!mine()) {
      this.closeIfIdle()
      throw new Error('oauth: cancelled')
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.end(state, new Error('oauth: timed out')), this.timeoutMs)
      this.pending.set(state, { tileId, me, page, resolve, reject, timer })
      if (!this.open(tileId, checked.url)) this.end(state, new Error('oauth: the browser was not opened (one a second)'))
    })
  }

  /** Ends this tile's pending sign-in, if any. */
  cancel(tileId: string): void {
    this.latest.delete(tileId)
    for (const [state, p] of this.pending) if (p.tileId === tileId) this.end(state, new Error('oauth: cancelled'))
  }

  /** A page reloaded or went away: the sign-in it started has no one to hand the code to. */
  dropPage(page: number): void {
    for (const [id, l] of this.latest) if (l.page === page) this.latest.delete(id)
    for (const [state, p] of this.pending) if (p.page === page) this.end(state, new Error('oauth: cancelled'))
  }

  stop(): void {
    this.latest.clear()
    for (const state of [...this.pending.keys()]) this.end(state, new Error('oauth: cancelled'))
    this.close(true)
  }

  private end(state: string, err: Error | null, query = ''): void {
    const p = this.pending.get(state)
    if (!p) return
    this.pending.delete(state)
    clearTimeout(p.timer)
    if (this.latest.get(p.tileId)?.me === p.me) this.latest.delete(p.tileId)
    if (err) p.reject(err)
    else p.resolve(query)
    this.closeIfIdle()
  }

  /** Nothing pending and no sign-in on its way: the port is let go. */
  private closeIfIdle(): void {
    if (this.pending.size === 0 && this.latest.size === 0) this.close()
  }

  /** Stops listening. A response in flight still finishes (it says Connection: close); idle sockets go now. */
  private close(force = false): void {
    const s = this.server
    this.server = null
    if (!s) return
    s.close()
    if (force) s.closeAllConnections()
    else s.closeIdleConnections()
  }

  private listen(): Promise<void> {
    if (this.server?.listening) return Promise.resolve()
    if (this.starting) return this.starting
    const server = createServer((req, res) => this.answer(req, res))
    // A browser keeps a connection open; never let it hold the port after the last sign-in.
    server.keepAliveTimeout = 1000
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(new Error(err.code === 'EADDRINUSE' ? `oauth: port ${this.port} is in use` : `oauth: cannot listen (${err.code ?? err.message})`))
      })
      // IPv4 loopback only, never 0.0.0.0: nothing off this Mac can reach it.
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        resolve()
      })
    }).finally(() => (this.starting = null))
    return this.starting
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, html: string): void => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close'
      })
      res.end(html)
    }
    // The exact Host a browser sends for the redirect: anything else (a rebound DNS name) is not ours.
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${this.port}`) return send(404, PAGES.missing)
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const m = /^\/oauth\/([a-z0-9-]{1,40})\/callback$/.exec(u.pathname)
    if (!m) return send(404, PAGES.missing)
    const state = u.searchParams.get('state') ?? ''
    const p = this.pending.get(state)
    if (!p || p.tileId !== m[1]) return send(400, PAGES.expired)
    u.searchParams.delete('state')
    const query = u.searchParams.toString()
    send(200, u.searchParams.has('error') || !u.searchParams.has('code') ? PAGES.refused : PAGES.done)
    this.end(state, null, query)
  }
}
