// A Codex session's wolfpack (phase 3 item 4 of docs/progress/2026-11-11-codex.md): its subagents,
// which Codex runs as child threads on the session's own app-server, followed through the same
// connection as the session (main/codex-link.ts owns this and feeds it).
//
// Seen on codex-cli 0.167.1: the parent records each subagent as `subAgentActivity` items
// (`started`, `interacted`, `interrupted`, `completed`, with `agentThreadId` and `agentPath`); the
// child thread has `parentThreadId`, a nickname and `source.subAgent.thread_spawn`; no
// `thread/started` reached a second client for it. So a subagent is found from an activity item
// (or from a notification of a thread core does not know, read once), then subscribed with
// `thread/resume` and read back with `thread/items/list` on every turn's end, since its events can
// come before core subscribes. Nested subagents (a subagent's own) join the same pack.
//
// Kill, as a Claude Code subagent's: the tile goes at once, core stops following it, its running
// turn is interrupted (`turn/interrupt`), and the parent is told in one typed line (core-sessions
// pastes `killLine`). The interrupt alone is not enough on 0.167.1: the parent was not told, its
// `wait` timed out and it set the subagent going again; told, it interrupted it with its own tool
// and went on. There is no pause, as for the session (Codex cannot hold a call from outside).

import { applyCodexItem, codexActivity, codexAgentTask, codexChild, codexStatus, type CodexChild } from '@shared/codex'
import { agentTranscriptId, type AgentView } from '@shared/agents'
import { emptyTranscript, type Transcript } from '@shared/transcript'

const HISTORY = 120
/** A subagent just spawned may refuse `thread/resume` (seen on 0.167.1): tried again after these. */
const SUBSCRIBE_RETRY_MS = [500, 1000, 2000, 4000]
/** Threads read once and found not to be the family's: not read again. */
const KEEP_STRANGERS = 200

interface Child extends CodexChild {
  startedAt: number
  endedAt: number | null
  busy: boolean
  /** Waiting on an approval or a question. */
  needsYou: boolean
  turnId: string | null
  subscribed: boolean
  t: Transcript
  lastText: string | null
}

export interface PackRpc {
  call<T>(method: string, params: unknown): Promise<T>
}

export interface PackOut {
  /** The pack changed: every subagent, oldest first. */
  agents(list: AgentView[]): void
  transcript(t: Transcript): void
  /** A subagent's item started or completed (its approvals' diffs, its commands' commits). */
  item(method: 'item/started' | 'item/completed', item: unknown, completedAtMs: number | null, startedAtMs?: number | null): void
}

export class CodexPack {
  private root: string | null = null
  private readonly children = new Map<string, Child>()
  private readonly dismissed = new Set<string>()
  private readonly strangers = new Set<string>()
  private readonly reading = new Set<string>()

  constructor(
    private readonly sessionId: string,
    private readonly rpc: PackRpc,
    private readonly out: PackOut
  ) {}

  setRoot(id: string): void {
    this.root = id
  }

  /** The session's thread and its subagents' (an approval of any of them is the session's to show). */
  family(): Set<string> {
    const f = new Set(this.children.keys())
    if (this.root) f.add(this.root)
    return f
  }

  owns(threadId: string): boolean {
    return this.children.has(threadId)
  }

  has(id: string): boolean {
    return this.children.has(id)
  }

  list(): AgentView[] {
    return [...this.children.values()].sort((a, b) => a.startedAt - b.startedAt).map((c) => this.view(c))
  }

  /**
   * An item on the session's thread or a subagent's: a `subAgentActivity` finds, ends or revives
   * one. `live`: from a notification now; else read back (history at join), where only a subagent
   * still running is taken up, so a resumed session is not crowded with finished ones.
   */
  onItem(item: unknown, live: boolean): void {
    const a = codexActivity(item)
    if (!a || this.dismissed.has(a.thread)) return
    const c = this.children.get(a.thread)
    if (a.kind === 'started' || a.kind === 'interacted') {
      if (c) {
        if (c.endedAt !== null) {
          c.endedAt = null
          this.changed()
        }
      } else if (live) void this.discover(a.thread, a.model)
      else this.maybeRunning.add(a.thread)
      return
    }
    // completed or interrupted
    this.maybeRunning.delete(a.thread)
    if (c && c.endedAt === null) {
      c.endedAt = Date.now()
      c.busy = false
      c.needsYou = false
      this.changed()
    }
  }

