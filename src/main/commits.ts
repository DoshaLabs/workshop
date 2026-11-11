// Which session made a commit, where that can be known exactly. Every Claude Code session runs a
// PostToolUse hook on its Bash calls (main/hooks.ts) that posts the call to core, and core sees a
// Codex session's commands as `commandExecution` items on its app-server (main/codex-link.ts);
// both become one neutral ShellCall (`claudeShellCall`, `codexShellCall`). When the call made a commit
// (the CLI says so in `tool_response.gitOperation`, or the command is one of git's that commit),
// core reads the new entries of HEAD's reflog in the folder the session is in and records each
// commit's sha against that session. The Git tile's History tab reads the records (through its
// backend) and tags those commits exactly; the rest it can only guess (tiles/git/lib/log.mjs).
//
// What is kept: the sha, the session's id and name, and when. Never the command (it can hold a
// password or a token), its output, or the folder. The store is one JSON file in the profile,
// written atomically, capped and pruned (STORE_MAX, STORE_DAYS).
//
// The PostToolUse payload as Claude Code 2.1.322 sends it (seen 10 Nov 2026, docs/progress/
// 2026-11-10-history.md): session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
// hook_event_name, tool_name, tool_input { command, description }, tool_response { stdout,
// stderr, interrupted, isImage, noOutputExpected, gitOperation? }, tool_use_id, duration_ms.
// `gitOperation` is { commit: { sha (short), kind: "committed", branch } } after a commit.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { codexShell } from '@shared/codex'

/** One commit core saw a session make. */
export interface CommitRecord {
  sha: string
  /** Core's session id (6 hex). */
  session: string
  /** The session's name when it made the commit. */
  name: string
  /** When core recorded it (ms). */
  at: number
}

/** At most this many records are kept; past it the oldest go. */
export const STORE_MAX = 5000
/** Records older than this many days go first. */
export const STORE_DAYS = 90
/** A Bash call may run up to ten minutes; with no duration in the payload, reflog entries this old still count. */
const DEFAULT_WINDOW_MS = 10 * 60_000
/** The reflog's times are whole seconds: an entry may read up to a second after the call ended. */
const SLACK_MS = 1000
/** Folders a single call is looked at in: its cwd, plus a few named with `git -C` or `cd`. */
const MAX_DIRS = 4

// ---- which commands commit

const COMMITTING = ['commit', 'merge', 'cherry-pick', 'rebase', 'revert', 'am', 'pull']

/**
 * Whether a shell command runs one of git's subcommands that can make commits: commit, merge,
 * cherry-pick, rebase, revert, am, pull. Global options before the subcommand (`-C dir`,
 * `-c k=v`, `--no-pager`) are allowed. A false positive costs one reflog read that finds nothing.
 */
export function isCommitCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  const re = new RegExp(String.raw`(?:^|[\s;&|(\x60$])git(?:\s+(?:-[cC]\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+(?:${COMMITTING.join('|')})(?![\w-])`)
  return re.test(cmd)
}

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, '$2')

