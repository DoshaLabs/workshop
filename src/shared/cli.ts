// The CLIs a session can run: Claude Code, and OpenAI's Codex (Colin, 11 Nov 2026;
// docs/progress/2026-11-11-codex.md). Both are run unchanged, each on the user's own sign-in.
// Keep this file dependency-free: main and the renderer both import it.
//
// A Codex session is two processes in one tmux session: the Codex TUI in the window we attach to,
// connected with `--remote` to an app-server of its own in a second window. Core is a second
// client of that server (phase 2). The session runs in the SERVER's folder, not the TUI's (seen
// with 0.167.1), so the server starts in the session's folder and the TUI gets `-C` as well.

export type CliKind = 'claude' | 'codex'

export const CLIS: readonly { id: CliKind; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude Code', hint: 'Anthropic’s CLI, on your own sign-in' },
  { id: 'codex', label: 'Codex', hint: 'OpenAI’s CLI, on your own ChatGPT or API sign-in' }
]

/** A stored or requested CLI: anything but 'codex' is Claude Code (records from before Codex have none). */
export function cliOf(v: unknown): CliKind {
  return v === 'codex' ? 'codex' : 'claude'
}

export interface CodexMode {
  /** Ours, stored as the session's permissionMode; '' = no flags, so the user's Codex config decides. */
  id: string
  label: string
  hint: string
  args: readonly string[]
  risky?: boolean
}

/** What the launcher offers for Codex, as `-s` (sandbox) and `-a` (approvals; 0.167.1 takes on-request | never). */
export const CODEX_MODES: readonly CodexMode[] = [
  { id: '', label: 'Default', hint: 'Your Codex config decides (out of the box: edits in this folder, asks for anything beyond it)', args: [] },
  { id: 'read-only', label: 'Read only', hint: 'Reads anything; every edit and command that writes asks first', args: ['-s', 'read-only', '-a', 'on-request'] },
  { id: 'workspace', label: 'Workspace', hint: 'Edits and runs commands in this folder; asks to go beyond it', args: ['-s', 'workspace-write', '-a', 'on-request'] },
  { id: 'never-ask', label: 'Never ask', hint: 'Works in this folder and never asks: what the sandbox blocks just fails', args: ['-s', 'workspace-write', '-a', 'never'], risky: true },
  { id: 'bypass', label: 'Bypass', hint: 'No sandbox and no questions. Only in a folder you can afford to lose', args: ['--dangerously-bypass-approvals-and-sandbox'], risky: true }
]

export function cleanCodexMode(v: unknown): string {
  return CODEX_MODES.some((m) => m.id === v) ? (v as string) : ''
}

export function codexModeLabel(id: string): string {
  return CODEX_MODES.find((m) => m.id === id)?.label ?? id
}

/** A Codex thread id as the app-server and the rollout files give it (a UUID). */
export function codexThreadId(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null
}

export interface CodexLaunch {
  cwd: string
  /** The session's app-server socket. */
  sock: string
  model?: string
  mode?: string
  /** The thread to resume, once core has learnt it; absent, a new conversation. */
  resume?: string | null
  prompt?: string
}

/** The TUI's argv after `codex`: always attached to the session's own app-server, always in its folder. */
export function codexTuiArgs(o: CodexLaunch): string[] {
  const resume = codexThreadId(o.resume)
  const args = resume ? ['resume', resume] : []
  args.push('--remote', `unix://${o.sock}`, '-C', o.cwd)
  if (o.model) args.push('-m', o.model)
  args.push(...(CODEX_MODES.find((m) => m.id === o.mode)?.args ?? []))
  if (o.prompt && !resume) args.push('--', o.prompt)
  return args
}

/** The app-server's argv after `codex`. */
export function codexServerArgs(sock: string): string[] {
  return ['app-server', '--listen', `unix://${sock}`]
}
