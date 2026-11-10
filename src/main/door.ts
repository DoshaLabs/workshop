// The door: how a Claude session calls a tile. One route for every tile, POST /tile/<id> on a
// server bound to 127.0.0.1, with a bearer token core issued. Core decides who the caller is from
// the token; nothing in the request body can claim an identity. Only ops the tile's manifest
// declares are delivered, and only to a tile that is on and has said it answers that op.
// The CLI is bin/workshop-tile.mjs. CLAUDE.md §5 "The door".

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { DoorCall } from '@shared/ipc'
import type { Manifest } from '@shared/manifest'

const BODY_MAX = 64 * 1024
/** A hook's body: a PostToolUse payload carries the Bash call's output, which the CLI caps near 30,000 characters. */
const HOOK_BODY_MAX = 1024 * 1024
const RESULT_MAX = 1024 * 1024

export interface DoorHost {
  /** The manifest of a registered tile, or undefined. */
  manifest(id: string): Manifest | undefined
  /** Whether the tile is on (its page is live). */
  live(id: string): boolean
  /** The ops the live page has registered a handler for. */
  answers(id: string, op: string): boolean
  /**
   * Hands the call to one of the tile's live pages; returns a name for THAT PAGE (not the
   * instance: an instance that reloads gets a new page, and the old one going away must not fail
   * calls the new one took).
   */
  deliver(id: string, call: DoorCall): string | undefined
  /**
   * POST /hook/<name> from a session's Claude Code hooks (main/hooks.ts), with the session's token.
   * Answered 204 at once whatever happens: a hook must never wait on core.
   */
  hook?(name: string, token: string, payload: unknown): void
  /**
   * POST /core/<name>: a call to core itself from a session (the preview pane's `doc`), with the
   * session's token. Unlike a hook it is answered: the result, or the error it threw.
   */
  core?(name: string, token: string, payload: unknown): Promise<unknown>
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string }

export class Door {
  private server: Server | null = null
  /** token → who the caller is: 'outside', or a session's name (read when the call arrives). */
  private readonly callers = new Map<string, { who: () => string; session: string | null }>()
  private readonly pending = new Map<string, { tile: string; page: string; resolve: (r: Reply) => void; timer: NodeJS.Timeout }>()
  port = 0
  /** The token for callers outside any session (a terminal, the smoke test). */
  readonly token = randomBytes(24).toString('hex')

  constructor(private readonly host: DoorHost) {
    this.callers.set(this.token, { who: () => 'outside', session: null })
  }

  /** A new token whose calls are attributed to `caller`. */
  issue(caller: string): string {
    const t = randomBytes(24).toString('hex')
    this.register(t, () => caller)
    return t
  }

  /** Accept a token core made elsewhere (a session's, which outlives a restart of the app). `session` is that session's id. */
  register(token: string, who: () => string, session: string | null = null): void {
    if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('bad token')
    this.callers.set(token, { who, session })
  }

  revoke(token: string): void {
    if (token !== this.token) this.callers.delete(token)
  }

  /** The token the request carries, if core issued it. */
  private tokenOf(req: IncomingMessage): string | undefined {
    const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '')
    if (!m) return undefined
    const given = Buffer.from(m[1])
    for (const t of this.callers.keys()) if (timingSafeEqual(Buffer.from(t), given)) return t
    return undefined
  }

  /** Listens on `port` if it is free (sessions find it again after a restart), else on any. */
  async start(port = 0): Promise<number> {
    try {
      return await this.listen(port)
    } catch (err) {
      if (port === 0) throw err
      return this.listen(0)
    }
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res))
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port
        resolve(this.port)
      })
    })
  }

  stop(): void {
    this.server?.close()
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
  }

  /** A tile's page answered a call. Only the page the call went to may answer it. */
  answer(page: string, callId: string, reply: Reply): void {
    const p = this.pending.get(callId)
    if (!p || p.page !== page) return
    clearTimeout(p.timer)
    this.pending.delete(callId)
    p.resolve(reply)
  }

  /** A tile's page went away: everything it owed fails now rather than at its timeout. */
  dropPage(page: string): void {
    for (const [id, p] of this.pending) {
      if (p.page !== page) continue
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve({ ok: false, error: 'the tile closed before answering' })
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: Reply): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // A web page can POST to localhost too; refuse anything that came from a browser.
    if (req.headers.origin !== undefined) return send(403, { ok: false, error: 'not from a browser' })
    if (req.method !== 'POST') return send(404, { ok: false, error: 'POST /tile/<id>' })
    const token = this.tokenOf(req)
    if (!token) return send(401, { ok: false, error: 'no valid token (WORKSHOP_AUTH)' })
    const from = this.callers.get(token)!
    const caller = from.who()

    const hook = /^\/hook\/([a-z-]{1,32})$/.exec(req.url ?? '')
    if (hook) {
      res.writeHead(204)
      res.end()
      try {
        this.host.hook?.(hook[1], token, JSON.parse((await readBody(req, HOOK_BODY_MAX)) || '{}'))
      } catch {
        // a hook's malformed body is nobody's problem
      }
      return
    }

    const own = /^\/core\/([a-z-]{1,32})$/.exec(req.url ?? '')
    if (own) {
      if (!this.host.core) return send(404, { ok: false, error: 'POST /tile/<id>' })
      try {
        const result = await this.host.core(own[1], token, JSON.parse((await readBody(req)) || '{}'))
        return send(200, { ok: true, result })
      } catch (err) {
        return send(400, { ok: false, error: (err as Error).message })
      }
    }

    const m = /^\/tile\/([a-z0-9-]{1,40})$/.exec(req.url ?? '')
    if (!m) return send(404, { ok: false, error: 'POST /tile/<id>' })

    let body: { op?: unknown; args?: unknown }
    try {
      body = JSON.parse(await readBody(req)) as typeof body
    } catch (err) {
      return send(400, { ok: false, error: (err as Error).message })
    }
    const id = m[1]
    const op = body.op
    const args = body.args ?? []
    if (typeof op !== 'string' || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) return send(400, { ok: false, error: 'body: { "op": string, "args": string[] }' })

    const man = this.host.manifest(id)
    if (!man) return send(404, { ok: false, error: `no tile "${id}" is installed` })
    const door = man.permissions.door
    if (!door || !door.ops.includes(op)) return send(403, { ok: false, error: `the ${man.name} tile has no "${op}" op${door ? ` (it has: ${door.ops.join(', ')})` : ''}` })
    if (!this.host.live(id)) return send(409, { ok: false, error: `turn on the ${man.name} tile` })
    if (!this.host.answers(id, op)) return send(503, { ok: false, error: `the ${man.name} tile is not answering "${op}" yet` })

    const callId = randomUUID()
    const reply = await new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        resolve({ ok: false, error: `the ${man.name} tile did not answer within ${door.timeoutMs} ms` })
      }, door.timeoutMs)
      const entry = { tile: id, page: '', resolve, timer }
      this.pending.set(callId, entry)
      entry.page = this.host.deliver(id, { callId, op, args: args as string[], caller, session: from.session }) ?? ''
    })
    if (reply.ok) {
      let json: string
      try {
        json = JSON.stringify(reply.result ?? null)
      } catch {
        return send(502, { ok: false, error: 'the tile answered with something that is not JSON' })
      }
      if (json.length > RESULT_MAX) return send(502, { ok: false, error: 'the tile answered with more than 1 MB' })
    }
    send(reply.ok ? 200 : 502, reply)
  }
}

function readBody(req: IncomingMessage, max = BODY_MAX): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