  /** Subagents history says started and has not (yet) seen end: taken up once the read is done. */
  private readonly maybeRunning = new Set<string>()

  /** The session's history has been read: the subagents it left running are followed. */
  afterHistory(): void {
    for (const id of this.maybeRunning) void this.discover(id, '', true)
    this.maybeRunning.clear()
  }

  /** A notification about a thread that is not the session's: a subagent's, or one to look at once. */
  onNotification(method: string, p: Record<string, unknown>): void {
    const tid = typeof p.threadId === 'string' ? p.threadId : null
    if (method === 'thread/started') {
      const th = p.thread as { id?: unknown } | undefined
      if (typeof th?.id === 'string' && !this.children.has(th.id)) void this.take(p.thread)
      return
    }
    if (!tid) return
    const c = this.children.get(tid)
    if (!c) {
      if (!this.dismissed.has(tid)) void this.discover(tid, '')
      return
    }
    // Its events reach core (0.167.1 sends a subagent's to its parent's subscribers too).
    c.subscribed = true
    switch (method) {
      case 'thread/status/changed': {
        const st = codexStatus(p.status)
        if (!st) break
        const busy = st.status === 'busy' || st.status === 'blocked'
        if (busy && c.endedAt !== null) c.endedAt = null
        c.busy = busy
        c.needsYou = st.needsYou
        this.changed()
        break
      }
      case 'turn/started': {
        const turn = p.turn as { id?: unknown } | undefined
        if (typeof turn?.id === 'string') c.turnId = turn.id
        if (c.endedAt !== null) {
          c.endedAt = null
          this.changed()
        }
        break
      }
      case 'turn/completed':
        c.turnId = null
        c.busy = false
        c.needsYou = false
        if (c.endedAt === null) c.endedAt = Date.now()
        this.changed()
        void this.readBack(c)
        break
      case 'thread/closed':
        if (c.endedAt === null) {
          c.endedAt = Date.now()
          c.busy = false
          this.changed()
        }
        break
      case 'item/started':
      case 'item/completed': {
        const done = method === 'item/completed'
        this.out.item(method, p.item, done && typeof p.completedAtMs === 'number' ? p.completedAtMs : null)
        this.onItem(p.item, true)
        this.lastWords(c, p.item, done)
        if (applyCodexItem(c.t, p.item, done)) {
          const first = !c.t.found
          c.t.found = true
          this.out.transcript(c.t)
          if (first) this.changed()
        }
        break
      }
    }
  }

  /**
   * Kill (■, two clicks): the tile goes and the subagent is not followed again; its running turn,
   * if any, is interrupted. Returns what the parent must be told (`killLine`), or null if unknown.
   */
  async kill(id: string): Promise<{ name: string; path: string; running: boolean } | null> {
    const c = this.children.get(id)
    if (!c) return null
    const running = c.endedAt === null
    this.children.delete(id)
    this.dismissed.add(id)
    this.changed()
    if (running) await this.interruptTurn(c).catch(() => false)
    void this.rpc.call('thread/unsubscribe', { threadId: id }).catch(() => undefined)
    return { name: c.nick || codexAgentTask(c.path) || 'sub-agent', path: c.path, running }
  }

