// Helper sessions: the other half of a session's wolfpack. A session hands a piece of work to a
// background session of its own (`node "$WORKSHOP_HELPER" start "<prompt>"`, the workshop:helper
// skill) and carries on; the helper shows in the session's pack tile, its conversation tailed like
// any session's, and the session collects what it said with `result` or `wait`.
//
// A helper is the unchanged CLI's own background session: `claude --bg`, started by core in the
// parent's folder with the parent's model choice and permission mode, our --settings (so its hooks
// reach core) and its own door token (so core knows which helper a hook is from). Seen on Claude
// Code 2.1.322 (docs/progress/2026-11-11-wolfpack.md): --bg inherits the environment and honours
// --settings and --name, IGNORES --session-id ("--bg manages the session id"), and prints
// `backgrounded · <8 hex> · <name>`; the full id is the session_id of its first hook, which must
// start with those 8. Stopping one is the CLI's own `claude stop <id>`, which keeps its
// conversation (`claude attach <id>` brings it back): no wrapping, nothing private.
//
// Unlike deck's betas, a helper has no terminal in workshop and is not a top-level session: it
// lives under its parent and goes from the column with it (its process keeps running until it is
// stopped, as the CLI's background sessions do).

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { agentTranscriptId, typedPrompt, type AgentView } from '@shared/agents'
import { cleanModel } from '@shared/models'
import type { SessionRecord } from '@shared/sessions'
import type { FleetEntry } from './fleet'
import type { HookEvent, HookPayload, PreToolDecision } from './hooks'

const run = promisify(execFile)

interface Helper {
  id: string
  parent: string
  /** What `claude --bg` printed: the first 8 hex of its session id. */
  short: string
  /** Its CLI session id, from its first hook; '' until then. */
  sessionId: string
  name: string
  model: string
  prompt: string
  token: string
  startedAt: number
  endedAt: number | null
  lastText: string | null
  /** Stopped with `claude stop`: off the list, kept on disk only until its parent is gone. */
  stopped: boolean
  /** Waiting at a permission prompt or a question: it needs `claude attach`. */
  blocked: boolean
}

export interface HelperHost {
  env: NodeJS.ProcessEnv
  home: string
  settingsPath: string
  pluginDirs: () => string[]
  register(token: string, who: () => string, session: string): void
  revoke(token: string): void
  find(id: string): SessionRecord | null
}

/** Helpers one session may have at once (deck's pack size). */
export const HELPERS_MAX = 8
const PROMPT_MAX = 20_000

export class Helpers {
  private helpers: Helper[] = []
  private readonly store: string
  private readonly authDir: string

