// ACCOUNTS, step 1 (docs/progress/2026-11-12-accounts.md): who each CLI is signed in as, and Sign
// in again. Read from `claude auth status --json` and `codex login status` at start, every ten
// minutes and when the window comes forward (at most once a minute). Sign in runs the CLI's own
// `claude auth login` / `codex login` in a pty (they open the browser and wait on their own
// localhost callback); workshop sees its output text only, never a token (ground rule 4).
//
// No electron import: index.ts hands in the env and where to push; tests hand in fakes.

import { execFile } from 'node:child_process'
import * as pty from 'node-pty'
import { loginCommand, logoutCommand, parseClaudeStatus, parseCodexStatus, parseVersion, signInUrl, type AccountsState, type Cli, type SignInHow } from '@shared/accounts'

const EVERY_MS = 10 * 60_000
const FOCUS_MIN_MS = 60_000
/** A sign-in nobody finished. */
const SIGN_IN_MAX_MS = 10 * 60_000

export type Run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; out: string; missing: boolean }>

export interface PtyLike {
  onData(fn: (d: string) => void): void
  onExit(fn: (e: { exitCode: number }) => void): void
  kill(): void
}
export type SpawnPty = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => PtyLike

export interface AccountsOptions {
  env: () => NodeJS.ProcessEnv
  onChange: (s: AccountsState) => void
  run?: Run
  spawn?: SpawnPty
}

const realRun: Run = (cmd, args, env) =>
  new Promise((done) =>
    execFile(cmd, args, { env, timeout: 15_000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      done({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}${stderr}`, missing: e?.code === 'ENOENT' })
    })
  )

const realSpawn: SpawnPty = (cmd, args, env) =>
  pty.spawn(cmd, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: env.HOME ?? '/', env: env as Record<string, string> })

export class Accounts {
  private s: AccountsState = { claude: null, codex: null, signIn: null }
  private timer: NodeJS.Timeout | null = null
  private lastRead = 0
  private reading: Promise<void> | null = null
  private child: PtyLike | null = null
  private giveUp: NodeJS.Timeout | null = null
  private readonly run: Run
  private readonly spawn: SpawnPty

  constructor(private readonly o: AccountsOptions) {
    this.run = o.run ?? realRun
    this.spawn = o.spawn ?? realSpawn
  }

  get(): AccountsState {
    return this.s
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), EVERY_MS)
    this.timer.unref?.()
  }

  /** The window came forward: read again unless it was read in the last minute. */
  focused(): void {
    if (Date.now() - this.lastRead >= FOCUS_MIN_MS) void this.refresh()
  }

  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => (this.reading = null))
    return this.reading
  }

  private async read(): Promise<void> {
    this.lastRead = Date.now()
    const env = this.o.env()
    const [c, x, cv, xv] = await Promise.all([
      this.run('claude', ['auth', 'status', '--json'], env),
      this.run('codex', ['login', 'status'], env),
      this.run('claude', ['--version'], env),
      this.run('codex', ['--version'], env)
    ])
    const claudeAcc = c.missing ? null : (parseClaudeStatus(c.out) ?? this.s.claude)
    const codexAcc = x.missing ? null : parseCodexStatus(x.out, x.code)
    const claude = claudeAcc && { ...claudeAcc, version: cv.code === 0 ? parseVersion(cv.out) : claudeAcc.version }
    const codex = codexAcc && { ...codexAcc, version: xv.code === 0 ? parseVersion(xv.out) : (this.s.codex?.version ?? null) }
    this.put({ ...this.s, claude, codex })
  }

  private put(s: AccountsState): void {
    if (JSON.stringify(s) === JSON.stringify(this.s)) return
    this.s = s
    this.o.onChange(s)
  }

  /** Run the CLI's own login. One at a time; another click while one runs does nothing. */
  signIn(cli: Cli, how?: SignInHow): void {
    if (this.child) return
    const [cmd, args] = loginCommand(cli, how)
    let out = ''
    let child: PtyLike
    try {
      child = this.spawn(cmd, args, this.o.env())
    } catch (err) {
      this.put({ ...this.s, signIn: { cli, url: null, startedAt: Date.now(), error: (err as Error).message } })
      return
    }
    this.child = child
    this.put({ ...this.s, signIn: { cli, url: null, startedAt: Date.now() } })
    child.onData((d) => {
      out = (out + d).slice(-8000)
      const url = signInUrl(out)
      if (url && this.s.signIn && !this.s.signIn.url) this.put({ ...this.s, signIn: { ...this.s.signIn, url } })
    })
    child.onExit(({ exitCode }) => {
      if (this.child !== child) return
      this.end()
      void this.refresh().then(() => {
        const signedIn = this.s[cli]?.loggedIn
        // A failed or abandoned attempt keeps its reason on the head; a good one clears.
        if (exitCode === 0 && signedIn) this.put({ ...this.s, signIn: null })
        else this.put({ ...this.s, signIn: { cli, url: null, startedAt: Date.now(), error: tail(out) || `${cmd} exited ${exitCode}` } })
      })
    })
    this.giveUp = setTimeout(() => this.cancel(), SIGN_IN_MAX_MS)
    this.giveUp.unref?.()
  }

  /**
   * Run the CLI's own logout, then read status again. Sessions already running keep the login they
   * started with until the CLI next reads it. A failure keeps its reason for the accounts card.
   */
  async signOut(cli: Cli): Promise<void> {
    if (this.child) return
    const [cmd, args] = logoutCommand(cli)
    const r = await this.run(cmd, args, this.o.env())
    await this.refresh()
    this.put({ ...this.s, signOutError: r.code === 0 ? null : { cli, error: tail(r.out) || `${cmd} exited ${r.code}` } })
  }

  /** Stop a sign-in under way (or clear the last one's error). */
  cancel(): void {
    const c = this.child
    this.end()
    try {
      c?.kill()
    } catch {
      // gone
    }
    this.put({ ...this.s, signIn: null })
  }

  private end(): void {
    this.child = null
    if (this.giveUp) clearTimeout(this.giveUp)
    this.giveUp = null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const c = this.child
    this.end()
    try {
      c?.kill()
    } catch {
      // gone
    }
  }
}

/** The last few readable lines of a command's output. */
function tail(out: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '')
  return plain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join('\n')
    .slice(0, 600)
}
