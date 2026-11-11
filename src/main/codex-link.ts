// Core as a second client of a Codex session's own app-server (phase 2 of
// docs/progress/2026-11-11-codex.md). The TUI in the session's terminal is the first client; both
// follow one thread, so core sees what the terminal shows without wrapping the CLI.
//
// The socket speaks JSON-RPC over a WebSocket (upgrade to /rpc), and the server makes the path a
// symlink into /private/tmp/codex-daemon-<uid>/ (macOS caps a socket path near 104 bytes), so core
// dials the symlink's target. Seen with codex-cli 0.167.1.
//
// Core NEVER answers a server request here. Approvals go to every client and the first answer
// wins, so even an error from core would decide one; the terminal answers until the leash for
// Codex (phase 3) answers on purpose.

import { existsSync, realpathSync } from 'node:fs'
import WebSocket from 'ws'
import { applyCodexItem, codexContext, codexStatus, pickThread, type CodexThread } from '@shared/codex'
import { codexThreadId } from '@shared/cli'
import type { SessionStatus } from '@shared/sessions'
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
}

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

  constructor(
    readonly sessionId: string,
    private readonly sock: string,
    private readonly cwd: string,
    knownThread: string,
    private readonly on: CodexLinkEvents
  ) {
    this.threadId = codexThreadId(knownThread)
    this.t = emptyTranscript(sessionId)
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
    const resumed = await this.call<{ thread?: CodexThread }>('thread/resume', { threadId: this.threadId })
    this.joined = true
    const th = resumed.thread
    if (th?.name) this.on.title(th.name)
    const st = codexStatus(th?.status)
    if (st) this.on.status(st.status, st.needsYou)
    await this.history()
  }

  private async history(): Promise<void> {
    const r = await this.call<{ data?: { item?: unknown; completedAtMs?: number | null; startedAtMs?: number | null }[] }>('thread/items/list', { threadId: this.threadId, limit: HISTORY, sortDirection: 'desc' }).catch(() => null)
    if (!r?.data) return
    this.t.blocks = []
    for (const e of [...r.data].reverse()) applyCodexItem(this.t, e.item, e.completedAtMs != null, e.completedAtMs ?? e.startedAtMs ?? Date.now())
    this.t.found = true
    this.on.transcript(this.t)
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
    // A request for the clients (an approval…): never answered here (see the top of this file).
    if (m.id !== undefined || !m.method) return
    const p = m.params ?? {}
    if (!this.joined || p.threadId !== this.threadId) return
    switch (m.method) {
      case 'thread/status/changed': {
        const st = codexStatus(p.status)
        if (st) this.on.status(st.status, st.needsYou)
        break
      }
      case 'turn/completed':
        this.on.turnDone()
        break
      case 'thread/name/updated':
        if (typeof p.threadName === 'string' && p.threadName) this.on.title(p.threadName)
        break
      case 'item/started':
      case 'item/completed':
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