/** The folders a command works in: `cwd`, then those named by `git -C <dir>` and `cd <dir>`, resolved against it. */
export function commandDirs(cmd: string, cwd: string): string[] {
  const dirs = [cwd]
  const add = (d: string): void => {
    const p = unquote(d)
    if (!p || p.startsWith('~') || p.includes('$')) return
    const abs = isAbsolute(p) ? p : resolve(cwd, p)
    if (!dirs.includes(abs)) dirs.push(abs)
  }
  for (const m of cmd.matchAll(/\bgit\s+(?:[^;&|]*?\s)?-C\s+("[^"]*"|'[^']*'|\S+)/g)) add(m[1])
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) add(m[1])
  return dirs.slice(0, MAX_DIRS)
}

// ---- the reflog

export interface ReflogEntry {
  sha: string
  /** When HEAD moved (ms; the reflog keeps seconds). */
  at: number
  /** git's reflog message: "commit: …", "merge x: Fast-forward", "rebase (pick): …". */
  message: string
}

/** `git log -g -z --date=unix --format=%H%x1f%gd%x1f%gs HEAD` → entries, newest first. */
export function parseReflog(z: string): ReflogEntry[] {
  const out: ReflogEntry[] = []
  for (const rec of z.split('\0')) {
    const r = rec.replace(/^\n/, '')
    if (!r) continue
    const [sha, sel, ...msg] = r.split('\x1f')
    const t = /@\{(\d+)\}$/.exec(sel ?? '')
    if (!/^[0-9a-f]{40,64}$/.test(sha ?? '') || !t) continue
    out.push({ sha, at: Number(t[1]) * 1000, message: msg.join('\x1f') })
  }
  return out
}

/**
 * Whether a reflog entry is HEAD moving to a commit made then and there: a commit (initial, amend,
 * merge), a merge that made a merge commit, a cherry-pick, a revert, a rebase's picked commits,
 * am, a pull that merged. Not a fast-forward (the commits came from elsewhere), a checkout, a
 * reset, or a rebase starting or finishing (HEAD moving to commits that already existed).
 */
export function madeCommit(message: string): boolean {
  if (/Fast-forward/i.test(message)) return false
  if (/\((start|finish|abort)\)/.test(message)) return false
  return /^(commit|merge|cherry-pick|revert|rebase|am|pull)\b/.test(message)
}

/** The env git runs with: nothing pointing it at another repository, and no optional locks. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES)$/.test(k)))
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['--no-pager', '-c', 'color.ui=false', '-C', cwd, ...args], { timeout: 5000, maxBuffer: 1 << 20, env: gitEnv() }, (err, out) => done(err ? null : out))
  })
}

/** HEAD's reflog in `dir`, newest first (the last 100 moves). Empty when it is not a repository or keeps no reflog. */
export async function readReflog(dir: string): Promise<ReflogEntry[]> {
  const out = await git(dir, ['log', '-g', '-z', '-n', '100', '--date=unix', '--format=%H%x1f%gd%x1f%gs', 'HEAD', '--'])
  return out ? parseReflog(out) : []
}

/** A commit's full sha in `dir`, from what the CLI reported (a short one), or null. */
async function fullSha(dir: string, short: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/.test(short)) return null
  const out = await git(dir, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`])
  const sha = out?.trim() ?? ''
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

// ---- the store

/**
 * The records, kept in `<profile>/commits.json` as { format: 1, commits: [[sha, session, name, at], …] }.
 * Read once at start (a missing or broken file is an empty store: these are tags, not work, so a
 * broken file is set aside rather than kept), written atomically (a temp file renamed over it),
 * one write at a time. A sha is recorded once: the first session to claim it keeps it.
 */
export class CommitStore {
  private list: CommitRecord[] = []
  private readonly shas = new Set<string>()
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly opts: { max?: number; days?: number; now?: () => number } = {}
  ) {
    this.list = this.read()
    this.prune()
    for (const r of this.list) this.shas.add(r.sha)
  }

  private read(): CommitRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { format?: number; commits?: unknown[] }
      if (raw?.format !== 1 || !Array.isArray(raw.commits)) throw new Error('not format 1')
      return raw.commits
        .filter((c): c is [string, string, string, number] => Array.isArray(c) && typeof c[0] === 'string' && typeof c[1] === 'string' && typeof c[2] === 'string' && typeof c[3] === 'number')
        .map(([sha, session, name, at]) => ({ sha, session, name, at }))
    } catch (err) {
      console.warn(`[workshop] ${this.file} could not be read (${(err as Error).message}); starting empty`)
      return []
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Drops records past the age limit, then the oldest past the cap. Says whether any went. */
  private prune(): boolean {
    const before = this.list.length
    const cutoff = this.now() - (this.opts.days ?? STORE_DAYS) * 86_400_000
    this.list = this.list.filter((r) => r.at >= cutoff)
    this.list.sort((a, b) => a.at - b.at)
    const max = this.opts.max ?? STORE_MAX
    if (this.list.length > max) this.list = this.list.slice(this.list.length - max)
    if (this.list.length !== before) {
      this.shas.clear()
      for (const r of this.list) this.shas.add(r.sha)
      return true
    }
    return false
  }

  all(): CommitRecord[] {
    return this.list.map((r) => ({ ...r }))
  }

  has(sha: string): boolean {
    return this.shas.has(sha)
  }

  /** Adds the records whose shas are new; returns the ones added. Written before it resolves. */
  async add(records: CommitRecord[]): Promise<CommitRecord[]> {
    const fresh = records.filter((r) => !this.shas.has(r.sha) && (this.shas.add(r.sha), true))
    if (!fresh.length) return []
    this.list.push(...fresh)
    this.prune()
    await this.save()
    return fresh
  }

  /** Waits for the writes asked for so far. */
  flushed(): Promise<void> {
    return this.chain
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ format: 1, commits: this.list.map((r) => [r.sha, r.session, r.name, r.at]) })
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${this.file}.${process.pid}.tmp`
        await writeFile(tmp, body, { mode: 0o600 })
        await rename(tmp, this.file)
      })
    return this.chain.catch((err) => console.warn(`[workshop] could not write ${this.file}: ${(err as Error).message}`))
  }
}

// ---- a shell call, from either CLI

/** A shell command a session ran, as the recorder needs it. Never stored. */
export interface ShellCall {
  command: string
  /** The folder it ran in (absolute). */
  cwd: string
  /** How long it ran, when known; else the window is DEFAULT_WINDOW_MS. */
  durationMs?: number | null
  /** The commit the CLI itself says it made (Claude Code's `gitOperation`), a short sha. */
  saidSha?: string
  /** When it ended (ms), if not just now: a Codex command read back at its turn's end. */
  endedAt?: number
}

