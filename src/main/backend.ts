// The trusted tier: one process per built-in tile that declares a backend, run beside its page.
// It starts when the tile is turned on and stops when it is turned off or core quits (there is no
// background flag). The page reaches it only through `workshop.backend.call(op, body)`; core
// refuses an op the manifest does not list before the backend hears of it. A backend that dies is
// started again, soon, then later, and after a few quick deaths core gives up and tells the page.
// The process gets a clean environment and the list of sessions, never a token. CLAUDE.md §5.
//
// No electron import: index.ts hands in the spawner (utilitySpawn, with electron's utilityProcess),
// so the unit tests drive this with a fake process.

import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { BackendDecl } from '@shared/manifest'
import { BODY_MAX, RESULT_MAX, STABLE_MS, plainJson, readFromBackend, restartDelay, type BackendSession, type FromBackend, type ToBackend } from './backend-protocol'

export type { BackendSession }

/** What core knows of a tile with a backend. */
export interface BackendTile {
  id: string
  name: string
  /** backend.mjs (real path, inside the tile's folder). */
  program: string
  /** The tile's folder: the backend's working directory. */
  root: string
  decl: BackendDecl
}

/** A running backend, as the lifecycle sees it. */
export interface Child {
  post(m: ToBackend): void
  kill(): void
  onMessage(fn: (m: unknown) => void): void
  /** Once, when the process is gone (killed or crashed). */
  onExit(fn: (code: number) => void): void
  pid?: number
}

export type Spawn = (tile: BackendTile) => Child

export type BackendState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped'
/** What a page is told of its backend (`workshop.backend.status()` and `onStatus`). */
export interface BackendStatus {
  state: BackendState
  /** Why it is not running, when it is failed or restarting. */
  error?: string
}

interface Pending {
  op: string
  body: unknown
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  sent: boolean
}

interface Run {
  tile: BackendTile
  child: Child | null
  state: BackendState
  error?: string
  startedAt: number
  crashes: number
  restartTimer?: NodeJS.Timeout
  stopping: boolean
  pending: Map<number, Pending>
}

export interface BackendsOptions {
  spawn: Spawn
  /** A tile's backend changed state: core passes it to the tile's pages. */
  onStatus?: (id: string, status: BackendStatus) => void
  /** Delays before each restart; one more death than this gives up (backend-protocol.ts). */
  delays?: number[]
  stableMs?: number
}

export class Backends {
  private readonly runs = new Map<string, Run>()
  private sessions: BackendSession[] = []
  private nextId = 1

  constructor(private readonly o: BackendsOptions) {}

  /**
   * The tiles whose backends should be running now (built in, declaring one, turned on). Starts
   * the new ones, stops the ones no longer listed. A failed backend listed again stays failed:
   * turning its tile off and on is what tries again.
   */
  sync(wanted: BackendTile[]): void {
    const ids = new Set(wanted.map((t) => t.id))
    for (const id of [...this.runs.keys()]) if (!ids.has(id)) this.stop(id)
    for (const t of wanted) {
      const run = this.runs.get(t.id)
      if (!run) this.start(t)
      else if (run.tile.program !== t.program || JSON.stringify(run.tile.decl) !== JSON.stringify(t.decl)) {
        // The tile was loaded again with another backend: the old one goes, the new one starts.
        this.stop(t.id)
        this.start(t)
      }
    }
  }

  /** The sessions changed: every backend hears the whole list. */
  setSessions(list: BackendSession[]): void {
    this.sessions = list.map((s) => ({ id: s.id, name: s.name, folder: s.folder, root: s.root, status: s.status }))
    for (const run of this.runs.values()) if (run.child && run.state === 'running') run.child.post({ type: 'sessions', sessions: this.sessions })
  }

  status(id: string): BackendStatus {
    const run = this.runs.get(id)
    if (!run) return { state: 'stopped' }
    return run.error ? { state: run.state, error: run.error } : { state: run.state }
  }

  /** The process id of a running backend (the smoke test checks it is gone after turn-off). */
  pid(id: string): number | undefined {
    return this.runs.get(id)?.child?.pid
  }

