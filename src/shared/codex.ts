// A Codex session as core reads it from the session's own app-server (main/codex-link.ts): its
// thread's items folded into the same ChatBlocks a Claude Code transcript gives (so ChatView draws
// both), its status, its context use, and which loaded thread is the session's. Pure, tested in
// test/codex.test.ts. Shapes are codex-cli 0.167.1's app-server protocol (v2), read from
// `codex app-server generate-ts`; anything unknown is skipped, never thrown on.

import { toolView, type ToolCallView } from './leash'
import type { SessionStatus } from './sessions'
import { TRANSCRIPT_KEEP, type ChatBlock, type Transcript } from './transcript'

type Json = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? ''
const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** A thread as `thread/read` and `thread/started` give it: the fields core looks at. */
export interface CodexThread {
  id: string
  cwd?: string
  ephemeral?: boolean
  parentThreadId?: string | null
  source?: unknown
  createdAt?: number
  name?: string | null
  status?: unknown
}

/**
 * Which loaded thread is the session's own: in its folder, not a subagent's (a parent), not
 * ephemeral (Codex's own side work, such as naming the thread), the newest if several.
 */
export function pickThread(threads: CodexThread[], cwd: string): CodexThread | null {
  const mine = threads.filter((t) => t && typeof t.id === 'string' && !t.parentThreadId && !t.ephemeral && (!t.cwd || t.cwd === cwd))
  mine.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return mine[0] ?? null
}

/** A thread's status as the session's: idle, working, or waiting on you (an approval or a question). */
export function codexStatus(s: unknown): { status: SessionStatus; needsYou: boolean } | null {
  const o = s as { type?: unknown; activeFlags?: unknown } | null
  switch (o?.type) {
    case 'idle':
    case 'notLoaded':
      return { status: 'idle', needsYou: false }
    case 'active': {
      const flags = Array.isArray(o.activeFlags) ? o.activeFlags : []
      const waiting = flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
      return { status: waiting ? 'blocked' : 'busy', needsYou: waiting }
    }
    case 'systemError':
      return { status: 'dead', needsYou: true }
    default:
      return null
  }
}

/** Context used (%), from `thread/tokenUsage/updated`: the last turn's tokens against the model's window. */
export function codexContext(u: unknown): number | null {
  const o = u as { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } | null
  const used = o?.last?.totalTokens
  const win = o?.modelContextWindow
  if (typeof used !== 'number' || typeof win !== 'number' || !(win > 0) || !(used >= 0)) return null
  return Math.min(100, Math.round((used / win) * 100))
}

/** A command without the shell Codex wraps it in (`/bin/zsh -lc 'touch x'` is `touch x`), whole. */
export function codexShell(cmd: string): string {
  const m = /^\S*\/(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd.trim())
  return m ? m[2].replace(/'\\''/g, "'") : cmd.trim()
}

/** The command as a tool line shows it: unwrapped, its first line. */
export function codexCommand(cmd: string): string {
  return firstLine(codexShell(cmd))
}

/** The server requests that are approvals core may show (and answer only on the user's click). */
export const CODEX_APPROVALS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'] as const

/** An approval request as the session's ask: what to show, and whether the tile may answer it. */
export interface CodexAsk extends ToolCallView {
  /** False: answerable in the terminal only (a permissions request's answer is a grant, not a yes). */
  answerable: boolean
}

/**
 * A server request as the window shows it, or null when it is not an approval of the session's
 * own thread (core then leaves it alone: never answered, never shown). `item`: the thread item
 * the request is about, when core has seen it (a file change's diffs are on its item, not on the
 * request).
 */
export function codexAsk(method: string, params: unknown, threadId: string, item?: unknown): CodexAsk | null {
  const p = params as Json | null
  if (!p || typeof p !== 'object' || p.threadId !== threadId) return null
  const reason = str(p.reason)
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const net = p.networkApprovalContext as Json | null | undefined
      const kind = str(p.kind)
      const label = net && str(net.host) ? `network: ${str(net.host)}` : reason || (kind === 'writeStdin' ? 'input to a running command' : str(p.cwd))
      return { ...toolView('Bash', label, codexShell(str(p.command))), answerable: true }
    }
    case 'item/fileChange/requestApproval': {
      const it = item as Json | undefined
      const changes = it?.type === 'fileChange' && Array.isArray(it.changes) ? (it.changes as Json[]) : []
      const paths = changes.map((c) => str(c.path)).filter(Boolean)
      const label = paths.length ? `${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}` : reason || str(p.grantRoot)
      const body = changes.map((c) => str(c.diff)).filter(Boolean).join('\n')
      return { ...toolView('Edit', label, body), answerable: true }
    }
    case 'item/permissions/requestApproval': {
      let body = ''
      try {
        body = p.permissions ? JSON.stringify(p.permissions, null, 2) : ''
      } catch {
        body = ''
      }
      return { ...toolView('Permissions', reason || str(p.cwd), body), answerable: false }
    }
    default:
      return null
  }
}

