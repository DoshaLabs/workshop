// The wolfpack's subagents: whatever a session runs through the Agent tool or a Workflow, as a
// live tile under its parent (CLAUDE.md §7). Carried from deck's main/agents.ts, without its beta
// sessions (workshop's helper sessions are main/helpers.ts) and without the leash's own hook,
// which is built beside this (see `preTool`, the seam it calls).
//
// The CLI tells us through its SubagentStart / SubagentStop hooks (agent_id, agent_type; the stop
// adds agent_transcript_path and last_assistant_message), with the PARENT's session_id. Each
// agent's transcript is the same JSONL as a session's, every line marked isSidechain, under
// `<projects>/<cwd>/<session id>/subagents/`:
//   agent-<id>.jsonl                          an Agent-tool subagent
//   workflows/wf_<runId>/agent-<id>.jsonl     an agent a Workflow runs (type `workflow-subagent`)
// each with a sidecar `agent-<id>.meta.json` (agentType, description, a Workflow's workflowPhase,
// and `finished`). Seen on Claude Code 2.1.322: docs/progress/2026-11-11-wolfpack.md.
//
// What deck learned the hard way, kept here:
// - NOTHING IS GUESSED. Neither the file nor a Workflow run's folder need exist at SubagentStart:
//   an agent's `path` stays null until `resolve()` has SEEN the file, and the stop hook's
//   agent_transcript_path wins whenever it names a file that exists.
// - The CLI's internal forks carry agent ids of their own, call tools and stop, and never write a
//   transcript: an agent never seen to start gets a tile only if its transcript exists.
// - Some agents never send a stop (the built-in web-fetch agent hands its report back as a
//   message): one is finished when its sidecar says `"finished": true` and its transcript has been
//   quiet QUIET_MS. A later tool call of its takes that back (it was talked to again).
// - A few are never marked finished at all: the tile's × is the last resort.
//
// Finished agents stay until the parent's next prompt you typed (shared/agents.ts typedPrompt),
// FINISHED_KEEP_MS, PER_PARENT, or the tile's ×.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentName, agentTranscriptId, firstLine, typedPrompt, type AgentView } from '@shared/agents'
import type { SessionRecord } from '@shared/sessions'
import type { Transcript } from '@shared/transcript'
import type { HookEvent, HookPayload, PreToolDecision } from './hooks'

interface Agent extends AgentView {
  /** The transcript, null until `resolve()` has SEEN the file (never a guess). */
  path: string | null
  /** The parent's CLI session id and transcript path (when a hook said), which is where to look. */
  sessionId: string
  parentTranscript: string | null
  /** The sidecar has been read (it can land a beat after the transcript). */
  meta: boolean
  /** The end was read off the sidecar, not told by a SubagentStop: a later tool call takes it back. */
  sidecarEnd: boolean
}

/** What the tracker needs of the sessions. */
export interface AgentHost {
  /** An open session by core's id. */
  open(id: string): boolean
  /** Type a line into a session and submit it. */
  paste(id: string, text: string): void
}

/** A held tool call: let it through (null), or refuse it. */
type Release = (decision: PreToolDecision | null) => void

/** A finished agent stays this long past its stop, whatever the parent does. */
const FINISHED_KEEP_MS = 30 * 60_000
/** Agents kept per parent (the oldest finished go first). */
const PER_PARENT = 12
/** A killed agent's later calls are refused (and it never gets a tile back) for this long. */
const STOPPED_KEEP_MS = 6 * 60 * 60_000
/** What a killed agent reads as its refused tool call's result. */
const KILLED = 'the user stopped this agent from workshop'
/** How often the unresolved, and the sidecars of the unfinished, are looked at. */
const LOOK_MS = 500
/** A sidecar's "finished" is believed once the transcript has been still this long. */
export const QUIET_MS = 10_000
/** How deep under `subagents/` a transcript is looked for (`workflows/wf_<run>/` is two). */
const RESOLVE_DEPTH = 3

export class AgentTracker {
  private agents = new Map<string, Agent>()
  /** Held tool calls, per agent id. */
  private holds = new Map<string, Set<Release>>()
  /** Agents killed from workshop (tile gone): id → when. */
  private stopped = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private leash = false

  constructor(
    private readonly host: AgentHost,
    private readonly projectsDir: string,
    /** The transcripts to tail: `agent:<id>` and the file once seen. */
    private readonly tail: (list: { id: string; path: string | null }[]) => void,
    private readonly emit: () => void
  ) {}

