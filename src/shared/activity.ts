// What a session does, as a stream of events: each model step, each tool call with the few fields
// that say what it touched, the hooks that refused or added to it, compactions, background tasks
// ending, turns ending. Read from the same transcript JSONL as the conversation (shared/transcript.ts)
// and served to tiles with "activity" (bridge 1.10), which never see the conversation's prose.
// Made for a map of the work (the Session map tile, which draws it with lot-map); anything that draws where a session's work goes
// can use it. Pure, so it is tested against hand-written lines (test/activity.test.ts).
//
// What the CLI writes, as read on 2.1.323:
// - an assistant line per content block, all of one model request sharing `message.id`; the request
//   went out right after the line before it, so a step runs from that line to its own last line.
// - a tool's result in a user line (`tool_result`, `is_error`), with `toolUseResult` beside it: a
//   background task's id (`backgroundTaskId`, or `status: 'async_launched'` and `agentId`).
// - a PreToolUse hook's refusal as that result: `PreToolUse:<tool> hook error: <reason>`.
// - hooks' context and permission answers as `attachment` lines (`hook_additional_context`,
//   `hook_permission_decision`); a compaction as `system` `compact_boundary`; the end of a turn as
//   `system` `turn_duration`; an interrupted one as the user line `[Request interrupted by user]`;
//   a background task's end as a user line with origin `task-notification`.

export type ActivityStatus = 'run' | 'ok' | 'err' | 'block'

/**
 * The fields of a tool's input that say what it touched, never what it wrote: a path, a shell
 * command and Claude's description of it, an address, a skill's name, a record's id. A file's new
 * text, an edit's strings, a prompt to a subagent are never here.
 */
export interface ToolInput {
  file_path?: string
  notebook_path?: string
  path?: string
  command?: string
  description?: string
  url?: string
  skill?: string
  /** A number, or a short identifier: a longer string under `id` could be anything. */
  id?: string | number
}

export type ActivityEvent =
  /** You sent a message (not a task's report, not a message from another session). */
  | { kind: 'prompt'; at: number }
  /** One model request: from the line before it to its last line. */
  | { kind: 'step'; id: string; model: string; at: number; end: number; agent?: string }
  | { kind: 'tool'; id: string; name: string; input: ToolInput; at: number; end?: number; status: ActivityStatus; task?: string; agent?: string }
  /**
   * A settings hook acted: refused a call (`block`), added context (`context`, with the record numbers
   * a memory hook wrote as `[#123]`, digits only), or a permission was answered (`allow` / `deny`).
   */
  | { kind: 'hook'; what: 'block' | 'context' | 'allow' | 'deny'; event: string; tool?: string; at: number; records?: string[]; agent?: string }
  | { kind: 'compact'; at: number; end: number }
  /** A background task (a shell sent to the background, a background subagent, a workflow) ended. */
  | { kind: 'task'; task: string; status: 'ok' | 'err'; at: number }
  /** The turn ended: the answer is ready, or you interrupted it. */
  | { kind: 'end'; at: number; aborted: boolean }

export interface Activity {
  /** Core's session id. */
  id: string
  found: boolean
  /** Oldest first; the last ACTIVITY_KEEP, and every background task still going. */
  events: ActivityEvent[]
  /** The session's subagents and helpers (the wolfpack), and whether each still works. Filled in by core. */
  agents?: { id: string; running: boolean }[]
}

export const ACTIVITY_KEEP = 300
const MAX_COMMAND = 4000
const MAX_FIELD = 400

/** What a fold keeps between lines that a tile has no use for. */
export interface ActivityFold {
  activity: Activity
  /** When the last line was written: where the next model request began. */
  lastAt: number
  turnOpen: boolean
}

export function emptyActivity(id: string): Activity {
  return { id, found: false, events: [] }
}

export function newFold(id: string): ActivityFold {
  return { activity: emptyActivity(id), lastAt: 0, turnOpen: false }
}

type Json = Record<string, unknown>
const str = (v: unknown, max = MAX_FIELD): string | undefined => (typeof v === 'string' && v !== '' ? v.slice(0, max) : undefined)

