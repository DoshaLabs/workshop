// Core as a second client of a Codex session's own app-server (phase 2 of
// docs/progress/2026-11-11-codex.md). The TUI in the session's terminal is the first client; both
// follow one thread, so core sees what the terminal shows without wrapping the CLI.
//
// The socket speaks JSON-RPC over a WebSocket (upgrade to /rpc), and the server makes the path a
// symlink into /private/tmp/codex-daemon-<uid>/ (macOS caps a socket path near 104 bytes), so core
// dials the symlink's target. Seen with codex-cli 0.167.1.
//
// Core answers ONE kind of server request, and only on purpose: an approval of the session's own
// thread (a command, a file change) the user clicked Allow or Deny for on its tile (phase 3,
// `answer`). Approvals go to every client and the first answer wins, so anything else (another
// thread's request, a question, a tool call, a token refresh) is never answered at all, not even
// with an error, which would count as an answer. An approval answered in the terminal first is
// dropped on `serverRequest/resolved` (sent to every client), or when the thread, once seen
// waiting on it, stops waiting, or when the turn ends or the socket closes.

import { existsSync, realpathSync } from 'node:fs'
import WebSocket from 'ws'
import { applyCodexItem, codexAsk, codexContext, codexDecision, codexStatus, codexWaitingOnApproval, pickThread, type CodexAsk, type CodexThread } from '@shared/codex'
import { codexThreadId } from '@shared/cli'
import type { SessionStatus } from '@shared/sessions'
import type { AgentView } from '@shared/agents'
import { CodexPack } from './codex-pack'
import { emptyTranscript, type Transcript } from '@shared/transcript'

/** Items read back when core joins a thread: about a screen and a half of a session tile. */
const HISTORY = 120
const RETRY_MS = [250, 500, 1000, 2000, 5000]
const CALL_MS = 10_000

export interface CodexLinkEvents {
  /** The thread the session runs, once found (core keeps it, to resume it after a reboot). */
  thread(threadId: string): void
  status(status: SessionStatus, needsYou: boolean): void
  /** A turn ended: the session finished and waits for you, as Claude Code's Stop. */
  turnDone(): void
  /** Codex's own name for the thread (as Claude Code's title). */
  title(name: string): void
  transcript(t: Transcript): void
  /** Context used, %. */
  context(pct: number): void
  /** An approval is waiting in the terminal: show it. `key` names it to `answer`. */
  ask(key: string, ask: CodexAsk): void
  /** That approval is gone, answered or not: stop showing it. */
  askGone(key: string): void
  /**
   * A thread item completed (commits are read from commands): live, or, missed live, read back at
   * its turn's end with when it completed. Each item once; never one read from history at join.
   */
  itemDone?(item: unknown, completedAtMs?: number | null, startedAtMs?: number | null): void
  /** The session's subagents (main/codex-pack.ts), as the wolfpack shows them. */
  agents?(list: AgentView[]): void
}

interface OpenRequest {
  /** The request's own id, as the server sent it (number or string): the reply carries it back. */
  rpcId: number | string
  method: string
  /** The thread it is about: the session's, or a subagent's. */
  threadId: string
  /** The thread was seen waiting on an approval since this request came. */
  seen: boolean
}

/** File-change items kept for the approval that follows them (their diffs are on the item). */
const KEEP_ITEMS = 32
/** Items already handed to `itemDone`, remembered so the turn's read-back does not repeat them. */
const KEEP_DONE = 500

