import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Backends, type BackendTile, type Child } from '../src/main/backend'
import { BACKEND_ENV, backendEnv, createKit, plainJson, readFromBackend, restartDelay, type FromBackend, type ToBackend } from '../src/main/backend-protocol'

describe('the wire', () => {
  it('lets only plain JSON across, under a size', () => {
    expect(plainJson({ a: [1, 'x', null] }, 100, 'it')).toEqual({ a: [1, 'x', null] })
    expect(plainJson(undefined, 100, 'it')).toBeNull()
    expect(() => plainJson({ n: 1n }, 100, 'the body')).toThrow(/the body is not JSON/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => plainJson(cycle, 100, 'it')).toThrow(/not JSON/)
    expect(() => plainJson('x'.repeat(2000), 1024, 'it')).toThrow(/over 1 KB/)
    expect(plainJson(new Date(0), 100, 'it')).toBe('1970-01-01T00:00:00.000Z')
  })

  it('reads only our messages from a backend', () => {
    expect(readFromBackend({ type: 'ready', ops: ['a', 2] })).toEqual({ type: 'ready', ops: ['a'] })
    expect(readFromBackend({ type: 'reply', id: 3, ok: true, result: 1 })).toEqual({ type: 'reply', id: 3, ok: true, result: 1 })
    expect(readFromBackend({ type: 'reply', id: 3, ok: 'yes', error: 'no' })).toEqual({ type: 'reply', id: 3, ok: false, error: 'no' })
    expect(readFromBackend({ type: 'reply', id: '3', ok: true })).toBeNull()
    expect(readFromBackend({ type: 'sessions' })).toBeNull()
    expect(readFromBackend('ready')).toBeNull()
  })

  it('restarts soon, then later, then gives up', () => {
    expect([1, 2, 3, 4].map((n) => restartDelay(n))).toEqual([1000, 3000, 10_000, null])
    expect(restartDelay(0)).toBeNull()
  })

  it('gives a backend only the short list of variables, never core\'s', () => {
    const env = backendEnv({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x', WORKSHOP_AUTH: '/tmp/a', WORKSHOP_TILE: 'x', GH_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require x', SSH_AUTH_SOCK: '/s', USER: '' })
    expect(env).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/s', LANG: 'en_US.UTF-8' })
    expect(BACKEND_ENV.some((k) => k.startsWith('WORKSHOP'))).toBe(false)
  })
})

describe('the kit a backend.mjs is handed', () => {
  const setup = () => {
    const out: FromBackend[] = []
    const k = createKit((m) => out.push(m))
    return { out, ...k }
  }

  it('answers the ops it was given, and says which when ready', async () => {
    const { out, kit, receive, ready } = setup()
    kit.handle('status', async (body) => ({ got: body }))
    kit.handle('boom', () => {
      throw new Error('no repo here')
    })
    ready()
    expect(out.pop()).toEqual({ type: 'ready', ops: ['status', 'boom'] })
    await receive({ type: 'call', id: 1, op: 'status', body: { a: 1 } } satisfies ToBackend)
    expect(out.pop()).toEqual({ type: 'reply', id: 1, ok: true, result: { got: { a: 1 } } })
    await receive({ type: 'call', id: 2, op: 'boom', body: null })
    expect(out.pop()).toEqual({ type: 'reply', id: 2, ok: false, error: 'no repo here' })
    await receive({ type: 'call', id: 3, op: 'other', body: null })
    expect(out.pop()).toMatchObject({ id: 3, ok: false, error: expect.stringMatching(/no handler for "other"/) })
  })

  it('refuses an answer that is not JSON rather than sending half of it', async () => {
    const { out, kit, receive } = setup()
    kit.handle('fn', () => ({ f: 1n }))
    await receive({ type: 'call', id: 1, op: 'fn', body: null })
    expect(out.pop()).toMatchObject({ ok: false, error: expect.stringMatching(/not JSON/) })
  })

  it('keeps the sessions it is told, and calls onSessions', async () => {
    const { kit, receive } = setup()
    const seen: number[] = []
    const stop = kit.onSessions((l) => seen.push(l.length))
    expect(kit.sessions()).toEqual([])
    const s = { id: 'abc123', name: 'one', folder: '/p/wt', root: '/p' }
    await receive({ type: 'sessions', sessions: [s] })
    expect(kit.sessions()).toEqual([s])
    stop()
    await receive({ type: 'sessions', sessions: [] })
    expect(seen).toEqual([1])
  })
})

