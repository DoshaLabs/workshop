// A session's conversation as a session tile shows it: your prompts, Claude's prose, one line per
// tool call. Main tails Claude Code's transcript JSONL (main/transcript.ts) and folds each line in
// with `applyLine`. Pure, so it is tested against hand-written lines (test/transcript.test.ts).
// Carried from deck's main/transcript.ts, with what the CLI writes now: lines it injects as the
// user (a background task's notification, a message from another session) carry an `origin` that
// is not `human` and are not shown as your prompts.

export type ChatBlock =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'tool'; id: string; name: string; label: string; ts: number; done: boolean; error: boolean; /** The path the call names, if any (shown on hover). */ path?: string }

export interface Transcript {
  /** Core's session id. */
  id: string
  /** The most recent blocks (main keeps the tail; TRANSCRIPT_KEEP). */
  blocks: ChatBlock[]
  /** Claude's own title for the conversation, once it has one. */
  title: string | null
  /** True once the transcript file has been found (a fresh session has none until its first prompt). */
  found: boolean
  /**
   * Whether the last turn is still going, as the file says: opened by your prompt, closed by the
   * CLI's end-of-turn note. Undefined until the file has said either. Core uses it when it has
   * missed the hooks (a restart), since the CLI's poll reads a background shell as busy.
   */
  turn?: 'open' | 'closed'
}

/** Blocks kept per session: a tile shows the tail, and pins itself to the end. */
export const TRANSCRIPT_KEEP = 80

type Json = Record<string, unknown>

export function emptyTranscript(id: string): Transcript {
  return { id, blocks: [], title: null, found: false }
}

/**
 * Fold one transcript line into `t`. Returns true when something a tile shows changed.
 * `sidechain`: the file is a subagent's own (`subagents/agent-<id>.jsonl`), every line of which is
 * marked `isSidechain`; in a session's file those lines are not the conversation.
 */
export function applyLine(t: Transcript, line: string, sidechain = false): boolean {
  const o = parseLine(line)
  return o ? applyEntry(t, o, sidechain) : false
}

/** One transcript line as an object, or null for a blank, torn or foreign one (skipped, never a reason to stop reading). */
export function parseLine(line: string): Json | null {
  if (!line.trim()) return null
  try {
    const o = JSON.parse(line) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Json) : null
  } catch {
    return null
  }
}

/** `applyLine` for a line already parsed (main parses each once, for the conversation and the activity). */
export function applyEntry(t: Transcript, o: Json, sidechain = false): boolean {
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string') {
    if (t.title === o.aiTitle) return false
    t.title = o.aiTitle
    return true
  }
  // In a session's file, a subagent's lines (its own tile shows them) and the CLI's own notes are not the conversation.
  if ((o.isSidechain && !sidechain) || o.isMeta) return false
  // The end of a turn: the CLI notes how long it took and that the stop hooks ran.
  if (o.type === 'system' && (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary')) {
    if (sidechain || t.turn === 'closed') return false
    t.turn = 'closed'
    return true
  }
  // A compaction's summary is written as a user line, for the model: the earlier conversation
  // retold, system reminders and all. It is not a prompt, and the tile never shows it.
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return false
  const msg = o.message as Json | undefined
  if (!msg || typeof msg !== 'object') return false
  const ts = Date.parse(String(o.timestamp ?? '')) || Date.now()

  if (o.type === 'user') {
    const origin = o.origin as Json | undefined
    const human = !origin || origin.kind === 'human'
    if (typeof msg.content === 'string') return human ? opens(t, pushUser(t, msg.content, ts), sidechain) : false
    if (!Array.isArray(msg.content)) return false
    let changed = false
    const texts: string[] = []
    for (const c of msg.content as Json[]) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text)
      else if (c.type === 'tool_result') {
        const b = t.blocks.find((x) => x.kind === 'tool' && x.id === c.tool_use_id)
        if (b && b.kind === 'tool' && (!b.done || b.error !== !!c.is_error)) {
          b.done = true
          b.error = !!c.is_error
          changed = true
        }
      }
    }
    if (texts.length && human) changed = opens(t, pushUser(t, texts.join('\n'), ts), sidechain) || changed
    return changed
  }

  if (o.type === 'assistant') {
    if (!Array.isArray(msg.content)) return false
    let changed = false
    for (const c of msg.content as Json[]) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'text' && typeof c.text === 'string') {
        if (!c.text.trim()) continue
        const last = t.blocks[t.blocks.length - 1]
        // Prose arrives a block per line; adjacent pieces of one reply read as one.
        if (last && last.kind === 'text' && ts - last.ts < 120_000) last.text = `${last.text}\n\n${c.text}`
        else t.blocks.push({ kind: 'text', text: c.text, ts })
        changed = true
      } else if (c.type === 'tool_use') {
        const name = String(c.name ?? 'tool')
        const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Json
        const path = toolPath(name, input)
        t.blocks.push({ kind: 'tool', id: String(c.id ?? ''), name, label: toolLabel(name, input), ts, done: false, error: false, ...(path ? { path } : {}) })
        changed = true
      }
    }
    return changed
  }
  return false
}

/** A prompt of yours (`pushed`) opens a turn. */
function opens(t: Transcript, pushed: boolean, sidechain: boolean): boolean {
  if (pushed && !sidechain) t.turn = 'open'
  return pushed
}

/** Keep only the tail. Returns true if anything was dropped. */
export function trimTranscript(t: Transcript, keep = TRANSCRIPT_KEEP): boolean {
  if (t.blocks.length <= keep) return false
  t.blocks.splice(0, t.blocks.length - keep)
  return true
}

/** What you typed, minus the CLI's own wrapping (slash commands, shell escapes, injected notes). */
function pushUser(t: Transcript, raw: string, ts: number): boolean {
  let text = raw.trim()
  if (!text) return false
  // `!cmd` in the CLI: the command is yours, its output is not a prompt.
  const bash = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)
  if (bash) text = `! ${bash[1].trim()}`
  else if (/^<(bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|task-notification)/.test(text)) return false
  else if (/^<(command-name|command-message|system-reminder)/.test(text)) {
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]
    if (!cmd) return false
    text = `${cmd.trim()} ${(args ?? '').trim()}`.trim()
  } else if (/^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/.test(text) && !/\n/.test(text.slice(0, 60))) {
    // A tag-wrapped payload (a pasted attachment): keep what is inside.
    text = text.replace(/<\/?[a-z-]+>/g, '').trim()
    if (!text) return false
  }
  t.blocks.push({ kind: 'user', text, ts })
  return true
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** The path a call names, if it names one. */
export function toolPath(name: string, input: Json): string | undefined {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return s('file_path') || s('notebook_path') || undefined
    case 'Grep':
    case 'Glob':
      return s('path') || undefined
    default:
      return undefined
  }
}

/** One short line per tool call: the thing it touched, not its full input. */
export function toolLabel(name: string, input: Json): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const first = (x: string) => x.split('\n')[0].trim()
  switch (name) {
    case 'Bash':
      return first(s('description') || s('command'))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return baseName(s('file_path') || s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return s('pattern')
    case 'Agent':
    case 'Task':
      return s('description')
    case 'WebFetch':
    case 'WebSearch':
      return s('url') || s('query')
    case 'Skill':
      return s('skill')
    case 'TodoWrite':
      return 'todo list'
    case 'AskUserQuestion':
      return 'a question for you'
    default: {
      const v = Object.values(input).find((x) => typeof x === 'string') as string | undefined
      return v ? first(v).slice(0, 80) : ''
    }
  }
}