export class CodexLink {
  private ws: WebSocket | null = null
  private stopped = false
  private tries = 0
  private retry: NodeJS.Timeout | null = null
  private next = 1
  private pending = new Map<number, { done: (r: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>()
  private threadId: string | null
  private joined = false
  private readonly t: Transcript
  /** The session's subagents: child threads on the same server, followed through this connection. */
  readonly pack: CodexPack
  private readonly requests = new Map<string, OpenRequest>()
  /** The running turn, from `turn/started` (null between turns, or before core saw one start). */
  private turnId: string | null = null
  private readonly done = new Set<string>()
  /** When core saw each running command start (item/started), for its window: some report durationMs 0. */
  private readonly started = new Map<string, number>()
  private readonly fileItems = new Map<string, unknown>()

  constructor(
    readonly sessionId: string,
    private readonly sock: string,
    private readonly cwd: string,
    knownThread: string,
    private readonly on: CodexLinkEvents
  ) {
    this.threadId = codexThreadId(knownThread)
    this.t = emptyTranscript(sessionId)
    this.pack = new CodexPack(sessionId, { call: (m, p) => this.call(m, p) }, {
      agents: (list) => this.on.agents?.(list),
      transcript: (t) => this.on.transcript(t),
      item: (method, item, at, startedAt) => {
        this.keepFileItem(item)
        if (method === 'item/started') this.sawStart(item)
        else this.itemDone(item, at, startedAt)
      }
    })
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.ws?.removeAllListeners()
    this.ws?.on('error', () => {})
    this.ws?.close()
    this.ws = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.fail(new Error('stopped'))
    }
    this.pending.clear()
    this.dropAll()
  }

  get transcript(): Transcript {
    return this.t
  }

  private later(): void {
    if (this.stopped || this.retry) return
    const ms = RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, ms)
  }

