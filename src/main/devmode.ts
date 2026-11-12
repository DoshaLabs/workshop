// DEV MODE: the top bar's "Dev mode" on an app built from a checkout. It runs scripts/devmode.mjs
// in that repo (the user's own node, the same shell env "Install update" uses), which builds core's
// window into the profile's devmode/ folder and rebuilds it on every save; main loads the window from
// there and reloads it after each build. Core itself (main, preloads, tiles' backends) stays the
// installed one: a change there still needs "Install update".
//
// Files, not Vite's dev server: core's window has the powerful preload (it types into terminals),
// and a page from localhost could be served by whatever holds the port. A folder in the profile is
// written by this user only.
//
// No electron import: main/index.ts hands in where to build, how to load the window and the env;
// the tests hand in a fake spawn.

import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { devModeLine, type DevMode as DevModeState } from '@shared/update'

export type SpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess

export interface DevModeOptions {
  /** The checkout the app was built from; null = dev mode is not offered. */
  repo: string | null
  /** Where the window is built to (in the profile). */
  outDir: string
  env: () => NodeJS.ProcessEnv
  onChange: (s: DevModeState) => void
  /** A build finished: load (or reload) the window from this index.html. */
  load: (index: string) => void
  /** Dev mode ended: back to the window inside the app. */
  unload: () => void
  spawn?: SpawnLike
}

/** The last lines the watcher printed, for an error that says why. */
const TAIL = 6

export class DevMode {
  private s: DevModeState
  private child: ChildProcess | null = null
  private stopping = false
  private tail: string[] = []
  private readonly spawn: SpawnLike

  constructor(private readonly o: DevModeOptions) {
    this.spawn = o.spawn ?? (realSpawn as unknown as SpawnLike)
    this.s = o.repo && existsSync(join(o.repo, 'scripts', 'devmode.mjs')) ? { state: 'off', repo: o.repo } : { state: 'unavailable' }
  }

  get(): DevModeState {
    return this.s
  }

  /** Whether the window should come from the dev build now (a window opened again keeps it). */
  index(): string | null {
    return this.s.state === 'on' ? join(this.o.outDir, 'index.html') : null
  }

  set(on: boolean): void {
    if (this.s.state === 'unavailable') return
    if (on) this.start()
    else this.stop()
  }

  private put(s: DevModeState): void {
    this.s = { ...s, repo: this.o.repo ?? undefined }
    this.o.onChange(this.s)
  }

  private start(): void {
    if (this.child) return
    const repo = this.o.repo!
    this.stopping = false
    this.tail = []
    this.put({ state: 'starting' })
    let child: ChildProcess
    try {
      child = this.spawn('node', [join(repo, 'scripts', 'devmode.mjs'), this.o.outDir], { cwd: repo, env: this.o.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      this.put({ state: 'error', error: (err as Error).message })
      return
    }
    this.child = child
    const read = (line: string): void => {
      if (line.trim()) this.tail = [...this.tail, line].slice(-TAIL)
      const r = devModeLine(line)
      if (!r || this.child !== child) return
      if ('built' in r) {
        this.put({ state: 'on', builtAt: Date.now() })
        this.o.load(join(this.o.outDir, 'index.html'))
      } else if (this.s.state === 'starting') this.put({ state: 'error', error: r.failed })
      else this.put({ ...this.s, error: r.failed })
    }
    if (child.stdout) createInterface({ input: child.stdout }).on('line', read)
    if (child.stderr) createInterface({ input: child.stderr }).on('line', read)
    child.on('error', (err) => {
      if (this.child !== child) return
      this.child = null
      this.put({ state: 'error', error: err.message })
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      const was = this.s.state
      if (this.stopping) return
      // It stopped on its own: back to the app's own window, and say why.
      if (was === 'on') this.o.unload()
      this.put({ state: 'error', error: `the watcher stopped (exit ${code})\n${this.tail.join('\n')}` })
    })
  }

  private stop(): void {
    const wasOn = this.s.state === 'on'
    this.stopping = true
    const c = this.child
    this.child = null
    if (c) {
      try {
        c.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
    if (wasOn) this.o.unload()
    this.put({ state: 'off' })
  }

  /** On quit: the watcher goes with the app. */
  dispose(): void {
    this.stopping = true
    try {
      this.child?.kill('SIGTERM')
    } catch {
      // already gone
    }
    this.child = null
  }
}
