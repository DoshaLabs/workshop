// INSTALL UPDATE (carried from deck's main/updates.ts). The packaged app knows which source it
// was built from (out/build-info.json, written by scripts/stamp.mjs during `npm run dist`) and
// compares it with the repo it came from, every minute and whenever the window comes forward.
// Different = the top bar's "Install update". Installing runs `npm run dist` in the repo, swaps
// the new bundle in over the running one and relaunches it; every session lives in tmux, so
// nothing is lost but a few seconds of the window, and the new app reattaches them.
// Under `npm run dev` (and in smoke runs) there is no build info to go on, so this stays quiet.
//
// No electron import: main/index.ts hands in the bundle's path, the environment and how to quit,
// and the tests hand in a fake spawn.

import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fingerprint as realFingerprint } from '../../scripts/lib/fingerprint.mjs'
import type { AppUpdate, BuildInfo } from '@shared/update'

const CHECK_MS = 60_000

export type SpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess

export interface UpdaterOptions {
  /** What this app was built from; null = no updates offered (dev, smoke, an app built without stamp). */
  info: BuildInfo | null
  /** The environment `npm` and `git` run with: the user's shell's, so PATH finds them. */
  env: () => NodeJS.ProcessEnv
  /** Where the build's output goes, in the profile. */
  logPath: string
  onChange: (u: AppUpdate) => void
  /** The running bundle (…/workshop.app). */
  bundle: string
  /** The bundle's file name, `workshop.app`. */
  bundleName: string
  /** Quits this app (the swap waits for this pid to go). */
  quit: () => void
  pid?: number
  spawn?: SpawnLike
  fingerprint?: (repo: string, env: NodeJS.ProcessEnv) => Promise<string | null>
}

/** …/workshop.app/Contents/MacOS/workshop → …/workshop.app, or null if the exe is not in a bundle. */
export function bundleOf(exe: string): string | null {
  const b = dirname(dirname(dirname(exe)))
  return b.endsWith('.app') ? b : null
}

export class Updater {
  private state: AppUpdate = { state: 'none' }
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private readonly spawn: SpawnLike
  private readonly fp: (repo: string, env: NodeJS.ProcessEnv) => Promise<string | null>

  constructor(private readonly o: UpdaterOptions) {
    this.spawn = o.spawn ?? (realSpawn as unknown as SpawnLike)
    this.fp = o.fingerprint ?? realFingerprint
  }

  start(): void {
    if (!this.o.info || this.timer) return
    void this.check()
    this.timer = setInterval(() => void this.check(), CHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get(): AppUpdate {
    return this.state
  }

  private set(u: AppUpdate): void {
    this.state = u
    this.o.onChange(u)
  }

  private busy(): boolean {
    return this.state.state === 'building' || this.state.state === 'installing'
  }

  /** Compare the repo with what this app was built from. Never while a build runs. */
  async check(): Promise<void> {
    const info = this.o.info
    if (!info || this.checking || this.busy()) return
    this.checking = true
    try {
      const now = await this.fp(info.repo, this.o.env())
      // (the state may have moved while git ran)
      if (now === null || this.busy()) return
      // A failed build stays reported until the source changes again (or a retry succeeds).
      if (this.state.state === 'error' && this.state.fingerprint === now) return
      const next: AppUpdate = now !== info.fingerprint ? { state: 'available', fingerprint: now, builtAt: info.builtAt, repo: info.repo } : { state: 'none' }
      if (next.state !== this.state.state || next.fingerprint !== this.state.fingerprint) this.set(next)
    } finally {
      this.checking = false
    }
  }

  /** Build the repo and swap the result in over this app, then relaunch. Resolves once the build is under way. */
  async install(): Promise<void> {
    const info = this.o.info
    if (!info) throw new Error('no update source: this app was not built by `npm run dist`')
    if (this.busy()) return
    const env = this.o.env()
    const fp = (await this.fp(info.repo, env)) ?? ''
    this.set({ state: 'building', fingerprint: fp, repo: info.repo, startedAt: Date.now() })
    const log = createWriteStream(this.o.logPath, { flags: 'w' })
    log.on('error', () => {})
    log.write(`[workshop] npm run dist in ${info.repo} (${new Date().toISOString()})\n`)
    let child: ChildProcess
    try {
      child = this.spawn('npm', ['run', 'dist'], { cwd: info.repo, env: { ...env, WORKSHOP_FINGERPRINT: fp }, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      log.end()
      this.set({ state: 'error', fingerprint: fp, repo: info.repo, error: (err as Error).message })
      return
    }
    let tail = ''
    const keep = (b: Buffer): void => {
      log.write(b)
      tail = (tail + b.toString('utf8')).slice(-2000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    let done = false
    child.on('error', (err) => {
      if (done) return
      done = true
      log.end()
      this.set({ state: 'error', fingerprint: fp, repo: info.repo, error: String(err.message) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      log.end()
      if (code !== 0) {
        const last = tail.trim().split('\n').slice(-6).join('\n')
        this.set({ state: 'error', fingerprint: fp, repo: info.repo, error: `npm run dist exited ${code}\n${last}\n(full log: ${this.o.logPath})` })
        return
      }
      try {
        this.swap(info.repo)
      } catch (err) {
        this.set({ state: 'error', fingerprint: fp, repo: info.repo, error: (err as Error).message })
      }
    })
  }

  /** The new bundle replaces the running one once this process has exited, then opens. */
  private swap(repo: string): void {
    const built = newestBundle(join(repo, 'dist'), this.o.bundleName)
    if (!built) throw new Error(`the build finished but no ${this.o.bundleName} was found under ${join(repo, 'dist')}`)
    const current = this.o.bundle
    if (!current.endsWith('.app')) throw new Error(`cannot tell which bundle is running (${current})`)
    if (built === current) throw new Error(`this app runs from the build folder itself (${current}); install it to /Applications first (npm run install-app)`)
    this.set({ ...this.state, state: 'installing' })
    // A detached shell outlives us: wait for this pid to go, copy the new bundle beside the old,
    // swap the two (the old is only removed once the new one is whole), open it.
    const child = this.spawn('/bin/sh', ['-c', SWAP_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: { ...this.o.env(), PID: String(this.o.pid ?? process.pid), SRC: built, DEST: current }
    })
    child.unref()
    setTimeout(() => this.o.quit(), 300)
  }
}

/** Run by a detached /bin/sh with PID, SRC and DEST set. If the copy fails, the old app is opened again. */
export const SWAP_SCRIPT = [
  'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
  'rm -rf "$DEST.new" && ditto "$SRC" "$DEST.new" || { open "$DEST"; exit 1; }',
  'rm -rf "$DEST.old" && mv "$DEST" "$DEST.old" && mv "$DEST.new" "$DEST" && rm -rf "$DEST.old"',
  'open "$DEST"'
].join('\n')

/** The most recently built `name` one folder down in `dist` (mac-arm64/, mac/, mac-universal/…). */
export function newestBundle(dist: string, name: string): string | null {
  let best: { path: string; at: number } | null = null
  try {
    for (const d of readdirSync(dist)) {
      const p = join(dist, d, name)
      try {
        const at = statSync(p).mtimeMs
        if (!best || at > best.at) best = { path: p, at }
      } catch {
        // not here
      }
    }
  } catch {
    return null
  }
  return best?.path ?? null
}