  private connect(): void {
    if (this.stopped || this.ws) return
    let target: string
    try {
      if (!existsSync(this.sock)) return this.later()
      target = realpathSync(this.sock)
    } catch {
      return this.later()
    }
    const ws = new WebSocket(`ws+unix://${target}:/rpc`, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 })
    this.ws = ws
    this.joined = false
    ws.on('open', () => void this.hello().catch(() => ws.close()))
    ws.on('message', (data) => this.message(String(data)))
    ws.on('error', () => {})
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      // A request belongs to the connection it came on: it cannot be answered on the next one.
      this.dropAll()
      this.pack.disconnected()
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.fail(new Error('closed'))
      }
      this.pending.clear()
      this.later()
    })
  }

  private call<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'))
    const id = this.next++
    return new Promise<T>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`${method}: no answer`))
      }, CALL_MS)
      this.pending.set(id, { done: done as (r: unknown) => void, fail, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private async hello(): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'workshop', title: null, version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['item/agentMessage/delta'] } })
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
    this.tries = 0
    await this.join()
  }

  /** Find the session's thread (by id once known, else among the loaded ones), subscribe, read its history. */
  private async join(): Promise<void> {
    while (!this.stopped && this.ws && !this.threadId) {
      const loaded = await this.call<{ data?: unknown[] }>('thread/loaded/list', {}).catch(() => ({ data: [] as unknown[] }))
      const threads: CodexThread[] = []
      for (const id of (loaded.data ?? []).filter((x): x is string => typeof x === 'string')) {
        const r = await this.call<{ thread?: CodexThread }>('thread/read', { threadId: id }).catch(() => null)
        if (r?.thread) threads.push(r.thread)
      }
      const mine = pickThread(threads, this.cwd)
      if (mine && codexThreadId(mine.id)) {
        this.threadId = mine.id
        this.on.thread(mine.id)
        break
      }
      await new Promise((r) => setTimeout(r, 750))
    }
    if (this.stopped || !this.ws || !this.threadId) return
    this.pack.setRoot(this.threadId)
    const resumed = await this.call<{ thread?: CodexThread }>('thread/resume', { threadId: this.threadId })
    this.joined = true
    const th = resumed.thread
    if (th?.name) this.on.title(th.name)
    const st = codexStatus(th?.status)
    if (st) this.on.status(st.status, st.needsYou)
    await this.history()
    this.pack.afterHistory()
    this.pack.rejoined()
  }

  private sawStart(item: unknown): void {
    const it = item as { type?: unknown; id?: unknown } | null
    if (it?.type !== 'commandExecution' || typeof it.id !== 'string' || this.started.has(it.id)) return
    this.started.set(it.id, Date.now())
    if (this.started.size > KEEP_ITEMS) this.started.delete(this.started.keys().next().value as string)
  }

  private itemDone(item: unknown, at: number | null, startedAt?: number | null): void {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || this.done.has(id)) return
    this.done.add(id)
    if (this.done.size > KEEP_DONE) this.done.delete(this.done.values().next().value as string)
    const seen = this.started.get(id)
    this.started.delete(id)
    this.on.itemDone?.(item, at, startedAt ?? seen ?? null)
  }

  /**
   * A turn ended: its items read back, for any the server stored but did not send live (seen on
   * 0.167.1: a thread's very first turn, a shell command, reached no subscriber). Commands go to
   * `itemDone` with when they ended; tool lines missed are added to the transcript.
   */
  private async readBack(turnId: string): Promise<void> {
    const r = await this.call<{ data?: { item?: unknown; completedAtMs?: number | null; startedAtMs?: number | null }[] }>('thread/items/list', { threadId: this.threadId, turnId, limit: 200 }).catch(() => null)
    let shown = false
    for (const e of r?.data ?? []) {
      if (e.completedAtMs == null) continue
      const it = e.item as { type?: unknown } | null
      const id = (e.item as { id?: unknown } | null)?.id
      if ((it?.type !== 'commandExecution' && it?.type !== 'fileChange') || typeof id !== 'string' || this.done.has(id)) continue
      if (applyCodexItem(this.t, e.item, true, e.completedAtMs)) shown = true
      this.itemDone(e.item, e.completedAtMs, e.startedAtMs)
    }
    if (shown) this.on.transcript(this.t)
  }

  private keepFileItem(item: unknown): void {
    const it = item as { type?: unknown; id?: unknown } | null
    if (it?.type !== 'fileChange' || typeof it.id !== 'string') return
    this.fileItems.delete(it.id)
    this.fileItems.set(it.id, it)
    while (this.fileItems.size > KEEP_ITEMS) this.fileItems.delete(this.fileItems.keys().next().value as string)
  }

  private async history(): Promise<void> {
    const r = await this.call<{ data?: { item?: unknown; completedAtMs?: number | null; startedAtMs?: number | null }[] }>('thread/items/list', { threadId: this.threadId, limit: HISTORY, sortDirection: 'desc' }).catch(() => null)
    if (!r?.data) return
    this.t.blocks = []
    for (const e of [...r.data].reverse()) {
      applyCodexItem(this.t, e.item, e.completedAtMs != null, e.completedAtMs ?? e.startedAtMs ?? Date.now())
      this.pack.onItem(e.item, false)
    }
    this.t.found = true
    this.on.transcript(this.t)
  }

  /**
   * The user clicked Allow or Deny for this approval on the tile: the only reply core ever sends to
   * a server request. False when it is gone (the terminal answered first) or not connected.
   */
  answer(key: string, allow: boolean): boolean {
    const r = this.requests.get(key)
    const ws = this.ws
    if (!r || !ws || ws.readyState !== WebSocket.OPEN) return false
    if (r.method === 'item/permissions/requestApproval') return false
    this.drop(key)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.rpcId, result: codexDecision(allow, r.method) }))
    return true
  }

  /**
   * Stop the running turn (⏸'s place on a Codex session, Colin, 11 Nov 2026: Codex cannot hold a
   * call from outside, so the head offers Stop): `turn/interrupt`, as Esc in the terminal. The
   * turn id is the one core saw start, else the newest turn still in progress. False when no
   * turn runs or the server is not reachable.
   */
  async interrupt(): Promise<boolean> {
    if (!this.joined || !this.threadId) return false
    let turnId = this.turnId
    if (!turnId) {
      const r = await this.call<{ data?: { id?: unknown; status?: unknown }[] }>('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc' }).catch(() => null)
      const t = r?.data?.[0]
      if (t && t.status === 'inProgress' && typeof t.id === 'string') turnId = t.id
    }
    if (!turnId) return false
    await this.call('turn/interrupt', { threadId: this.threadId, turnId })
    return true
  }

  private drop(key: string): void {
    if (!this.requests.delete(key)) return
    this.on.askGone(key)
  }

  private dropAll(threadId?: string): void {
    for (const [key, r] of [...this.requests]) if (!threadId || r.threadId === threadId) this.drop(key)
  }

  /** A thread's status changed: its approvals seen waiting are gone once it stops waiting. */
  private statusOf(threadId: string, status: unknown): void {
    const waiting = codexWaitingOnApproval(status)
    for (const [key, r] of [...this.requests]) {
      if (r.threadId !== threadId) continue
      if (waiting) r.seen = true
      else if (r.seen) this.drop(key)
    }
  }

  /** A subagent of this session (a child thread), for the wolfpack's kill and dismiss. */
  hasAgent(id: string): boolean {
    return this.pack.has(id)
  }

  /**
   * A server request: kept (and shown) if it is an approval of the session's thread or one of its
   * subagents' (as a Claude Code subagent's prompt is its session's); otherwise left alone.
   */
  private request(rpcId: number | string, method: string, params: Record<string, unknown>): void {
    if (!this.joined || !this.threadId) return
    const tid = typeof params.threadId === 'string' ? params.threadId : ''
    if (!this.pack.family().has(tid)) return
    const ask = codexAsk(method, params, tid, this.fileItems.get(String(params.itemId)))
    if (!ask) return
    const key = String(rpcId)
    if (this.requests.has(key)) return
    this.requests.set(key, { rpcId, method, threadId: tid, seen: false })
    this.on.ask(key, ask)
  }

  private message(raw: string): void {
    let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(Number(m.id))
      if (!p) return
      this.pending.delete(Number(m.id))
      clearTimeout(p.timer)
      if (m.error) p.fail(new Error(m.error.message ?? 'error'))
      else p.done(m.result ?? {})
      return
    }
    if (!m.method) return
    const p = m.params ?? {}
    // A request for the clients: an approval of ours is kept for the tile; never answered here.
    if (m.id !== undefined) return this.request(m.id, m.method, p)
    if (!this.joined) return
    // Answered by someone (the terminal, or core itself a moment ago), for any thread of ours.
    if (m.method === 'serverRequest/resolved') {
      if (p.requestId !== undefined && p.requestId !== null) this.drop(String(p.requestId))
      return
    }
    if (typeof p.threadId === 'string' && m.method === 'thread/status/changed') this.statusOf(p.threadId, p.status)
    if (typeof p.threadId === 'string' && m.method === 'turn/completed') this.dropAll(p.threadId)
    // Anything about another thread: a subagent's (the wolfpack), or one to look at once.
    if (p.threadId !== this.threadId) return this.pack.onNotification(m.method, p)
    switch (m.method) {
      case 'thread/status/changed': {
        const st = codexStatus(p.status)
        if (st) this.on.status(st.status, st.needsYou)
        break
      }
      case 'turn/started': {
        const turn = p.turn as { id?: unknown } | undefined
        if (typeof turn?.id === 'string') this.turnId = turn.id
        break
      }
      case 'turn/completed': {
        this.turnId = null
        const turn = p.turn as { id?: unknown } | undefined
        if (typeof turn?.id === 'string') void this.readBack(turn.id)
        this.on.turnDone()
        break
      }
      case 'thread/name/updated':
        if (typeof p.threadName === 'string' && p.threadName) this.on.title(p.threadName)
        break
      case 'item/started':
      case 'item/completed':
        this.keepFileItem(p.item)
        this.pack.onItem(p.item, true)
        if (m.method === 'item/started') this.sawStart(p.item)
        else this.itemDone(p.item, typeof p.completedAtMs === 'number' ? p.completedAtMs : null)
        if (applyCodexItem(this.t, p.item, m.method === 'item/completed')) {
          this.t.found = true
          this.on.transcript(this.t)
        }
        break
      case 'thread/tokenUsage/updated': {
        const pct = codexContext(p.tokenUsage)
        if (pct !== null) this.on.context(pct)
        break
      }
    }
  }
}