  private async interruptTurn(c: Child): Promise<boolean> {
    const id = c.id
    let turnId = c.turnId
    if (!turnId) {
      const r = await this.rpc.call<{ data?: { id?: unknown; status?: unknown }[] }>('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc' }).catch(() => null)
      const t = r?.data?.[0]
      if (t && t.status === 'inProgress' && typeof t.id === 'string') turnId = t.id
    }
    if (!turnId) return false
    await this.rpc.call('turn/interrupt', { threadId: id, turnId })
    return true
  }

  /** × : the tile forgets it (it is not followed again). */
  dismiss(id: string): boolean {
    if (!this.children.delete(id)) return false
    this.dismissed.add(id)
    void this.rpc.call('thread/unsubscribe', { threadId: id }).catch(() => undefined)
    this.changed()
    return true
  }

  /** The connection closed: subscriptions went with it. */
  disconnected(): void {
    for (const c of this.children.values()) c.subscribed = false
  }

  /** Joined again after a reconnect: every subagent still running is subscribed and read again. */
  rejoined(): void {
    for (const c of this.children.values()) if (c.endedAt === null) void this.subscribe(c)
  }

  private async discover(id: string, model: string, onlyRunning = false): Promise<void> {
    if (this.children.has(id) || this.reading.has(id) || this.strangers.has(id) || this.dismissed.has(id)) return
    this.reading.add(id)
    try {
      const r = await this.rpc.call<{ thread?: unknown }>('thread/read', { threadId: id }).catch(() => null)
      const th = r?.thread as { status?: unknown; model?: unknown } | undefined
      if (onlyRunning && codexStatus(th?.status)?.status !== 'busy' && codexStatus(th?.status)?.status !== 'blocked') return
      if (!(await this.take(th ? { ...th, model: th.model ?? model } : null))) {
        this.strangers.add(id)
        if (this.strangers.size > KEEP_STRANGERS) this.strangers.delete(this.strangers.values().next().value as string)
      }
    } finally {
      this.reading.delete(id)
    }
  }

  private async take(thread: unknown): Promise<boolean> {
    const k = codexChild(thread, this.family())
    if (!k || this.dismissed.has(k.id)) return false
    const st = codexStatus((thread as { status?: unknown }).status)
    const c: Child = {
      ...k,
      startedAt: Date.now(),
      endedAt: null,
      busy: st ? st.status === 'busy' || st.status === 'blocked' : true,
      needsYou: st?.needsYou ?? false,
      turnId: null,
      subscribed: false,
      t: emptyTranscript(agentTranscriptId(k.id)),
      lastText: null
    }
    this.children.set(k.id, c)
    this.changed()
    await this.subscribe(c)
    return true
  }

  private async subscribe(c: Child, attempt = 0): Promise<void> {
    if (c.subscribed && attempt === 0) return
    const r = await this.rpc.call<{ thread?: { status?: unknown } }>('thread/resume', { threadId: c.id, excludeTurns: true }).catch(() => null)
    if (!r) {
      if (attempt < SUBSCRIBE_RETRY_MS.length && this.children.get(c.id) === c) setTimeout(() => void this.subscribe(c, attempt + 1), SUBSCRIBE_RETRY_MS[attempt])
      // Its events may still come through its parent; its words are read back when its turn ends.
      return
    }
    c.subscribed = true
    const st = codexStatus(r.thread?.status)
    if (st) {
      c.busy = st.status === 'busy' || st.status === 'blocked'
      c.needsYou = st.needsYou
    }
    await this.readBack(c)
    // Idle when core caught up and no turn is open: it may have finished before core subscribed.
    if (!c.busy && c.turnId === null && c.endedAt === null && c.t.blocks.length) c.endedAt = Date.now()
    this.changed()
  }

  /** Its items read again (its events may have come before core subscribed): its conversation, its commands. */
  private async readBack(c: Child): Promise<void> {
    const r = await this.rpc.call<{ data?: { item?: unknown; completedAtMs?: number | null; startedAtMs?: number | null }[] }>('thread/items/list', { threadId: c.id, limit: HISTORY, sortDirection: 'desc' }).catch(() => null)
    if (!r?.data) return
    c.t.blocks = []
    for (const e of [...r.data].reverse()) {
      const done = e.completedAtMs != null
      applyCodexItem(c.t, e.item, done, e.completedAtMs ?? e.startedAtMs ?? Date.now())
      this.lastWords(c, e.item, done)
      if (done) this.out.item('item/completed', e.item, e.completedAtMs ?? null, e.startedAtMs)
      this.onItem(e.item, true)
    }
    c.t.found = true
    this.out.transcript(c.t)
  }

  private lastWords(c: Child, item: unknown, done: boolean): void {
    const it = item as { type?: unknown; text?: unknown } | null
    if (done && it?.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) c.lastText = it.text.trim()
  }

  private view(c: Child): AgentView {
    return {
      id: c.id,
      kind: 'subagent',
      cli: 'codex',
      parent: this.sessionId,
      type: c.role || 'codex',
      description: c.nick,
      task: codexAgentTask(c.path),
      model: c.model,
      phase: '',
      background: false,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      lastText: c.endedAt !== null ? c.lastText : null,
      paused: false,
      held: false,
      found: c.t.found,
      ...(c.needsYou ? { needsYou: true } : {})
    }
  }

  private last = ''
  private changed(): void {
    const list = this.list()
    const key = JSON.stringify(list)
    if (key === this.last) return
    this.last = key
    this.out.agents(list)
  }
}