/** A backend process that does what the test tells it. */
class FakeChild implements Child {
  sent: ToBackend[] = []
  killed = false
  private msg: ((m: unknown) => void) | null = null
  private exit: ((code: number) => void) | null = null
  pid = Math.floor(Math.random() * 1e6)
  post(m: ToBackend): void {
    this.sent.push(m)
  }
  kill(): void {
    this.killed = true
    this.exit?.(0)
  }
  onMessage(fn: (m: unknown) => void): void {
    this.msg = fn
  }
  onExit(fn: (code: number) => void): void {
    this.exit = fn
  }
  say(m: FromBackend): void {
    this.msg?.(m)
  }
  die(code = 1): void {
    this.exit?.(code)
  }
  calls(): Extract<ToBackend, { type: 'call' }>[] {
    return this.sent.filter((m): m is Extract<ToBackend, { type: 'call' }> => m.type === 'call')
  }
}

const tile = (over: Partial<BackendTile> = {}): BackendTile => ({ id: 'git', name: 'Git', program: '/app/tiles/git/backend.mjs', root: '/app/tiles/git', decl: { entry: 'backend.mjs', ops: ['status', 'diff'], timeoutMs: 1000 }, ...over })

describe('a backend\'s life', () => {
  let children: FakeChild[]
  let statuses: string[]
  let b: Backends
  const last = (): FakeChild => children[children.length - 1]
  beforeEach(() => {
    vi.useFakeTimers()
    children = []
    statuses = []
    b = new Backends({
      spawn: () => {
        const c = new FakeChild()
        children.push(c)
        return c
      },
      onStatus: (_id, s) => statuses.push(s.state),
      delays: [100, 200, 300],
      stableMs: 10_000
    })
  })
  afterEach(() => {
    b.stopAll()
    vi.useRealTimers()
  })

  it('starts when its tile is on and stops when it is off', () => {
    b.sync([tile()])
    expect(children).toHaveLength(1)
    expect(b.status('git').state).toBe('starting')
    b.sync([tile()])
    expect(children).toHaveLength(1)
    b.sync([])
    expect(last().killed).toBe(true)
    expect(b.status('git').state).toBe('stopped')
    expect(statuses).toEqual(['starting', 'stopped'])
  })

  it('holds calls until it is ready, then hears the sessions first', async () => {
    b.setSessions([{ id: 'a1b2c3', name: 'one', folder: '/p', root: '/p' }])
    b.sync([tile()])
    const p = b.call('git', 'status', { path: '.' })
    expect(last().calls()).toEqual([])
    last().say({ type: 'ready', ops: ['status'] })
    expect(last().sent[0]).toEqual({ type: 'sessions', sessions: [{ id: 'a1b2c3', name: 'one', folder: '/p', root: '/p' }] })
    const c = last().calls()[0]
    expect(c).toMatchObject({ op: 'status', body: { path: '.' } })
    last().say({ type: 'reply', id: c.id, ok: true, result: { clean: true } })
    await expect(p).resolves.toEqual({ clean: true })
  })

  it('passes on every change to the sessions, and only what a backend may know of them', () => {
    b.sync([tile()])
    last().say({ type: 'ready', ops: [] })
    b.setSessions([{ id: 'a1b2c3', name: 'one', folder: '/p', root: '/p', token: 'secret' } as never])
    expect(last().sent.at(-1)).toEqual({ type: 'sessions', sessions: [{ id: 'a1b2c3', name: 'one', folder: '/p', root: '/p' }] })
  })

  it('refuses an op the manifest does not list before the backend hears of it', async () => {
    b.sync([tile()])
    last().say({ type: 'ready', ops: ['status', 'rm'] })
    await expect(b.call('git', 'rm', {})).rejects.toThrow(/"rm" is not one of this tile's backend ops \(status, diff\)/)
    await expect(b.call('other', 'status', {})).rejects.toThrow(/not running/)
    await expect(b.call('git', 'status', { n: 1n })).rejects.toThrow(/the body is not JSON/)
    expect(last().calls().map((c) => c.op)).not.toContain('rm')
  })

  it('gives up on a call after the manifest\'s timeout, and ignores the late answer', async () => {
    b.sync([tile()])
    last().say({ type: 'ready', ops: ['status'] })
    const p = b.call('git', 'status', null)
    const late = expect(p).rejects.toThrow(/did not answer "status" within 1000 ms/)
    vi.advanceTimersByTime(1001)
    await late
    last().say({ type: 'reply', id: last().calls()[0].id, ok: true, result: 1 })
  })

  it('passes a backend\'s error on as the call\'s', async () => {
    b.sync([tile()])
    last().say({ type: 'ready', ops: ['status'] })
    const p = b.call('git', 'status', null)
    last().say({ type: 'reply', id: last().calls()[0].id, ok: false, error: 'not a git repository' })
    await expect(p).rejects.toThrow('not a git repository')
  })

  it('restarts after a crash, with the calls it owed failed and the ones waiting carried over', async () => {
    b.sync([tile()])
    last().say({ type: 'ready', ops: ['status'] })
    const owed = b.call('git', 'status', 1)
    const first = last()
    first.die(1)
    await expect(owed).rejects.toThrow(/stopped before answering \(exited with code 1\)/)
    expect(b.status('git')).toEqual({ state: 'restarting', error: 'exited with code 1' })
    const waiting = b.call('git', 'status', 2)
    vi.advanceTimersByTime(100)
    expect(children).toHaveLength(2)
    last().say({ type: 'ready', ops: ['status'] })
    const c = last().calls()[0]
    expect(c.body).toBe(2)
    last().say({ type: 'reply', id: c.id, ok: true, result: 'ok' })
    await expect(waiting).resolves.toBe('ok')
    expect(statuses).toEqual(['starting', 'running', 'restarting', 'starting', 'running'])
  })

  it('says why it could not start, when the backend said so before dying', () => {
    b.sync([tile()])
    last().say({ type: 'fatal', error: 'Cannot find module ./lib.mjs' })
    last().die(1)
    expect(b.status('git').error).toBe('Cannot find module ./lib.mjs')
  })

  it('gives up after a few quick crashes, tells the page, and tries again only when turned off and on', async () => {
    b.sync([tile()])
    for (const delay of [100, 200, 300]) {
      last().die(1)
      vi.advanceTimersByTime(delay)
    }
    last().die(1)
    expect(children).toHaveLength(4)
    expect(b.status('git')).toEqual({ state: 'failed', error: 'it stopped 4 times in a row; the last time it exited with code 1' })
    await expect(b.call('git', 'status', null)).rejects.toThrow(/the Git backend stopped: it stopped 4 times/)
    vi.advanceTimersByTime(10_000)
    b.sync([tile()])
    expect(children).toHaveLength(4)
    b.sync([])
    b.sync([tile()])
    expect(children).toHaveLength(5)
    expect(b.status('git').state).toBe('starting')
  })

  it('counts again after a run that lasted', () => {
    b.sync([tile()])
    last().die(1)
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(20_000)
    last().die(1)
    expect(b.status('git').state).toBe('restarting')
    vi.advanceTimersByTime(100)
    expect(children).toHaveLength(3)
  })

  it('does not restart one that was turned off while it waited to', () => {
    b.sync([tile()])
    last().die(1)
    b.sync([])
    vi.advanceTimersByTime(1000)
    expect(children).toHaveLength(1)
    expect(b.status('git').state).toBe('stopped')
  })

  it('fails what was waiting when its tile is turned off', async () => {
    b.sync([tile()])
    const p = b.call('git', 'status', null)
    b.sync([])
    await expect(p).rejects.toThrow(/turned off/)
  })

  it('replaces the process when the tile comes back with another backend', () => {
    b.sync([tile()])
    b.sync([tile({ decl: { entry: 'backend.mjs', ops: ['status'], timeoutMs: 1000 } })])
    expect(children).toHaveLength(2)
    expect(children[0].killed).toBe(true)
  })

  it('stops them all when core quits', () => {
    b.sync([tile(), tile({ id: 'spotify', name: 'Spotify' })])
    b.stopAll()
    expect(children.every((c) => c.killed)).toBe(true)
  })
})