  constructor(
    private readonly host: HelperHost,
    private readonly emit: () => void
  ) {
    this.store = join(host.home, 'helpers.json')
    this.authDir = join(host.home, 'auth')
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 })
    this.load()
  }

  list(): AgentView[] {
    return this.helpers.filter((h) => !h.stopped).map(view)
  }

  has(id: string): boolean {
    return this.helpers.some((h) => h.id === id && !h.stopped)
  }

  /** The helper a door token belongs to (its hooks, and its own calls), or null. */
  byToken(token: string): { id: string; parent: string; sessionId: string } | null {
    const h = this.helpers.find((x) => x.token === token && !x.stopped)
    return h ? { id: h.id, parent: h.parent, sessionId: h.sessionId } : null
  }

  /** What the tails watch: each helper's transcript, found by its session id like any session's. */
  tails(): { id: string; path: null; sessionId: string }[] {
    return this.helpers.filter((h) => !h.stopped && h.sessionId).map((h) => ({ id: agentTranscriptId(h.id), path: null, sessionId: h.sessionId }))
  }

  /** A session's `workshop-helper` call (POST /core/helper), from `rec`. */
  async call(rec: SessionRecord, payload: unknown): Promise<unknown> {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const mine = (id: unknown): Helper => {
      const h = this.helpers.find((x) => x.id === String(id) && x.parent === rec.id)
      if (!h) throw new Error(`no helper "${String(id)}" of this session (list shows them)`)
      return h
    }
    switch (p.op) {
      case 'start':
        return this.start(rec, p)
      case 'list':
        return this.helpers.filter((h) => h.parent === rec.id).map(brief)
      case 'result': {
        const h = mine(p.id)
        return { ...brief(h), result: h.lastText }
      }
      case 'stop':
        await this.stop(mine(p.id).id)
        return { stopped: true }
      default:
        throw new Error('helper: start, list, result <id> or stop <id>')
    }
  }

  /** `claude --bg` in the parent's folder, with our settings and the helper's own token. */
  private async start(rec: SessionRecord, p: Record<string, unknown>): Promise<unknown> {
    const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : ''
    if (!prompt || prompt.length > PROMPT_MAX) throw new Error(`helper start: a prompt of 1 to ${PROMPT_MAX} characters`)
    if (this.helpers.filter((h) => h.parent === rec.id && !h.stopped && h.endedAt === null).length >= HELPERS_MAX) throw new Error(`helper start: at most ${HELPERS_MAX} helpers working at once`)
    const name = (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : prompt.split('\n')[0]).slice(0, 60)
    // A helper never runs with more than its parent may: the parent's permission mode, always.
    const model = cleanModel(typeof p.model === 'string' ? p.model : '') || rec.model
    const h: Helper = { id: `h${randomBytes(3).toString('hex')}`, parent: rec.id, short: '', sessionId: '', name, model, prompt, token: randomBytes(24).toString('hex'), startedAt: Date.now(), endedAt: null, lastText: null, stopped: false, blocked: false }
    this.writeAuth(h)
    this.host.register(h.token, () => `${this.host.find(h.parent)?.name ?? 'a session'} › ${h.name}`, h.parent)
    const args = ['--bg', '--settings', this.host.settingsPath, ...this.host.pluginDirs().flatMap((d) => ['--plugin-dir', d]), '--name', name]
    if (model) args.push('--model', model)
    if (rec.permissionMode) args.push('--permission-mode', rec.permissionMode)
    args.push(prompt)
    let out = ''
    try {
      const r = await run('claude', args, { cwd: rec.cwd, env: { ...this.host.env, WORKSHOP_AUTH: this.authFile(h), WORKSHOP_SESSION: rec.id, WORKSHOP_HELPER_OF: rec.id }, timeout: 30_000, maxBuffer: 1 << 20 })
      out = `${r.stdout}\n${r.stderr}`
    } catch (err) {
      this.forget(h)
      const e = err as { stderr?: string; message: string }
      throw new Error(`helper start: claude --bg failed: ${(e.stderr || e.message).trim().slice(0, 300)}`)
    }
    const short = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(out)?.[1]
    if (!short) {
      this.forget(h)
      throw new Error(`helper start: claude --bg did not say which session it started: ${out.trim().slice(0, 300)}`)
    }
    h.short = short
    this.helpers.push(h)
    this.save()
    this.emit()
    return brief(h)
  }

  /** A hook from a helper (by its token). Its first names its session id; after that, only that id counts. */
  onHook(token: string, event: HookEvent, p: HookPayload): void {
    const h = this.helpers.find((x) => x.token === token && !x.stopped)
    const sid = String(p.session_id ?? '')
    if (!h || !sid) return
    if (!h.sessionId) {
      if (!sid.startsWith(h.short)) return
      h.sessionId = sid
    } else if (sid !== h.sessionId) return
    if (p.agent_id) return // a helper's own subagents are not tracked (yet): its tile shows its conversation
    switch (event) {
      case 'Stop':
        h.endedAt = Date.now()
        h.blocked = false
        h.lastText = typeof p.last_assistant_message === 'string' ? p.last_assistant_message.slice(0, 20_000) : h.lastText
        break
      case 'UserPromptSubmit':
        // Someone attached and typed to it, or a background result came back: it works again.
        if (typedPrompt(p.prompt) || h.endedAt !== null) h.endedAt = null
        h.blocked = false
        break
      case 'Notification':
        if (p.notification_type === 'permission_prompt' || p.notification_type === 'elicitation_dialog') h.blocked = true
        break
      default:
        return
    }
    this.save()
    this.emit()
  }

  /**
   * The leash's seam for a helper: its PreToolUse comes with the helper's token (so `byToken`
   * names it) and no agent_id. Pause for a helper would hold here as `AgentTracker.preTool` does;
   * nothing is held until the leash wires it (see docs/progress/2026-11-11-wolfpack.md).
   */
  preTool(_token: string, _p: HookPayload): Promise<PreToolDecision | null> {
    return Promise.resolve(null)
  }

  /** The fleet poll: a helper the CLI lists as done has finished, one it no longer lists at all has ended. */
  onFleet(entries: FleetEntry[]): void {
    let changed = false
    for (const h of this.helpers) {
      if (h.stopped || !h.short) continue
      const e = entries.find((x) => x.sessionId === h.sessionId || (x as { id?: string }).id === h.short)
      if (!h.sessionId && e?.sessionId?.startsWith(h.short)) {
        h.sessionId = e.sessionId
        changed = true
      }
      const done = !e || e.state === 'done' || e.state === 'failed' || e.state === 'stopped'
      if (done && h.endedAt === null && Date.now() - h.startedAt > 10_000) {
        h.endedAt = Date.now()
        changed = true
      }
    }
    if (changed) {
      this.save()
      this.emit()
    }
  }

  /** Kill (or clear a finished one): `claude stop <id>`, the CLI's own; its conversation is kept, resumable with `claude attach`. */
  async stop(id: string): Promise<void> {
    const h = this.helpers.find((x) => x.id === id && !x.stopped)
    if (!h) throw new Error('no such helper')
    h.stopped = true
    this.save()
    this.emit()
    if (h.short) await run('claude', ['stop', h.short], { env: this.host.env, timeout: 15_000 }).catch((err: Error) => console.warn('[helpers] claude stop:', err.message))
    this.forget(h)
  }

  /**
   * A session that is gone for good (killed, not parked) takes its helpers with it: their processes
   * are stopped, never left running unseen. A parked session's helpers carry on, and are back
   * under it when it is.
   */
  keepParents(known: Set<string>): void {
    for (const h of [...this.helpers]) if (!h.stopped && !known.has(h.parent)) void this.stop(h.id)
  }

  private forget(h: Helper): void {
    this.host.revoke(h.token)
    rmSync(this.authFile(h), { force: true })
    this.helpers = this.helpers.filter((x) => x !== h)
    this.save()
  }

  private authFile(h: Helper): string {
    return join(this.authDir, `${h.id}.header`)
  }

  private writeAuth(h: Helper): void {
    writeFileSync(this.authFile(h), `Authorization: Bearer ${h.token}\n`, { mode: 0o600 })
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.store, 'utf8')) as { helpers?: Helper[] }
      this.helpers = (raw.helpers ?? []).filter((h) => h && /^h[0-9a-f]{6}$/.test(h.id) && /^[0-9a-f]{48}$/.test(h.token) && !h.stopped)
      for (const h of this.helpers) {
        this.writeAuth(h)
        this.host.register(h.token, () => `${this.host.find(h.parent)?.name ?? 'a session'} › ${h.name}`, h.parent)
      }
    } catch {
      this.helpers = [] // none yet
    }
  }

  private save(): void {
    try {
      const tmp = `${this.store}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ helpers: this.helpers }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.store)
    } catch (err) {
      console.warn('[helpers] could not write helpers.json:', err)
    }
  }
}

/** What the parent session is told of a helper: never its token. */
function brief(h: Helper): { id: string; name: string; status: 'working' | 'finished' | 'needs you' | 'stopped'; started: string; result?: string | null } {
  return { id: h.id, name: h.name, status: h.stopped ? 'stopped' : h.endedAt !== null ? 'finished' : h.blocked ? 'needs you' : 'working', started: new Date(h.startedAt).toISOString() }
}

function view(h: Helper): AgentView {
  return {
    id: h.id,
    kind: 'helper',
    parent: h.parent,
    type: 'helper',
    description: h.name,
    task: h.prompt.split('\n')[0].slice(0, 120),
    model: h.model,
    phase: '',
    background: true,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    lastText: h.lastText,
    paused: false,
    held: false,
    found: !!h.sessionId,
    needsYou: h.blocked,
    attach: h.short || undefined
  }
}
