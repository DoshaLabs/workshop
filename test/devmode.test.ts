import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DevMode, type SpawnLike } from '../src/main/devmode'
import { devModeLine, type DevMode as State } from '../src/shared/update'

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'ws-devmode-'))
  mkdirSync(join(r, 'scripts'))
  writeFileSync(join(r, 'scripts', 'devmode.mjs'), '')
  return r
}

function fake() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: [] as string[], kill(sig: string) { this.killed.push(sig) } })
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = []
  const spawn: SpawnLike = (cmd, args, opts) => (calls.push({ cmd, args, opts }), child as never)
  return { child, calls, spawn }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

function make(r: string | null, f = fake()) {
  const states: State[] = []
  const loads: string[] = []
  let unloads = 0
  const d = new DevMode({ repo: r, outDir: '/p/devmode', env: () => ({ PATH: '/x' }), onChange: (s) => states.push(s), load: (i) => loads.push(i), unload: () => unloads++, spawn: f.spawn })
  return { d, f, states, loads, unloads: () => unloads }
}

describe('devModeLine', () => {
  it('reads the watcher\'s two lines and nothing else', () => {
    expect(devModeLine('WORKSHOP_DEVMODE_BUILT')).toEqual({ built: true })
    expect(devModeLine('WORKSHOP_DEVMODE_ERROR x.tsx: bad')).toEqual({ failed: 'x.tsx: bad' })
    expect(devModeLine('WORKSHOP_DEVMODE_ERROR')).toEqual({ failed: 'the build failed' })
    expect(devModeLine('vite v7 building…')).toBeNull()
  })
})

describe('DevMode', () => {
  it('is not offered without a checkout that has the script', () => {
    expect(make(null).d.get().state).toBe('unavailable')
    expect(make(mkdtempSync(join(tmpdir(), 'ws-none-'))).d.get().state).toBe('unavailable')
    const m = make(null)
    m.d.set(true)
    expect(m.f.calls).toHaveLength(0)
  })

  it('runs the repo\'s watcher, loads on the first build and reloads on the next', async () => {
    const r = repo()
    const m = make(r)
    m.d.set(true)
    expect(m.d.get().state).toBe('starting')
    expect(m.f.calls[0]).toMatchObject({ cmd: 'node', args: [join(r, 'scripts', 'devmode.mjs'), '/p/devmode'], opts: { cwd: r, env: { PATH: '/x' } } })
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\n')
    await tick()
    expect(m.d.get().state).toBe('on')
    expect(m.d.index()).toBe('/p/devmode/index.html')
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\n')
    await tick()
    expect(m.loads).toEqual(['/p/devmode/index.html', '/p/devmode/index.html'])
  })

  it('keeps the last good page when a save does not build', async () => {
    const m = make(repo())
    m.d.set(true)
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\nWORKSHOP_DEVMODE_ERROR Unexpected token\n')
    await tick()
    expect(m.d.get()).toMatchObject({ state: 'on', error: 'Unexpected token' })
    expect(m.loads).toHaveLength(1)
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\n')
    await tick()
    expect(m.d.get().error).toBeUndefined()
  })

  it('a first build that fails is an error, and nothing is loaded', async () => {
    const m = make(repo())
    m.d.set(true)
    m.f.child.stdout.write('WORKSHOP_DEVMODE_ERROR no vite\n')
    await tick()
    expect(m.d.get()).toMatchObject({ state: 'error', error: 'no vite' })
    expect(m.loads).toHaveLength(0)
  })

  it('off stops the watcher and goes back to the installed window', async () => {
    const m = make(repo())
    m.d.set(true)
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\n')
    await tick()
    m.d.set(false)
    expect(m.f.child.killed).toEqual(['SIGTERM'])
    expect(m.unloads()).toBe(1)
    expect(m.d.get().state).toBe('off')
    expect(m.d.index()).toBeNull()
    m.f.child.emit('exit', 0)
    expect(m.d.get().state).toBe('off')
  })

  it('a watcher that dies goes back to the installed window and says why', async () => {
    const m = make(repo())
    m.d.set(true)
    m.f.child.stdout.write('WORKSHOP_DEVMODE_BUILT\nsomething broke\n')
    await tick()
    m.f.child.emit('exit', 1)
    expect(m.unloads()).toBe(1)
    expect(m.d.get().state).toBe('error')
    expect(m.d.get().error).toMatch(/exit 1[\s\S]*something broke/)
  })
})
