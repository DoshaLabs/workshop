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
const RESULT_MAX = 1024 * 1024

export interface DoorHost {
  /** The manifest of a registered tile, or undefined. */
  manifest(id: string): Manifest | undefined
  /** Whether the tile is on (its page is live). */
  live(id: string): boolean
  /** The ops the live page has registered a handler for. */
  answers(id: string, op: string): boolean
  /** Hands the call to the tile's page. */
  deliver(id: string, call: DoorCall): void
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string }

export class Door {
  private server: Server | null = null
  /** token → caller name. Sessions get their own when they exist (roadmap step 3). */
  private readonly callers = new Map<string, string>()
  private readonly pending = new Map<string, { tile: string; resolve: (r: Reply) => void; timer: NodeJS.Timeout }>()
  port = 0
  /** The token for callers outside any session (a terminal, the smoke test). */
  readonly token = randomBytes(24).toString('hex')

  constructor(private readonly host: DoorHost) {
    this.callers.set(this.token, 'outside')
  }

  /** A token whose calls are attributed to `caller`. */
  issue(caller: string): string {
    const t = randomBytes(24).toString('hex')
    this.callers.set(t, caller)
    return t
  }

  private callerOf(req: IncomingMessage): string | undefined {
    const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '')
    if (!m) return undefined
    const given = Buffer.from(m[1])
    for (const [t, who] of this.callers) if (timingSafeEqual(Buffer.from(t), given)) return who
    return undefined
  }

  start(port = 0): Promise<number> {
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

  /** The tile's page answered a call. Only the tile the call went to may answer it. */
  answer(tileId: string, callId: string, reply: Reply): void {
    const p = this.pending.get(callId)
    if (!p || p.tile !== tileId) return
    clearTimeout(p.timer)
    this.pending.delete(callId)
    p.resolve(reply)
  }

  /** The tile went away: everything it owed fails now rather than at its timeout. */
  dropTile(tileId: string): void {
    for (const [id, p] of this.pending) {
      if (p.tile !== tileId) continue
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
    const m = /^\/tile\/([a-z0-9-]{1,40})$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return send(404, { ok: false, error: 'POST /tile/<id>' })
    const caller = this.callerOf(req)
    if (!caller) return send(401, { ok: false, error: 'no valid token (WORKSHOP_TOKEN)' })

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
      this.pending.set(callId, { tile: id, resolve, timer })
      this.host.deliver(id, { callId, op, args: args as string[], caller })
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_MAX) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
