// The leash, and permission prompts answered from a session's tile (CLAUDE.md §9 item 1;
// docs/progress/2026-11-11-leash.md).
//
// THE LEASH. Pausing a session writes `<dir>/<id>.paused`. Its PreToolUse hook (leash.sh, written
// by hooks.ts) looks for that file first and, when it is not there, exits at once: an unpaused
// session never calls core for a tool call. When it is there, the hook POSTs /ask/pretool and the
// call waits on the answer: nothing when the user resumes (the call goes on), a deny when they
// refuse it. The pause is the file, so it survives core restarting: the hook retries a core that is
// not there, and the next core holds the call again. A call held an hour is refused by the hook.
//
// PERMISSION PROMPTS. The CLI runs PermissionRequest hooks while it shows its own dialog; whichever
// answers first wins (verified on 2.1.322). Core holds that hook's request (ask.sh) and answers it
// when the user clicks Allow or Deny on the tile. When the terminal answers first, core learns it
// from: the hook's request closing (a "No" or Esc kills the hook), the fleet poll leaving
// "waiting for permission prompt", the tool finishing (PostToolUse, posted only while a prompt is
// open: `<dir>/<id>.asking`), or the turn ending. Then the request is closed with no answer.
//
// Nothing here is reachable from a tile: answers come only over core's window's IPC.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answeredInTerminal,
  DENY_HELD,
  describeTool,
  leashDeny,
  permissionAnswer,
  sameCall,
  waitingOnPermission,
  type HeldCall,
  type LeashView,
  type PermissionAsk
} from '@shared/leash'

/** The answer to a held request: the hook's stdout, or null for none (204). */
type Answer = (body: string | null) => void

interface Hold {
  call: HeldCall
  answer: Answer
}

interface Ask {
  view: PermissionAsk
  call: { tool_name?: unknown; tool_input?: unknown }
  /** The fleet poll has seen the session waiting on a permission prompt since this one came. */
  seen: boolean
  answer: Answer
}

export interface ToolPayload {
  tool_name?: unknown
  tool_input?: unknown
}

export class Leash {
  private readonly holds = new Map<string, Set<Hold>>()
  private readonly asks = new Map<string, Ask[]>()

  constructor(
    /** `<profile>/leash`: the paused and asking files, named by core's session id. */
    readonly dir: string,
    /** A session's leash view changed. */
    private readonly changed: (id: string) => void
  ) {
    mkdirSync(dir, { recursive: true })
  }

  private file(id: string, kind: 'paused' | 'asking' | 'agents'): string {
    if (!/^[0-9a-f]{6,32}$/.test(id)) throw new Error('bad session id')
    return join(this.dir, `${id}.${kind}`)
  }

  paused(id: string): boolean {
    return existsSync(this.file(id, 'paused'))
  }

  pause(id: string): void {
    if (this.paused(id)) return
    writeFileSync(this.file(id, 'paused'), `${new Date().toISOString()}\n`)
    this.changed(id)
  }

  /** Let it go on: every held call proceeds. */
  resume(id: string): void {
    rmSync(this.file(id, 'paused'), { force: true })
    for (const h of [...(this.holds.get(id) ?? [])]) h.answer(null)
    this.changed(id)
  }

  /** Refuse the held calls (the session reads why) and stay paused. */
  refuseHeld(id: string): void {
    for (const h of [...(this.holds.get(id) ?? [])]) h.answer(leashDeny(DENY_HELD))
  }

  /** POST /ask/pretool: null at once unless the session is paused; then the call waits. */
  hold(id: string, payload: ToolPayload, gone: (cb: () => void) => void): Promise<string | null> {
    if (!this.paused(id)) return Promise.resolve(null)
    return new Promise((resolve) => {
      let set = this.holds.get(id)
      if (!set) this.holds.set(id, (set = new Set()))
      let done = false
      const h: Hold = {
        call: { ...describeTool(payload.tool_name, payload.tool_input), at: Date.now() },
        answer: (body) => {
          if (done) return
          done = true
          set!.delete(h)
          if (set!.size === 0) this.holds.delete(id)
          this.changed(id)
          resolve(body)
        }
      }
      set.add(h)
      // Esc in the terminal kills the hook, and with it the request: the call is no longer held.
      gone(() => h.answer(null))
      this.changed(id)
    })
  }