/** What core reads of a PostToolUse payload; everything else in it (the output) is ignored. */
interface ToolPayload {
  tool_name?: unknown
  cwd?: unknown
  duration_ms?: unknown
  tool_input?: { command?: unknown }
  tool_response?: { gitOperation?: { commit?: { sha?: unknown } } }
}

/** A Claude Code Bash call, from its PostToolUse payload; null for any other tool. */
export function claudeShellCall(payload: unknown): ShellCall | null {
  const p = (payload ?? {}) as ToolPayload
  if (p.tool_name !== 'Bash' || typeof p.cwd !== 'string') return null
  const said = p.tool_response?.gitOperation?.commit?.sha
  return {
    command: typeof p.tool_input?.command === 'string' ? p.tool_input.command : '',
    cwd: p.cwd,
    durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
    ...(typeof said === 'string' ? { saidSha: said } : {})
  }
}

/**
 * A Codex command, from its `commandExecution` item once complete (or failed: a command can commit
 * and then fail): the command unwrapped from the shell Codex runs it in (`/bin/zsh -lc '…'`). Null
 * for any other item, one still running, or one declined (it never ran).
 */
export function codexShellCall(item: unknown, endedAt?: number | null, startedAt?: number | null): ShellCall | null {
  const it = (item ?? {}) as { type?: unknown; command?: unknown; cwd?: unknown; status?: unknown; durationMs?: unknown }
  if (it.type !== 'commandExecution' || typeof it.command !== 'string' || typeof it.cwd !== 'string') return null
  if (it.status !== 'completed' && it.status !== 'failed') return null
  // 0.167.1 reports `durationMs: 0` for some commands that ran (source unifiedExecStartup): the time
  // core saw the item start bounds it too, whichever is longer.
  const said = typeof it.durationMs === 'number' && it.durationMs >= 0 ? it.durationMs : null
  const end = typeof endedAt === 'number' && endedAt > 0 ? endedAt : Date.now()
  const seen = typeof startedAt === 'number' && startedAt > 0 && startedAt <= end ? end - startedAt : null
  const durationMs = said === null && seen === null ? null : Math.max(said ?? 0, seen ?? 0)
  return { command: codexShell(it.command), cwd: it.cwd, durationMs, ...(typeof endedAt === 'number' && endedAt > 0 ? { endedAt } : {}) }
}

/**
 * The commits a shell call made: the reflog entries in each folder it worked in that are commits
 * made during the call (from the second it started, `durationMs` before its end, `endedAt` or
 * `now`, to the second after it ended), plus the one the CLI itself names. [] when the call was not a commit. No slack before
 * the start: a commit someone else made a moment before the call is not the session's (only one
 * made in the very second the call started can be mistaken).
 */
export async function commitsOfShell(call: ShellCall | null, now = Date.now(), reflog = readReflog): Promise<string[]> {
  if (!call || !isAbsolute(call.cwd)) return []
  const cmd = call.command
  const said = call.saidSha
  if (!isCommitCommand(cmd) && typeof said !== 'string') return []
  if (typeof call.endedAt === 'number' && call.endedAt < now) now = call.endedAt
  const ms = typeof call.durationMs === 'number' && call.durationMs >= 0 ? call.durationMs : DEFAULT_WINDOW_MS
  const from = Math.floor((now - ms) / 1000) * 1000
  const shas: string[] = []
  for (const dir of commandDirs(cmd, call.cwd)) {
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const e of await reflog(dir)) {
      if (e.at < from || e.at > now + SLACK_MS) continue
      if (madeCommit(e.message) && !shas.includes(e.sha)) shas.push(e.sha)
    }
    if (typeof said === 'string' && dir === call.cwd) {
      const full = await fullSha(dir, said)
      if (full && !shas.includes(full)) shas.push(full)
    }
  }
  return shas
}

/** The commits a Claude Code Bash call made, from its PostToolUse payload. */
export function commitsOfCall(payload: unknown, now = Date.now(), reflog = readReflog): Promise<string[]> {
  return commitsOfShell(claudeShellCall(payload), now, reflog)
}

/** Records the commits a session's shell call made; `onChange` hears the whole list when any were new. */
export class CommitRecorder {
  constructor(
    readonly store: CommitStore,
    private readonly onChange: (all: CommitRecord[]) => void,
    private readonly read: typeof readReflog = readReflog
  ) {}

  /** A Claude Code session's PostToolUse on Bash. */
  onTool(session: { id: string; name: string }, payload: unknown): Promise<CommitRecord[]> {
    return this.onShell(session, claudeShellCall(payload))
  }

  /** A shell call from either CLI (a Codex session's: `codexShellCall`). */
  async onShell(session: { id: string; name: string }, call: ShellCall | null): Promise<CommitRecord[]> {
    const now = Date.now()
    const shas = await commitsOfShell(call, now, this.read)
    if (!shas.length) return []
    const added = await this.store.add(shas.map((sha) => ({ sha, session: session.id, name: session.name, at: now })))
    if (added.length) this.onChange(this.store.all())
    return added
  }
}
