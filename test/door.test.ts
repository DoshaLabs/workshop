import { afterEach, describe, expect, it } from 'vitest'
import { checkManifest, type Manifest } from '@shared/manifest'
import type { DoorCall } from '@shared/ipc'
import { Door } from '../src/main/door'

const man = (() => {
  const r = checkManifest({ id: 'echo', name: 'Echo', version: '1.0.0', workshop: '^1', author: 'a', entry: 'dist/index.html', permissions: { door: { ops: ['say', 'hang'], timeoutMs: 300 } } })
  if (!r.ok) throw new Error(r.errors.join())
  return r.manifest
})()

let door: Door
let live = true
let answering = new Set(['say', 'hang'])
const delivered: DoorCall[] = []

async function start(): Promise<void> {
  door = new Door({
    manifest: (id): Manifest | undefined => (id === 'echo' ? man : undefined),
    live: () => live,
    answers: (_id, op) => answering.has(op),
    deliver: (id, call) => {
      delivered.push(call)
      if (call.op === 'say') setTimeout(() => door.answer(id, call.callId, { ok: true, result: { said: call.args, by: call.caller } }), 5)
      return id
    }
  })
  await door.start()
}

const call = async (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${door.token}` }, path = '/tile/echo') => {
  const res = await fetch(`http://127.0.0.1:${door.port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as { ok: boolean; result?: any; error?: string } }
}

afterEach(() => {
  door?.stop()
  live = true
  answering = new Set(['say', 'hang'])
  delivered.length = 0
})

describe('Door', () => {
  it('delivers a declared op and returns the answer, caller from the token', async () => {
    await start()
    const r = await call({ op: 'say', args: ['hi'], caller: 'spoofed' })
    expect(r).toEqual({ status: 200, json: { ok: true, result: { said: ['hi'], by: 'outside' } } })
  })

  it('attributes calls to the token core issued', async () => {
    await start()
    const t = door.issue('session-7')
    const r = await call({ op: 'say' }, { Authorization: `Bearer ${t}` })
    expect(r.json.result.by).toBe('session-7')
  })

  it('refuses before delivery: token, origin, op, tile off, not answering, unknown tile, bad body', async () => {
    await start()
    expect((await call({ op: 'say' }, {})).status).toBe(401)
    expect((await call({ op: 'say' }, { Authorization: `Bearer ${door.token}`, Origin: 'https://x.com' })).status).toBe(403)
    expect((await call({ op: 'nope' })).status).toBe(403)
    expect((await call({ op: 'say' }, undefined, '/tile/other')).status).toBe(404)
    expect((await call({ op: 'say', args: [1] })).status).toBe(400)
    answering = new Set()
    expect((await call({ op: 'say' })).status).toBe(503)
    live = false
    const off = await call({ op: 'say' })
    expect(off.status).toBe(409)
    expect(off.json.error).toBe('turn on the Echo tile')
    expect(delivered).toHaveLength(0)
  })

  it('times out at the manifest timeout and ignores a late or foreign answer', async () => {
    await start()
    const t0 = Date.now()
    const r = await call({ op: 'hang' })
    expect(r.status).toBe(502)
    expect(Date.now() - t0).toBeLessThan(1500)
    door.answer('echo', delivered[0].callId, { ok: true, result: 'late' }) // no throw, no effect
  })

  it('only the tile a call went to can answer it', async () => {
    await start()
    const p = call({ op: 'hang' })
    await new Promise((r) => setTimeout(r, 50))
    door.answer('someone-else', delivered[0].callId, { ok: true, result: 'stolen' })
    expect((await p).status).toBe(502)
  })

  it('fails pending calls at once when the page they went to goes away', async () => {
    await start()
    const p = call({ op: 'hang' })
    await new Promise((r) => setTimeout(r, 50))
    door.dropInstance('echo')
    expect((await p).json.error).toMatch(/closed/)
  })
})
