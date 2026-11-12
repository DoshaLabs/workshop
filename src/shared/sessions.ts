// A session as core keeps it and as the window shows it. A session is an unchanged agent CLI
// (`claude`, or `codex` with its own app-server: shared/cli.ts) in its own tmux session (CLAUDE.md
// §7): it survives the app quitting, and closing it in the window only parks it.

import type { CliKind } from './cli'
import type { LeashView } from './leash'
import { ordered } from './order'

export type SessionStatus = 'starting' | 'busy' | 'idle' | 'blocked' | 'dead' | 'unknown'

export interface SessionRecord {
  /** Core's id: 6 hex. */
  id: string
  tmuxName: string
  /** The CLI it runs; absent in records from before Codex, which are Claude Code. */
  cli?: CliKind
  /**
   * The CLI's id for the conversation. Claude Code: our UUID, handed over with --session-id (how
   * hooks and the fleet poll find the session). Codex: its thread id, '' until core learns it from
   * the session's app-server (Codex takes no id of ours).
   */
  cliSessionId: string
  cwd: string
  worktree: boolean
  model: string
  permissionMode?: string
  /** The CLI's session name (what `claude agents` lists), or ours until it says. */
  name: string
  createdAt: number
  activeAt?: number
  /** Attached in the window (true) or parked (false). */
  open: boolean
}

/**
 * Whether a hook's or a poll row's session id is this session's. Never on an empty id: a Codex
 * session's is '' until core learns it, and '' must not match a hook that names none.
 */
export function isSession(rec: Pick<SessionRecord, 'cliSessionId'>, sid: unknown): boolean {
  return typeof sid === 'string' && sid !== '' && sid === rec.cliSessionId
}

export interface SessionView extends SessionRecord {
  /** Claude's title for the conversation (the terminal's title), or null. */
  title: string | null
  status: SessionStatus
  /** Needs you: a question, a permission prompt, a finished turn not yet looked at. */
  attention: boolean
  attached: boolean
  tmuxAlive: boolean
  /** Paused, a held tool call, permission prompts the tile can answer (main/leash.ts). Core's window only: never sent to a tile. */
  leash: LeashView
}

export interface SessionsState {
  focus: string | null
  /** Open sessions, most recently active first; then parked ones, newest first. */
  sessions: SessionView[]
  /** Folders sessions were started in, most recent first (the launcher offers them). */
  recent: string[]
  profile: string
}

export interface NewSessionOpts {
  /** Claude Code unless 'codex'. */
  cli?: CliKind
  cwd: string
  worktree?: boolean
  /** The new worktree's name (`claude --worktree <name>`, whose branch is `worktree-<name>`); the CLI picks one when absent. */
  worktreeName?: string
  model?: string
  permissionMode?: string
  name?: string
  prompt?: string
}

/**
 * The open sessions in the order ⌘1–9 reach them (and ⌘[ ⌘] step through): the order they were
 * started. The column is ordered by recency, which changes as you work; a number that moved with it
 * could not be learnt by the fingers, so the number stays put and each tile wears its own.
 *
 * Once the user has dragged a session (`manual`, the column's saved order), the column stays where
 * they put it, and the numbers follow it: ⌘1 is the top tile. A session the order has not seen
 * goes to the foot, so a new session takes the next number and never renumbers the others.
 */
export function shortcutOrder(s: SessionsState | null, manual?: string[]): string[] {
  const started = (s?.sessions ?? [])
    .filter((x) => x.open)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((x) => x.id)
  return manual ? ordered(started, manual) : started
}

/** The open sessions as the column draws them: most recently active first, or the user's order. */
export function columnOrder(s: SessionsState | null, manual?: string[]): string[] {
  return manual ? shortcutOrder(s, manual) : (s?.sessions ?? []).filter((x) => x.open).map((x) => x.id)
}

/**
 * What a tile may fill the launcher with (workshop.sessions.launch, "sessions": "launch"): a folder,
 * and a new worktree, optionally named. The user still presses Start; `nonce` tells one request
 * from the next for the same folder.
 */
export interface LaunchPrefill {
  cwd: string
  worktree?: boolean
  branch?: string
  nonce: number
}

/**
 * A worktree name the CLI and git both take: `claude --worktree <name>` makes the folder
 * `.claude/worktrees/<name>` and the branch `worktree-<name>`. Lowercase letters, digits, dots,
 * dashes and underscores, 1 to 60, starting with a letter or digit; null for anything else.
 */
export function worktreeName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[a-z0-9][a-z0-9._-]{0,59}$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('.') ? s : null
}

/**
 * A tile's `sessions.launch(opts)` checked for shape (core then checks the folder is there): an
 * absolute folder, and `worktree` absent, `true`, or `{ branch? }` with a name `worktreeName`
 * takes. Throws with what was wrong.
 */
export function launchRequest(v: unknown): { folder: string; worktree: boolean; branch?: string } {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  const folder = o?.folder
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.length > 1024 || folder.includes('\0')) throw new Error('sessions.launch: { folder } is an absolute path')
  const w = o!.worktree
  if (w === undefined || w === false || w === null) return { folder, worktree: false }
  if (w === true) return { folder, worktree: true }
  if (typeof w !== 'object' || Array.isArray(w)) throw new Error('sessions.launch: worktree is true or { branch }')
  const b = (w as Record<string, unknown>).branch
  if (b === undefined || b === '') return { folder, worktree: true }
  const name = worktreeName(b)
  if (!name) throw new Error('sessions.launch: worktree.branch is lowercase letters, digits, dots, dashes and underscores (1 to 60)')
  return { folder, worktree: true, branch: name }
}

/**
 * The project a session works in, by its folder's name. A Claude Code worktree session's `cwd` is
 * the project itself (the CLI makes the worktree under it); a Codex one starts inside the worktree
 * core made, `<root>/.workshop/worktrees/<name>`, so that tail is dropped. A worktree session's own
 * name is its worktree's, so its heads lead with this instead and show the worktree below.
 */
export function projectName(cwd: string): string {
  const p = cwd.replace(/\/\.(claude|workshop)\/worktrees\/[^/]+\/*$/, '').replace(/\/+$/, '')
  return p.split('/').pop() || p || cwd
}