  list(): AgentView[] {
    return [...this.agents.values()].map(view).sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Whether a tool call can be held or refused: the leash's PreToolUse hook calls `preTool`. */
  hasLeash(): boolean {
    return this.leash
  }

  /** The leash says it is wired (its PreToolUse hook reaches `preTool`), or not. */
  setLeash(on: boolean): void {
    if (this.leash === on) return
    this.leash = on
    if (!on) for (const id of [...this.holds.keys()]) this.release(id, null)
    this.emit()
  }

  // ---- hooks -----------------------------------------------------------------

  /** A hook from `rec` (core checked its token and that the payload names it). */
  onHook(rec: SessionRecord, event: HookEvent, p: HookPayload): void {
    const id = String(p.agent_id ?? '')
    switch (event) {
      case 'SubagentStart': {
        if (!id || this.agents.has(id) || this.stopped.has(id)) return
        const a = fresh(id, rec.id, p)
        this.agents.set(id, a)
        this.resolve(a)
        break
      }
      case 'SubagentStop': {
        if (!id || this.stopped.has(id)) return
        let a = this.agents.get(id)
        if (!a) {
          // Never seen to start: a tile all the same, already finished, but only with a transcript
          // to show. The CLI's internal forks stop too, naming a file they never wrote.
          a = fresh(id, rec.id, p)
          const named = p.agent_transcript_path
          if (!(named && existsSync(named)) && !this.resolve(a)) return
          this.agents.set(id, a)
        }
        // The CLI says where the transcript is: that beats whatever was found (or not) before.
        if (p.agent_transcript_path && p.agent_transcript_path !== a.path && existsSync(p.agent_transcript_path)) this.found(a, p.agent_transcript_path)
        else this.resolve(a)
        a.endedAt = Date.now()
        a.sidecarEnd = false
        a.paused = false
        a.held = false
        a.lastText = typeof p.last_assistant_message === 'string' ? p.last_assistant_message.slice(0, 4000) : null
        this.release(id, null)
        break
      }
      case 'UserPromptSubmit': {
        // A new turn you typed into the parent: last turn's finished agents leave the column.
        if (!typedPrompt(p.prompt)) return
        let dropped = false
        for (const [aid, a] of this.agents)
          if (a.parent === rec.id && a.endedAt !== null) {
            this.agents.delete(aid)
            dropped = true
          }
        if (!dropped) return
        break
      }
      default:
        return
    }
    this.changed()
  }

  /**
   * THE SEAM FOR THE LEASH. Every tool call of a session comes through its PreToolUse hook; the
   * leash's route calls this with the session (checked by its token, the payload naming it) and
   * answers the hook with what it resolves to: null lets the call through, a decision refuses it.
   * A subagent's call carries its `agent_id` (verified on 2.1.322). A paused agent's call waits
   * here until it is resumed or killed, or `gone` fires (the CLI gave up on the hook).
   */
  preTool(rec: SessionRecord, p: HookPayload, gone: (cb: () => void) => void): Promise<PreToolDecision | null> {
    const id = String(p.agent_id ?? '')
    if (!id) return Promise.resolve(null)
    if (this.stopped.has(id)) return Promise.resolve(deny(KILLED))
    let a = this.agents.get(id)
    if (!a) {
      // Never seen to start: a tile only once its transcript is on disk (the CLI's forks never write one).
      const found = fresh(id, rec.id, p)
      if (!this.resolve(found)) return Promise.resolve(null)
      a = found
      this.agents.set(id, a)
      this.changed()
    } else if (!a.path && this.resolve(a)) this.changed()
    if (a.sidecarEnd) {
      // Finished by its sidecar's word, and here it is calling a tool: it was talked to again.
      a.sidecarEnd = false
      a.endedAt = null
      this.changed()
    }
    if (!a.paused) return Promise.resolve(null)
    const agent = a
    agent.held = true
    this.changed()
    return new Promise<PreToolDecision | null>((resolve) => {
      let set = this.holds.get(id)
      if (!set) this.holds.set(id, (set = new Set()))
      const release: Release = (d) => {
        if (!set!.delete(release)) return
        if (set!.size === 0) this.holds.delete(id)
        if (!this.holds.has(id) && agent.held) {
          agent.held = false
          this.changed()
        }
        resolve(d)
      }
      set.add(release)
      gone(() => release(null))
    })
  }

  /** A transcript came in: a nameless agent takes its brief's first line. */
  onTranscript(t: Transcript): void {
    if (!t.id.startsWith('agent:')) return
    const a = this.agents.get(t.id.slice(6))
    if (!a || a.task) return
    const first = t.blocks.find((b) => b.kind === 'user')
    if (!first) return
    a.task = firstLine(first.text)
    if (a.task) this.changed()
  }

  // ---- what the user does --------------------------------------------------------

  /** Pause: its next tool call waits. Only with the leash: without it nothing could hold the call. */
  pause(id: string): void {
    const a = this.need(id)
    if (!this.leash) throw new Error('pausing an agent needs the leash, which is not wired in this build')
    if (a.endedAt !== null) throw new Error('that agent has already finished')
    a.paused = true
    this.changed()
  }

  resume(id: string): void {
    const a = this.need(id)
    if (!a.paused) return
    a.paused = false
    a.held = false
    this.release(id, null)
    this.changed()
  }

  /**
   * Kill. The CLI has no way for another program to stop one of a session's subagents, so this is
   * what workshop can honestly do: the tile goes at once; with the leash, the agent's held call and
   * every later one is refused (it reads the refusal and returns early, verified on 2.1.322); and
   * the parent is told in one typed line, so a background agent can be stopped with its own
   * TaskStop. Its id is kept STOPPED_KEEP_MS so its hooks never make a tile again. A finished
   * agent is only dismissed.
   */
  kill(id: string): void {
    const a = this.need(id)
    const running = a.endedAt === null
    this.agents.delete(id)
    if (running) {
      this.stopped.set(id, Date.now())
      this.release(id, deny(KILLED))
      if (this.host.open(a.parent))
        this.host.paste(
          a.parent,
          `[workshop] The user stopped your subagent “${agentName(a)}” (id ${a.id})${a.background ? '; if it is still running, stop it with TaskStop' : ''}. No explanation needed: carry on without it, and do not relaunch it unless asked.`
        )
    }
    this.changed()
  }

  /** The tile's ×: a finished agent goes; a stuck one (its stop never came) is forgotten, the last resort. */
  dismiss(id: string): void {
    const a = this.agents.get(id)
    if (!a) return
    this.agents.delete(id)
    this.release(id, null)
    this.changed()
  }

  /** Agents of sessions no longer open go with them. */
  keepParents(open: Set<string>): void {
    let dropped = false
    for (const [id, a] of this.agents) {
      if (open.has(a.parent)) continue
      this.agents.delete(id)
      this.release(id, null)
      dropped = true
    }
    if (dropped) this.changed()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.holds.keys()]) this.release(id, null)
  }

  // ---- the list ----------------------------------------------------------------

  /** Finished agents past their keep, the oldest past the per-parent cap, and agents the sidecar says are done. */
  private look(): void {
    const now = Date.now()
    let changed = false
    for (const [id, at] of this.stopped) if (now - at > STOPPED_KEEP_MS) this.stopped.delete(id)
    const byParent = new Map<string, Agent[]>()
    for (const [id, a] of this.agents) {
      if (this.resolve(a) || this.readMeta(a)) changed = true
      if (a.endedAt !== null && now - a.endedAt > FINISHED_KEEP_MS) {
        this.agents.delete(id)
        changed = true
        continue
      }
      // SOME AGENTS NEVER SEND A SubagentStop: the CLI's sidecar says "finished" all the same.
      if (a.endedAt === null && this.finishedOnDisk(a, now)) {
        a.endedAt = now
        a.sidecarEnd = true
        a.paused = false
        this.release(id, null)
        changed = true
      }
      byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a])
    }
    for (const list of byParent.values()) {
      const finished = list.filter((a) => a.endedAt !== null).sort((x, y) => x.endedAt! - y.endedAt!)
      for (const a of finished.slice(0, Math.max(0, list.length - PER_PARENT))) {
        this.agents.delete(a.id)
        changed = true
      }
    }
    if (changed) this.changed()
    else this.schedule()
  }

  private changed(): void {
    this.schedule()
    this.tail([...this.agents.values()].map((a) => ({ id: agentTranscriptId(a.id), path: a.path })))
    this.emit()
  }

  /** The look runs while there is any agent: a few stats every LOOK_MS, nothing once the pack is empty. */
  private schedule(): void {
    const waiting = this.agents.size > 0
    if (waiting && !this.timer) this.timer = setInterval(() => this.look(), LOOK_MS)
    else if (!waiting && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private need(id: string): Agent {
    const a = this.agents.get(String(id))
    if (!a) throw new Error('no such agent')
    return a
  }

  private release(id: string, decision: PreToolDecision | null): void {
    const set = this.holds.get(id)
    if (!set) return
    for (const r of [...set]) r(decision)
  }

  // ---- the transcript ------------------------------------------------------------

  /** Look for the agent's transcript; true when this call found it. Never commits to a file it has not seen. */
  private resolve(a: Agent): boolean {
    if (a.path) return false
    const file = `agent-${a.id}.jsonl`
    for (const base of this.bases(a)) {
      const path = findUnder(base, file, RESOLVE_DEPTH)
      if (!path) continue
      this.found(a, path)
      return true
    }
    return false
  }

  /** The transcript is at `path`: tail it, and take what its sidecar knows that the hooks did not. */
  private found(a: Agent, path: string): void {
    a.path = path
    a.found = true
    a.meta = false
    this.readMeta(a)
  }

  /** `agent-<id>.meta.json`, beside the transcript; true when this call read it. */
  private readMeta(a: Agent): boolean {
    if (!a.path || a.meta) return false
    try {
      const meta = JSON.parse(readFileSync(sidecar(a.path), 'utf8')) as Record<string, unknown>
      const str = (k: string): string => (typeof meta[k] === 'string' ? (meta[k] as string).trim() : '')
      a.type ||= str('agentType')
      a.description ||= str('description').slice(0, 80)
      a.model ||= str('model') || str('pickedEffortModel')
      a.phase ||= str('workflowPhase').slice(0, 80)
      a.background ||= meta.requestShape === 'background'
      a.meta = true
      return true
    } catch {
      return false // no sidecar (an older CLI), or not written yet: the hooks' word stands
    }
  }

  /** The CLI's own word that an agent is done (`"finished": true` in its sidecar), once its transcript has gone quiet. */
  private finishedOnDisk(a: Agent, now: number): boolean {
    if (!a.path) return false
    try {
      if (now - statSync(a.path).mtimeMs < QUIET_MS) return false
      return (JSON.parse(readFileSync(sidecar(a.path), 'utf8')) as { finished?: unknown }).finished === true
    } catch {
      return false // no sidecar, or no transcript any more: the hooks' word stands
    }
  }

  /** The `subagents` folders the transcript can be under: beside the parent's transcript (a hook says where), else under every project folder. */
  private bases(a: Agent): string[] {
    if (!a.sessionId) return []
    if (a.parentTranscript) return [join(dirname(a.parentTranscript), a.sessionId, 'subagents')]
    try {
      return readdirSync(this.projectsDir).map((d) => join(this.projectsDir, d, a.sessionId, 'subagents'))
    } catch {
      return [] // no projects folder yet
    }
  }
}

const sidecar = (path: string): string => path.replace(/\.jsonl$/, '.meta.json')

function fresh(id: string, parent: string, p: HookPayload): Agent {
  return {
    id,
    kind: 'subagent',
    parent,
    type: String(p.agent_type ?? ''),
    description: '',
    task: '',
    model: '',
    phase: '',
    background: false,
    startedAt: Date.now(),
    endedAt: null,
    lastText: null,
    paused: false,
    held: false,
    found: false,
    path: null,
    sessionId: p.session_id ?? '',
    parentTranscript: p.transcript_path ?? null,
    meta: false,
    sidecarEnd: false
  }
}

function view({ path: _p, sessionId: _s, parentTranscript: _pt, meta: _m, sidecarEnd: _e, ...a }: Agent): AgentView {
  return a
}

/** `file` in `dir` or, failing that, in a folder under it, `depth` levels down at most. */
export function findUnder(dir: string, file: string, depth: number): string | null {
  const direct = join(dir, file)
  if (existsSync(direct)) return direct
  if (depth <= 0) return null
  let subs: string[]
  try {
    subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null // not there yet
  }
  for (const sub of subs) {
    const hit = findUnder(join(dir, sub), file, depth - 1)
    if (hit) return hit
  }
  return null
}

/** The refusal a stopped agent reads as its tool call's result (a PreToolUse deny). */
export function deny(reason: string): PreToolDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Refused: ${reason}.\nStop now: do not try another tool. Reply in one line that you were stopped, and what you had done so far.`
    }
  }
}