  /** POST /ask/permission: held until the tile answers or the terminal does. */
  ask(id: string, payload: ToolPayload, gone: (cb: () => void) => void): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false
      const a: Ask = {
        view: { id: randomUUID(), ...describeTool(payload.tool_name, payload.tool_input), at: Date.now() },
        call: { tool_name: payload.tool_name, tool_input: payload.tool_input },
        seen: false,
        answer: (body) => {
          if (done) return
          done = true
          const list = (this.asks.get(id) ?? []).filter((x) => x !== a)
          if (list.length) this.asks.set(id, list)
          else this.asks.delete(id)
          this.writeAsking(id)
          this.changed(id)
          resolve(body)
        }
      }
      this.asks.set(id, [...(this.asks.get(id) ?? []), a])
      this.writeAsking(id)
      gone(() => a.answer(null))
      this.changed(id)
    })
  }

  /** The user clicked Allow or Deny on the tile. False if that prompt is gone (the terminal answered first). */
  answer(id: string, askId: string, allow: boolean): boolean {
    const a = (this.asks.get(id) ?? []).find((x) => x.view.id === askId)
    if (!a) return false
    a.answer(permissionAnswer(allow))
    return true
  }

  /** The terminal answered every open prompt (the turn ended, a new prompt was typed). */
  settle(id: string): void {
    for (const a of [...(this.asks.get(id) ?? [])]) a.answer(null)
  }

  /** A tool call finished (PostToolUse): the prompt that asked about it was answered in the terminal. */
  settleCall(id: string, done: ToolPayload): void {
    for (const a of [...(this.asks.get(id) ?? [])]) if (sameCall(a.call, done)) a.answer(null)
  }

  /** A fleet poll row for the session (`claude agents --json`). */
  onFleet(id: string, entry: { status?: string; state?: string; waitingFor?: string } | undefined): void {
    const now = Date.now()
    for (const a of [...(this.asks.get(id) ?? [])]) {
      if (waitingOnPermission(entry)) a.seen = true
      else if (answeredInTerminal(entry, a.seen, now - a.view.at)) a.answer(null)
    }
  }

  view(id: string): LeashView {
    return {
      paused: this.paused(id),
      held: [...(this.holds.get(id) ?? [])].map((h) => h.call),
      asks: (this.asks.get(id) ?? []).map((a) => a.view)
    }
  }

  /** Whether any prompt is open (the session is waiting on the user). */
  asking(id: string): boolean {
    return (this.asks.get(id)?.length ?? 0) > 0
  }

  /** The session ended: no pause, no prompts. */
  forget(id: string): void {
    rmSync(this.file(id, 'paused'), { force: true })
    for (const h of [...(this.holds.get(id) ?? [])]) h.answer(null)
    this.settle(id)
    rmSync(this.file(id, 'asking'), { force: true })
  }

  /**
   * At start: files of sessions core no longer has go, and no prompt is open yet (a hook still
   * waiting on the core that quit retries, and its prompt comes back).
   */
  prune(known: Set<string>): void {
    for (const f of readdirSync(this.dir)) {
      const m = /^([0-9a-f]{6,32})\.(paused|asking|agents)$/.exec(f)
      if (!m) continue
      if (m[2] !== 'paused' || !known.has(m[1])) rmSync(join(this.dir, f), { force: true })
    }
  }

  /**
   * The sessions with a subagent paused or just killed (the wolfpack, main/agents.ts): their
   * `<id>.agents` makes leash.sh call core for every tool call, so a subagent's call can be held
   * or refused while its session is not paused. Every other session still makes no request.
   */
  markAgents(sessions: Set<string>): void {
    for (const f of readdirSync(this.dir)) {
      const m = /^([0-9a-f]{6,32})\.agents$/.exec(f)
      if (m && !sessions.has(m[1])) rmSync(join(this.dir, f), { force: true })
    }
    for (const id of sessions) if (!existsSync(this.file(id, 'agents'))) writeFileSync(this.file(id, 'agents'), '')
  }

  private writeAsking(id: string): void {
    const f = this.file(id, 'asking')
    if (this.asking(id)) writeFileSync(f, '')
    else rmSync(f, { force: true })
  }
}
