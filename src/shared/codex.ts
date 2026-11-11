// A Codex session as core reads it from the session's own app-server (main/codex-link.ts): its
// thread's items folded into the same ChatBlocks a Claude Code transcript gives (so ChatView draws
// both), its status, its context use, and which loaded thread is the session's. Pure, tested in
// test/codex.test.ts. Shapes are codex-cli 0.167.1's app-server protocol (v2), read from
// `codex app-server generate-ts`; anything unknown is skipped, never thrown on.

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

/**
 * The command as you would read it: Codex runs each through the shell (`/bin/zsh -lc 'touch x'`);
 * the line shows `touch x`.
 */
export function codexCommand(cmd: string): string {
  const m = /^\S*\/(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd.trim())
  return firstLine(m ? m[2].replace(/'\\''/g, "'") : cmd)
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
