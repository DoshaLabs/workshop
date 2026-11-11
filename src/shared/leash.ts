// The leash and permission prompts (CLAUDE.md §9 item 1; docs/progress/2026-11-11-leash.md): what
// the window is told about a session's paused state, a held tool call and a permission prompt
// waiting in its terminal, and the answers core sends back to the CLI. Pure, so it is tested.
//
// A tool call is shown as text only: the window draws `label` and `body` as text nodes, never as
// HTML and never as a link. Neither is ever sent to a tile (workshop.sessions lists none of it).

/** A tool call, as the window shows it. */
export interface ToolCallView {
  /** The tool's name: Bash, Edit, an MCP tool… */
  tool: string
  /** One line: the command's description, the file, the URL. May be empty. */
  label: string
  /** The call itself as text: the command, the new content, the input as JSON. May be empty. */
  body: string
}

/** A permission prompt the CLI is showing in the session's terminal, answerable from its tile. */
export interface PermissionAsk extends ToolCallView {
  /** Core's id for this prompt (the CLI gives none: PermissionRequest carries no tool_use_id). */
  id: string
  at: number
  /** Answerable only in the terminal: the tile shows it with no Allow / Deny (a Codex permissions request, whose answer is a grant, not a yes). */
  terminal?: boolean
}

/** A tool call the leash is holding while the session is paused. */
export interface HeldCall extends ToolCallView {
  at: number
}

/** What a session's tile and the center head show of the leash and its prompts. */
export interface LeashView {
  paused: boolean
  /** The tool call(s) waiting on the pause, oldest first. */
  held: HeldCall[]
  /** Permission prompts waiting in the terminal, oldest first. */
  asks: PermissionAsk[]
}

export const NO_LEASH: LeashView = { paused: false, held: [], asks: [] }

/** How long the leash holds one call, in seconds, before refusing it (the hook's own timeout is a minute longer). */
export const HOLD_MAX_S = 3600

const LABEL_MAX = 300
const BODY_MAX = 4000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** A tool call as the window shows it, from parts already chosen: plain text, capped. */
export function toolView(tool: string, label: string, body: string): ToolCallView {
  return { tool: clip(tool || 'a tool', 80), label: clip(label.replace(/\s+/g, ' ').trim(), LABEL_MAX), body: clip(body, BODY_MAX) }
}

/** A tool call's input as the window shows it: plain text, capped. */
export function describeTool(name: unknown, input: unknown): ToolCallView {
  const tool = clip(str(name) || 'a tool', 80)
  const i = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  let label = ''
  let body = ''
  switch (tool) {
    case 'Bash':
    case 'Monitor':
      label = str(i.description)
      body = str(i.command)
      break
    case 'Write':
      label = str(i.file_path)
      body = str(i.content)
      break
    case 'Edit':
      label = str(i.file_path)
      body = [str(i.old_string) && `− ${str(i.old_string)}`, str(i.new_string) && `+ ${str(i.new_string)}`].filter(Boolean).join('\n')
      break
    case 'MultiEdit':
      label = str(i.file_path)
      body = Array.isArray(i.edits) ? `${i.edits.length} edit${i.edits.length === 1 ? '' : 's'}` : ''
      break
    case 'Read':
    case 'NotebookEdit':
      label = str(i.file_path) || str(i.notebook_path)
      break
    case 'WebFetch':
      label = str(i.url)
      body = str(i.prompt)
      break
    case 'WebSearch':
      label = str(i.query)
      break
    default: {
      let json = ''
      try {
        json = Object.keys(i).length ? JSON.stringify(i, null, 2) : ''
      } catch {
        json = ''
      }
      body = json
    }
  }
  return toolView(tool, label, body)
}

/** What core answers a PermissionRequest hook with (verified on Claude Code 2.1.322). */
export function permissionAnswer(allow: boolean): string {
  const decision = allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user denied this tool call. Do not retry it; ask them what to do instead.' }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

/** What the leash answers a held PreToolUse call with when the user refuses it. */
export function leashDeny(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

export const DENY_HELD = 'The user paused this session and refused this tool call. Do not retry it. The session stays paused: wait for the user.'
export const DENY_EXPIRED = 'The user paused this session over an hour ago and has not resumed it, so this tool call was not run. Wait for the user.'

/**
 * Whether the fleet poll (`claude agents --json`) says a permission prompt has been answered in the
 * terminal. While the CLI shows one, the poll reads `status: "waiting", waitingFor: "permission
 * prompt"` (seen on 2.1.322); once answered it reads busy or idle. A poll can predate the prompt,
 * so "not waiting" counts only once this prompt has been seen waiting, or after `graceMs`.
 */
export function answeredInTerminal(entry: { status?: string; state?: string; waitingFor?: string } | undefined, seenWaiting: boolean, ageMs: number, graceMs = 6000): boolean {
  if (!entry) return false
  const status = (entry.status ?? entry.state ?? '').toLowerCase()
  if (status === 'waiting' || status === 'blocked' || status === 'needs_input' || status === 'needs-input') return false
  if (status !== 'busy' && status !== 'idle' && status !== 'working' && status !== 'running' && status !== 'completed') return false
  return seenWaiting || ageMs > graceMs
}

/** Whether a poll row says the session is showing a permission prompt now. */
export function waitingOnPermission(entry: { status?: string; waitingFor?: string } | undefined): boolean {
  return !!entry && (entry.status ?? '').toLowerCase() === 'waiting' && /permission/i.test(entry.waitingFor ?? '')
}

/** Whether a finished tool call (PostToolUse) is the one a prompt asked about: same tool, same input. */
export function sameCall(a: { tool_name?: unknown; tool_input?: unknown }, b: { tool_name?: unknown; tool_input?: unknown }): boolean {
  return a.tool_name === b.tool_name && stable(a.tool_input) === stable(b.tool_input)
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