export function toolInput(input: Json): ToolInput {
  const out: ToolInput = {}
  for (const k of ['file_path', 'notebook_path', 'path', 'description', 'url', 'skill'] as const) {
    const v = str(input[k], k === 'url' ? 2000 : MAX_FIELD)
    if (v !== undefined) out[k] = v
  }
  const cmd = str(input.command, MAX_COMMAND)
  if (cmd !== undefined) out.command = cmd
  if (typeof input.id === 'number' && Number.isFinite(input.id)) out.id = input.id
  else if (typeof input.id === 'string' && /^[\w-]{1,24}$/.test(input.id)) out.id = input.id
  return out
}

/** The id of the background task a call started, if it started one (a background shell, an async subagent or workflow, a monitor). */
export function taskOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as Json
  const id = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined)
  if (r.status === 'async_launched' || r.status === 'remote_launched') return id(r.agentId) ?? id(r.taskId)
  return id(r.backgroundTaskId) ?? (typeof r.timeoutMs === 'number' ? id(r.taskId) : undefined)
}

/** A task notification, read for the task's id and how it ended, nothing else. */
export function taskNotice(text: string): { task: string; status?: 'ok' | 'err' } | undefined {
  if (!text.trimStart().startsWith('<task-notification>')) return undefined
  const task = /<task-id>([\w-]{1,64})<\/task-id>/.exec(text)?.[1]
  if (task === undefined) return undefined
  const word = /<status>(\w+)<\/status>/.exec(text)?.[1]
  return word === undefined ? { task } : { task, status: word === 'failed' ? 'err' : 'ok' }
}