  /**
   * One call from the page. Refused here, before the backend hears of it, if the op is not in the
   * manifest or the body is not plain JSON. Waits while the backend starts or restarts, within the
   * same timeout.
   */
  call(id: string, op: string, body: unknown): Promise<unknown> {
    const run = this.runs.get(id)
    if (!run) return Promise.reject(new Error('this tile\'s backend is not running (turn the tile on)'))
    const { decl, name } = run.tile
    if (typeof op !== 'string' || !decl.ops.includes(op)) return Promise.reject(new Error(`backend.call: "${op}" is not one of this tile's backend ops (${decl.ops.join(', ')})`))
    if (run.state === 'failed') return Promise.reject(new Error(`the ${name} backend stopped: ${run.error ?? 'it kept crashing'}`))
    let clean: unknown
    try {
      clean = plainJson(body, BODY_MAX, 'backend.call: the body')
    } catch (err) {
      return Promise.reject(err)
    }
    const callId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(callId)
        reject(new Error(`the ${name} backend did not answer "${op}" within ${decl.timeoutMs} ms`))
      }, decl.timeoutMs)
      const p: Pending = { op, body: clean, resolve, reject, timer, sent: false }
      run.pending.set(callId, p)
      if (run.state === 'running') this.send(run, callId, p)
    })
  }

  /** Every backend stops (core is quitting). */
  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id)
  }

  private send(run: Run, id: number, p: Pending): void {
    p.sent = true
    run.child!.post({ type: 'call', id, op: p.op, body: p.body })
  }

  private setState(run: Run, state: BackendState, error?: string): void {
    run.state = state
    run.error = error
    this.o.onStatus?.(run.tile.id, this.status(run.tile.id))
  }

  private start(tile: BackendTile, carried?: Run): void {
    const run: Run = carried ?? { tile, child: null, state: 'starting', startedAt: 0, crashes: 0, stopping: false, pending: new Map() }
    this.runs.set(tile.id, run)
    run.startedAt = Date.now()
    run.stopping = false
    this.setState(run, 'starting', carried?.error)
    let child: Child
    try {
      child = this.o.spawn(tile)
    } catch (err) {
      this.failAll(run, `the ${tile.name} backend could not start: ${(err as Error).message}`)
      this.setState(run, 'failed', (err as Error).message)
      return
    }
    run.child = child
    let fatal: string | undefined
    child.onMessage((raw) => {
      if (run.child !== child) return
      const m = readFromBackend(raw)
      if (m) this.receive(run, m, (e) => (fatal = e))
    })
    child.onExit((code) => {
      if (run.child !== child) return
      run.child = null
      if (run.stopping) return
      this.crashed(run, fatal ?? `exited with code ${code}`)
    })
  }

  private receive(run: Run, m: FromBackend, setFatal: (e: string) => void): void {
    if (m.type === 'fatal') return setFatal(m.error)
    if (m.type === 'ready') {
      this.setState(run, 'running')
      run.child!.post({ type: 'sessions', sessions: this.sessions })
      for (const [id, p] of run.pending) if (!p.sent) this.send(run, id, p)
      return
    }
    const p = run.pending.get(m.id)
    if (!p) return
    clearTimeout(p.timer)
    run.pending.delete(m.id)
    if (!m.ok) return p.reject(new Error(m.error))
    try {
      p.resolve(plainJson(m.result, RESULT_MAX, 'the backend\'s answer'))
    } catch (err) {
      p.reject(err as Error)
    }
  }

  /** Calls already sent die with the process; calls not yet sent wait for the restart. */
  private failSent(run: Run, why: string): void {
    for (const [id, p] of run.pending) {
      if (!p.sent) continue
      clearTimeout(p.timer)
      run.pending.delete(id)
      p.reject(new Error(why))
    }
  }

  private failAll(run: Run, why: string): void {
    for (const p of run.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(why))
    }
    run.pending.clear()
  }

  private crashed(run: Run, why: string): void {
    const { name } = run.tile
    this.failSent(run, `the ${name} backend stopped before answering (${why})`)
    if (Date.now() - run.startedAt >= (this.o.stableMs ?? STABLE_MS)) run.crashes = 0
    run.crashes++
    const delay = restartDelay(run.crashes, this.o.delays)
    if (delay === null) {
      const error = `it stopped ${run.crashes} times in a row; the last time it ${why}`
      this.failAll(run, `the ${name} backend stopped: ${error}`)
      this.setState(run, 'failed', error)
      return
    }
    this.setState(run, 'restarting', why)
    run.restartTimer = setTimeout(() => {
      run.restartTimer = undefined
      if (this.runs.get(run.tile.id) === run && !run.stopping) this.start(run.tile, run)
    }, delay)
  }

  private stop(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    run.stopping = true
    clearTimeout(run.restartTimer)
    this.runs.delete(id)
    this.failAll(run, `the ${run.tile.name} tile was turned off`)
    run.child?.kill()
    run.child = null
    run.state = 'stopped'
    run.error = undefined
    this.o.onStatus?.(id, { state: 'stopped' })
  }
}

/** A log over this size is moved to `<name>.1` (the one before is dropped) when the backend starts. */
const LOG_MAX = 1024 * 1024

/** Appends to the tile's log in the profile, keeping one older file. */
export function openLog(dir: string, id: string): WriteStream {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `backend-${id}.log`)
  try {
    if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`)
  } catch {
    // no log yet
  }
  return createWriteStream(file, { flags: 'a', mode: 0o600 })
}

/** The part of electron's utilityProcess this needs (index.ts passes the real one). */
export interface UtilityProcessLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: { env?: Record<string, string>; cwd?: string; stdio?: 'pipe'; serviceName?: string }
  ): {
    pid?: number
    stdout: NodeJS.ReadableStream | null
    stderr: NodeJS.ReadableStream | null
    postMessage(m: unknown): void
    kill(): boolean
    on(ev: 'message', fn: (m: unknown) => void): unknown
    once(ev: 'exit', fn: (code: number) => void): unknown
  }
}

/**
 * The real spawner: backend-host.js in a utility process, the tile's program as its argument, the
 * tile's folder as its working directory, `env` as its whole environment, its output in the log.
 */
export function utilitySpawn(up: UtilityProcessLike, host: string, logDir: string, env: () => Record<string, string>): Spawn {
  return (tile) => {
    const log = openLog(logDir, tile.id)
    log.write(`--- ${new Date().toISOString()} starting ${tile.program}\n`)
    const p = up.fork(host, [tile.program], { env: env(), cwd: tile.root, stdio: 'pipe', serviceName: `workshop backend: ${tile.id}` })
    p.stdout?.pipe(log, { end: false })
    p.stderr?.pipe(log, { end: false })
    let exited = false
    const exitFns: ((code: number) => void)[] = []
    p.once('exit', (code) => {
      exited = true
      log.write(`--- ${new Date().toISOString()} exited with code ${code}\n`)
      // Let what the pipes still hold reach the file first.
      setTimeout(() => log.end(), 100)
      for (const fn of exitFns) fn(code)
    })
    return {
      // Known only once the process has spawned, so read when asked.
      get pid() {
        return p.pid
      },
      post: (m) => {
        if (!exited) p.postMessage(m)
      },
      kill: () => {
        if (!exited) p.kill()
      },
      onMessage: (fn) => void p.on('message', fn),
      onExit: (fn) => void exitFns.push(fn)
    }
  }
}