/** The reply to a command or file-change approval: Allow runs it once, Deny declines it and the turn goes on. */
export function codexDecision(allow: boolean): { decision: 'accept' | 'decline' } {
  return { decision: allow ? 'accept' : 'decline' }
}

/** Whether a thread status has an approval waiting (the TUI is showing its dialog). */
export function codexWaitingOnApproval(s: unknown): boolean {
  const o = s as { type?: unknown; activeFlags?: unknown } | null
  return o?.type === 'active' && Array.isArray(o.activeFlags) && o.activeFlags.includes('waitingOnApproval')
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const o = c as Json
      if (o?.type === 'text') return str(o.text)
      if (o?.type === 'localImage' || o?.type === 'image') return '[picture]'
      if (o?.type === 'skill') return `/${str(o.name)}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** The tool line an item makes, or null for an item that is not a tool call. */
function toolOf(item: Json): { name: string; label: string; path?: string; done: boolean; error: boolean } | null {
  const status = str(item.status)
  const done = status !== '' && status !== 'inProgress'
  const failed = status === 'failed' || status === 'declined'
  switch (item.type) {
    case 'commandExecution': {
      const exit = item.exitCode
      return { name: 'Bash', label: codexCommand(str(item.command)), done, error: failed || (typeof exit === 'number' && exit !== 0) }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : []
      const first = str(changes[0]?.path)
      const more = changes.length > 1 ? ` +${changes.length - 1}` : ''
      return { name: 'Edit', label: `${baseName(first)}${more}`, path: first || undefined, done, error: failed }
    }
    case 'mcpToolCall':
      return { name: `${str(item.server)}.${str(item.tool)}`, label: str(item.tool), done, error: failed || !!item.error }
    case 'dynamicToolCall':
      return { name: str(item.tool) || 'tool', label: str(item.tool), done, error: failed || item.success === false }
    case 'webSearch':
      return { name: 'WebSearch', label: str(item.query), done: true, error: false }
    case 'collabAgentToolCall':
      return { name: 'Agent', label: firstLine(str(item.prompt)).slice(0, 80) || str(item.tool), done, error: failed }
    case 'imageView':
      return { name: 'Read', label: baseName(str(item.path)), path: str(item.path) || undefined, done: true, error: false }
    default:
      return null
  }
}

/**
 * Fold one thread item into `t`. `completed`: from `item/completed` (or history); else
 * `item/started`. Prompts and prose are added once complete; a tool line appears when it starts
 * and is marked done (or failed) when it completes. Returns true when something shown changed.
 */
export function applyCodexItem(t: Transcript, raw: unknown, completed: boolean, ts = Date.now()): boolean {
  const item = raw as Json
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return false
  const id = item.id
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    if (!completed) return false
    const text = item.type === 'userMessage' ? userText(item.content) : str(item.text).trim()
    if (!text) return false
    const kind = item.type === 'userMessage' ? 'user' : 'text'
    const last = t.blocks[t.blocks.length - 1]
    if (last && last.kind === kind && last.text === text) return false // the same item from history and live
    push(t, { kind, text, ts })
    return true
  }
  const tool = toolOf(item)
  if (!tool) return false
  const at = t.blocks.findIndex((b) => b.kind === 'tool' && b.id === id)
  if (at >= 0) {
    const was = t.blocks[at] as Extract<ChatBlock, { kind: 'tool' }>
    const next = { ...was, label: tool.label || was.label, done: completed || tool.done, error: tool.error }
    if (next.done === was.done && next.error === was.error && next.label === was.label) return false
    t.blocks[at] = next
    return true
  }
  push(t, { kind: 'tool', id, name: tool.name, label: tool.label, ts, done: completed || tool.done, error: tool.error, ...(tool.path ? { path: tool.path } : {}) })
  return true
}

function push(t: Transcript, b: ChatBlock): void {
  t.blocks.push(b)
  if (t.blocks.length > TRANSCRIPT_KEEP) t.blocks.splice(0, t.blocks.length - TRANSCRIPT_KEEP)
}