/** Record numbers a memory hook put in front of the model (`[#123`, `[todo #123`): the digits alone. */
export function recordIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(?:[a-z]+ )?#(\d{1,12})/g)].map((m) => m[1] ?? ''))].slice(0, 50)
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Json[]).map((c) => (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n')
      : ''

const REFUSED_BY_HOOK = /^PreToolUse:(\S+) hook error:/
/** You said no at the permission dialog, or the CLI's own checks refused the call. */
const REFUSED = /^(The user doesn't want to proceed|Permission for this action was denied|Permission to use \S+ has been denied)/

function findTool(a: Activity, id: string): Extract<ActivityEvent, { kind: 'tool' }> | undefined {
  for (let i = a.events.length - 1; i >= 0; i--) {
    const e = a.events[i]
    if (e?.kind === 'tool' && e.id === id) return e
  }
  return undefined
}

/**
 * Fold one transcript line, already parsed, into `f`. Returns true when the activity changed.
 * `sidechain`: the file is a subagent's own, whose first user line is its brief, not a prompt of
 * yours, and whose turns are not the session's.
 */
export function foldActivity(f: ActivityFold, o: Json, sidechain = false): boolean {
  const a = f.activity
  const ts = Date.parse(String(o.timestamp ?? '')) || 0
  if (!ts) return false
  const before = f.lastAt || ts
  f.lastAt = ts
  if (o.isSidechain && !sidechain) return false
  const push = (e: ActivityEvent): true => {
    a.events.push(e)
    return true
  }

  if (o.type === 'system') {
    if (o.subtype === 'compact_boundary') {
      const meta = (o.compactMetadata ?? {}) as Json
      const ms = typeof meta.durationMs === 'number' ? meta.durationMs : 0
      return push({ kind: 'compact', at: ts - ms, end: ts })
    }
    if (o.subtype === 'turn_duration' && !sidechain && f.turnOpen) {
      f.turnOpen = false
      return push({ kind: 'end', at: ts, aborted: false })
    }
    return false
  }

  if (o.type === 'attachment') {
    const at = (o.attachment ?? {}) as Json
    const event = String(at.hookEvent ?? at.hookName ?? '').split(':')[0] ?? ''
    if (at.type === 'hook_additional_context') {
      const records = recordIds(Array.isArray(at.content) ? at.content.join('\n') : String(at.content ?? ''))
      return push({ kind: 'hook', what: 'context', event: String(at.hookName ?? event).split(':')[0] ?? '', at: ts, ...(records.length ? { records } : {}) })
    }
    if (at.type === 'hook_permission_decision' && (at.decision === 'allow' || at.decision === 'deny')) {
      const tool = typeof at.toolUseID === 'string' ? findTool(a, at.toolUseID) : undefined
      return push({ kind: 'hook', what: at.decision, event: event || 'PermissionRequest', at: ts, ...(tool ? { tool: tool.name } : {}) })
    }
    if (at.type === 'hook_blocking_error' && event === 'PreToolUse') {
      const tool = typeof at.toolUseID === 'string' ? findTool(a, at.toolUseID) : undefined
      if (tool?.status === 'block') return false // its result said so already
      if (tool) tool.status = 'block'
      return push({ kind: 'hook', what: 'block', event, at: ts, ...(tool ? { tool: tool.name } : {}) })
    }
    return false
  }

  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false
  const msg = o.message as Json | undefined
  if (!msg || typeof msg !== 'object') return false

  if (o.type === 'assistant') {
    let changed = false
    const id = typeof msg.id === 'string' ? msg.id : ''
    const model = typeof msg.model === 'string' ? msg.model : ''
    if (id && model && model !== '<synthetic>') {
      const last = [...a.events].reverse().find((e) => e.kind === 'step')
      if (last && last.kind === 'step' && last.id === id) {
        if (last.end !== ts) {
          last.end = ts
          changed = true
        }
      } else changed = push({ kind: 'step', id, model, at: Math.min(before, ts), end: ts })
    }
    for (const c of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
      if (!c || typeof c !== 'object' || c.type !== 'tool_use') continue
      const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Json
      changed = push({ kind: 'tool', id: String(c.id ?? ''), name: String(c.name ?? 'tool'), input: toolInput(input), at: ts, status: 'run' })
    }
    return changed
  }

  if (o.type !== 'user') return false
  const origin = o.origin as Json | undefined
  const text = textOf(msg.content)
  const notice = taskNotice(text)
  if (notice || origin?.kind === 'task-notification') {
    if (!notice?.status) return false
    const tool = [...a.events].reverse().find((e) => e.kind === 'tool' && e.task === notice.task && e.status === 'run')
    if (tool && tool.kind === 'tool') {
      tool.status = notice.status
      tool.end = ts
    }
    return push({ kind: 'task', task: notice.task, status: notice.status, at: ts })
  }
  let changed = false
  for (const c of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
    if (!c || typeof c !== 'object' || c.type !== 'tool_result') continue
    const tool = findTool(a, String(c.tool_use_id ?? ''))
    if (!tool || tool.status !== 'run') continue
    const said = textOf(c.content).trimStart()
    const hook = REFUSED_BY_HOOK.exec(said)
    const task = c.is_error ? undefined : taskOf(o.toolUseResult)
    if (task) tool.task = task
    else {
      tool.status = hook || REFUSED.test(said) ? 'block' : c.is_error ? 'err' : 'ok'
      tool.end = ts
    }
    if (hook) push({ kind: 'hook', what: 'block', event: 'PreToolUse', tool: tool.name, at: ts })
    changed = true
  }
  if (sidechain || changed) return changed
  if (/^\[Request interrupted by user/.test(text.trimStart())) {
    f.turnOpen = false
    return push({ kind: 'end', at: ts, aborted: true })
  }
  const human = !origin || origin.kind === 'human'
  if (!human || !text.trim() || /^<(bash-|local-command)/.test(text.trimStart())) return false
  f.turnOpen = true
  return push({ kind: 'prompt', at: ts })
}

/** Keep the newest `keep` events, and every background task still going however old. True if any went. */
export function trimActivity(a: Activity, keep = ACTIVITY_KEEP): boolean {
  if (a.events.length <= keep) return false
  const from = a.events.length - keep
  a.events = a.events.filter((e, i) => i >= from || (e.kind === 'tool' && e.status === 'run' && e.task !== undefined))
  return true
}

/**
 * A session's activity with its subagents' and helpers' woven in, each of theirs marked with the
 * agent's id: their steps and calls, never their turns. Sorted by time, trimmed as one.
 */
export function mergeActivity(own: Activity, agents: { id: string; running: boolean; activity: Activity | null }[]): Activity {
  const events: ActivityEvent[] = [...own.events]
  for (const ag of agents)
    for (const e of ag.activity?.events ?? [])
      if (e.kind === 'step' || e.kind === 'tool' || e.kind === 'hook') events.push({ ...e, agent: ag.id })
  events.sort((x, y) => x.at - y.at)
  const out: Activity = { id: own.id, found: own.found, events, agents: agents.map(({ id, running }) => ({ id, running })) }
  trimActivity(out)
  return out
}
