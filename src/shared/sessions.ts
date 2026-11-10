// A session as core keeps it and as the window shows it. A session is the unchanged `claude`
// CLI in its own tmux session (CLAUDE.md §7): it survives the app quitting, and closing it in
// the window only parks it.

export type SessionStatus = 'starting' | 'busy' | 'idle' | 'blocked' | 'dead' | 'unknown'

export interface SessionRecord {
  /** Core's id: 6 hex. */
  id: string
  tmuxName: string
  /** Our UUID, handed to the CLI with --session-id: how hooks and the fleet poll find the session. */
  claudeSessionId: string
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

export interface SessionView extends SessionRecord {
  /** Claude's title for the conversation (the terminal's title), or null. */
  title: string | null
  status: SessionStatus
  /** Needs you: a question, a permission prompt, a finished turn not yet looked at. */
  attention: boolean
  attached: boolean
  tmuxAlive: boolean
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
  cwd: string
  worktree?: boolean
  model?: string
  permissionMode?: string
  name?: string
  prompt?: string
}
