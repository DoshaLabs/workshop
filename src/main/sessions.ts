// The session manager. A session is the unchanged `claude` CLI in its own tmux session on the
// profile's private socket; exactly one client ever attaches to it, a node-pty here, drawn by
// xterm.js in the window. Closing a session parks it: the pty goes, tmux and the conversation stay,
// and it resumes in place (or with `claude --resume` after a reboot). State is authoritative here;
// the window is a view that sends commands. Carried over from deck's sessions.ts, without its slots,
// cap and wolfpack.
//
// Every session gets its own door token, in a 0600 file named by WORKSHOP_AUTH in its environment
// (never on a command line, where `ps` would show it to other users). Core knows from the token
// which session a hook or a door call came from.

import * as pty from 'node-pty'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanModel, cleanPermissionMode } from '@shared/models'
import { worktreeName, type NewSessionOpts, type SessionRecord, type SessionStatus, type SessionView, type SessionsState } from '@shared/sessions'
import type { FleetEntry } from './fleet'
import type { HookEvent, HookPayload } from './hooks'
import { NO_LEASH, type LeashView } from '@shared/leash'
import { Tmux, shq } from './tmux'

interface Stored extends SessionRecord {
  /** The door token behind this session's WORKSHOP_AUTH file. Never sent to the window. */
  token: string
}

interface Runtime {
  status: SessionStatus
  attention: boolean
  tmuxAlive: boolean
  title: string
  pty?: pty.IPty
  userDetached: boolean
  /**
   * Whether Claude's turn is open, as the hooks tell it. `claude agents --json` says busy while a
   * background shell outlives the turn, so a closed turn overrules the poll's busy (deck learned this).
   */
  turnOpen?: boolean
  cols?: number
  rows?: number
}

export interface SessionEvents {
  state(state: SessionsState): void
  data(id: string, data: string): void
  exit(id: string): void
}

export interface SessionManagerOptions {
  tmux: Tmux
  env: NodeJS.ProcessEnv
  /** The profile's folder: sessions.json and the auth files live here. */
  home: string
  profile: string
  /** The --settings file (main/hooks.ts). */
  settingsPath: string
  /** Every installed tile's plugin/ folder, handed to a NEW session with --plugin-dir. */
  pluginDirs: () => string[]
  /** Door tokens: a session's calls are attributed to it by name. */
  register(token: string, who: () => string, session: string): void
  revoke(token: string): void
  events: SessionEvents
  /** The leash and the permission prompts of a session (main/leash.ts), drawn on its tile. */
  leash?: (id: string) => LeashView
}

const SPAWN_COLS = 120
const SPAWN_ROWS = 40
/** Bracketed paste lands first; ⏎ follows a beat later. */
const PASTE_ENTER_MS = 40
const RECENT_KEEP = 10
const RECENT_SHOW = 6

/** `~` and `~/x` as the shell would read them; anything else as given, resolved. */
export function expandHome(p: string): string {
  const t = p.trim()
  if (t === '~') return homedir()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  return resolve(t)
}

export class SessionManager {
  private records: Stored[] = []
  private rt = new Map<string, Runtime>()
  private focusId: string | null = null
  private recentCwds: string[] = []
  private quitting = false
  private readonly storePath: string
  private readonly authDir: string
  private broadcastTimer: NodeJS.Timeout | null = null

  constructor(private readonly o: SessionManagerOptions) {
    mkdirSync(o.home, { recursive: true })
    this.storePath = join(o.home, 'sessions.json')
    this.authDir = join(o.home, 'auth')
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 })
  }

  // ---- lifecycle ---------------------------------------------------------

  async init(): Promise<void> {
    this.load()
    for (const rec of this.records) {
      this.writeAuth(rec)
      this.o.register(rec.token, () => rec.name, rec.id)
      const alive = await this.o.tmux.hasSession(rec.tmuxName)
      this.rt.set(rec.id, { status: alive ? 'unknown' : 'idle', attention: false, tmuxAlive: alive, title: '', userDetached: false })
      if (rec.open) {
        if (alive) this.attach(rec.id)
        else rec.open = false // tmux server gone (a reboot): parked, resumable with --resume
      }
    }
    this.ensureFocus()
    this.save()
    this.broadcast()
  }

  /** App quitting: drop the pty clients but keep sessions open, so the next launch reattaches them. */
  detachAll(): void {
    this.quitting = true
    for (const r of this.rt.values()) r.pty?.kill()
    this.save()
  }

  // ---- commands ----------------------------------------------------------

  async newSession(opts: NewSessionOpts): Promise<SessionView> {
    const cwd = expandHome(opts.cwd || homedir())
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a folder: ${cwd}`)
    const model = cleanModel(opts.model)
    const permissionMode = cleanPermissionMode(opts.permissionMode)
    const name = typeof opts.name === 'string' ? opts.name.trim().slice(0, 60) : ''
    const id = randomBytes(3).toString('hex')
    const rec: Stored = {
      id,
      tmuxName: `ws-${id}`,
      claudeSessionId: randomUUID(),
      cwd,
      worktree: !!opts.worktree,
      model,
      ...(permissionMode ? { permissionMode } : {}),
      name: name || (opts.worktree ? (worktreeName(opts.worktreeName) ?? 'new worktree') : 'new session'),
      createdAt: Date.now(),
      activeAt: Date.now(),
      open: true,
      token: randomBytes(24).toString('hex')
    }
    // `--worktree` takes an optional name, so it never stands where the next word could be read as
    // one (a first prompt with no other flag after it would become the worktree's name): bare, it
    // goes before --session-id; named, it is one word.
    const wtName = rec.worktree ? worktreeName(opts.worktreeName) : null
    if (rec.worktree && opts.worktreeName !== undefined && opts.worktreeName !== '' && !wtName) throw new Error(`Not a worktree name: ${String(opts.worktreeName).slice(0, 80)}`)
    const args = rec.worktree ? (wtName ? [`--worktree=${wtName}`] : ['--worktree']) : []
    args.push('--session-id', rec.claudeSessionId)
    if (model) args.push('--model', model)
    if (name) args.push('--name', name)
    if (permissionMode) args.push('--permission-mode', permissionMode)
    if (opts.prompt) args.push(String(opts.prompt))
    this.writeAuth(rec)
    this.o.register(rec.token, () => rec.name, rec.id)
    await this.o.tmux.newSession({ name: rec.tmuxName, cwd, command: this.claudeCommand(rec, args), cols: SPAWN_COLS, rows: SPAWN_ROWS })
    this.records.push(rec)
    this.touchRecent(cwd)
    this.rt.set(id, { status: 'starting', attention: false, tmuxAlive: true, title: '', userDetached: false })
    this.attach(id)
    this.focusId = id
    this.save()
    this.broadcast()
    return this.view(id)!
  }

  async resume(id: string): Promise<void> {
    const rec = this.get(id)
    const r = this.rt.get(id)!
    if (rec.open) {
      this.focus(id)
      return
    }
    r.tmuxAlive = await this.o.tmux.hasSession(rec.tmuxName)
    if (!r.tmuxAlive) {
      if (!existsSync(rec.cwd)) throw new Error(`Folder no longer exists: ${rec.cwd}`)
      // The CLI re-enters a --worktree session's worktree on --resume by itself. The model and the
      // permission mode are ours to repeat: --resume alone falls back to the CLI's defaults.
      const args = ['--resume', rec.claudeSessionId]
      if (rec.model) args.push('--model', rec.model)
      if (rec.permissionMode) args.push('--permission-mode', rec.permissionMode)
      await this.o.tmux.newSession({ name: rec.tmuxName, cwd: rec.cwd, command: this.claudeCommand(rec, args), cols: SPAWN_COLS, rows: SPAWN_ROWS })
      r.tmuxAlive = true
      r.status = 'starting'
    }
    this.touchRecent(rec.cwd)
    rec.activeAt = Date.now()
    rec.open = true
    this.attach(id)
    this.focusId = id
    this.save()
    this.broadcast()
  }

  /** Close in the window: the tmux session and the conversation stay, resumable. */
  park(id: string): void {
    const rec = this.get(id)
    const r = this.rt.get(id)!
    r.userDetached = true
    if (r.pty) r.pty.kill() // handlePtyExit parks it
    else this.parked(rec)
  }

  /** Kill the tmux session and forget the session entirely. */
  async kill(id: string): Promise<void> {
    const rec = this.get(id)
    const r = this.rt.get(id)
    if (r) {
      r.userDetached = true
      r.pty?.kill()
    }
    await this.o.tmux.killSession(rec.tmuxName)
    this.remove(id)
  }

  focus(id: string | null): void {
    if (id !== null && !this.records.some((r) => r.id === id && r.open)) return
    this.focusId = id
    this.broadcast()
  }

  // ---- pty i/o -----------------------------------------------------------

  input(id: string, data: string): void {
    const r = this.rt.get(id)
    if (!r?.pty) return
    r.pty.write(data)
    if (data.includes('\r')) {
      const rec = this.records.find((x) => x.id === id)
      if (rec) rec.activeAt = Date.now()
    }
    if (r.attention) {
      r.attention = false
      this.broadcast()
    }
  }

  /** Paste a prompt into a session and submit it (bracketed paste, then ⏎ a beat later). */
  paste(id: string, text: string): void {
    this.input(id, `\x1b[200~${text}\x1b[201~`)
    setTimeout(() => this.input(id, '\r'), PASTE_ENTER_MS)
  }

  resize(id: string, cols: number, rows: number): void {
    const r = this.rt.get(id)
    if (!r?.pty || !(cols >= 2) || !(rows >= 2)) return
    r.cols = cols
    r.rows = rows
    try {
      r.pty.resize(cols, rows)
    } catch {
      // pty already gone
    }
  }

  setTitle(id: string, title: string): void {
    const r = this.rt.get(id)
    // tmux's pane title is the host name until Claude Code sets one of its own: not a title.
    if (title === hostname() || title === hostname().replace(/\.local$/, '')) title = ''
    if (!r || r.title === title) return
    r.title = String(title).slice(0, 200)
    this.broadcast()
  }

  bell(id: string): void {
    const r = this.rt.get(id)
    if (!r || r.attention) return
    r.attention = true
    this.broadcast()
  }

  // ---- signals: the fleet poll and the hooks ------------------------------

  onFleet(entries: FleetEntry[]): void {
    const byId = new Map(entries.filter((e) => e.sessionId).map((e) => [e.sessionId, e]))
    let changed = false
    for (const rec of this.records) {
      const r = this.rt.get(rec.id)
      if (!r) continue
      const e = byId.get(rec.claudeSessionId)
      if (e) {
        let status = normalizeStatus(e.status ?? e.state)
        if (status === 'busy' && r.turnOpen === false) status = 'idle'
        if (status === 'idle') r.turnOpen = false
        if (status !== r.status) {
          r.status = status
          changed = true
        }
        if (e.name && e.name !== rec.name) {
          rec.name = e.name
          changed = true
        }
        if (status === 'blocked' && !r.attention) {
          r.attention = true
          changed = true
        }
      } else if (rec.open && r.pty && r.status !== 'starting') {
        // Attached but not listed: probably a dead pane (a crash) or the CLI exited.
        void this.o.tmux.paneDead(rec.tmuxName).then((dead) => {
          if (dead && r.status !== 'dead') {
            r.status = 'dead'
            r.attention = true
            this.broadcast()
          }
        })
      }
    }
    if (changed) {
      this.save()
      this.broadcast()
    }
  }

  /** A hook from a session. `sessionId` is the one its token belongs to; the payload must agree. */
  onHook(event: HookEvent, payload: HookPayload): void {
    const rec = this.records.find((x) => x.claudeSessionId === payload.session_id)
    const r = rec && this.rt.get(rec.id)
    if (!rec || !r) return
    rec.activeAt = Date.now()
    switch (event) {
      case 'Notification':
        r.attention = true
        if (payload.notification_type === 'permission_prompt' || payload.notification_type === 'elicitation_dialog') r.status = 'blocked'
        break
      case 'Stop':
        r.attention = true
        r.status = 'idle'
        r.turnOpen = false
        break
      case 'UserPromptSubmit':
        r.attention = false
        r.status = 'busy'
        r.turnOpen = true
        break
    }
    this.broadcast()
  }

  // ---- state -------------------------------------------------------------

  /** The session a door token belongs to, or null (a caller outside any session). */
  byToken(token: string): SessionRecord | null {
    return this.records.find((r) => r.token === token) ?? null
  }

  find(id: string): SessionRecord | null {
    return this.records.find((r) => r.id === id) ?? null
  }

  view(id: string): SessionView | null {
    return this.getState().sessions.find((s) => s.id === id) ?? null
  }

  getState(): SessionsState {
    const views: SessionView[] = this.records.map(({ token: _token, ...rec }) => {
      const r = this.rt.get(rec.id)
      const leash = this.o.leash?.(rec.id) ?? NO_LEASH
      // A permission prompt open in the terminal: the session needs you, whatever the poll last said.
      const asking = leash.asks.length > 0
      return { ...rec, title: r?.title || null, status: asking ? 'blocked' : (r?.status ?? 'unknown'), attention: asking || (r?.attention ?? false), attached: !!r?.pty, tmuxAlive: r?.tmuxAlive ?? false, leash }
    })
    const open = views.filter((v) => v.open).sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt))
    const parked = views.filter((v) => !v.open).sort((a, b) => b.createdAt - a.createdAt)
    return { focus: this.focusId, sessions: [...open, ...parked], recent: this.recentCwds.filter((d) => existsSync(d)).slice(0, RECENT_SHOW), profile: this.o.profile }
  }

  // ---- internals ---------------------------------------------------------

  private authFile(rec: Stored): string {
    return join(this.authDir, `${rec.id}.header`)
  }

  /** The session's token as a curl header file (`curl -H @file`), readable by this user only. */
  private writeAuth(rec: Stored): void {
    writeFileSync(this.authFile(rec), `Authorization: Bearer ${rec.token}\n`, { mode: 0o600 })
  }

  private touchRecent(cwd: string): void {
    this.recentCwds = [cwd, ...this.recentCwds.filter((d) => d !== cwd)].slice(0, RECENT_KEEP)
  }

  private claudeCommand(rec: Stored, args: string[]): string {
    // exec, so the pane's process IS claude (a clean exit ends the tmux session). --settings merges
    // with the user's own; each tile's plugin/ is added beside the user's installed plugins.
    const env = ['env', `WORKSHOP_AUTH=${this.authFile(rec)}`, `WORKSHOP_SESSION=${rec.id}`]
    const plugins = this.o.pluginDirs().flatMap((d) => ['--plugin-dir', d])
    const parts = [...env, 'claude', '--settings', this.o.settingsPath, ...plugins, ...args]
    return 'exec ' + parts.map(shq).join(' ')
  }

  private attach(id: string): void {
    const rec = this.get(id)
    const r = this.rt.get(id)!
    r.userDetached = false
    const p = pty.spawn('tmux', [...this.o.tmux.cliPrefix, 'attach-session', '-t', rec.tmuxName], {
      name: 'xterm-256color',
      cols: r.cols ?? SPAWN_COLS,
      rows: r.rows ?? SPAWN_ROWS,
      cwd: this.o.env.HOME ?? '/',
      env: this.o.env as Record<string, string>
    })
    r.pty = p
    p.onData((d) => this.o.events.data(id, d))
    p.onExit(() => void this.handlePtyExit(id))
  }

  private async handlePtyExit(id: string): Promise<void> {
    const r = this.rt.get(id)
    const rec = this.records.find((x) => x.id === id)
    if (!r || !rec) return
    r.pty = undefined
    this.o.events.exit(id)
    if (this.quitting) return
    const alive = await this.o.tmux.hasSession(rec.tmuxName)
    r.tmuxAlive = alive
    if (alive && !r.userDetached) {
      this.attach(id) // the client died but the session is fine (rare): reattach in place
      return
    }
    this.parked(rec)
  }

  private parked(rec: Stored): void {
    const r = this.rt.get(rec.id)
    if (r) {
      r.attention = false
      r.status = 'idle'
      r.userDetached = false
    }
    rec.open = false
    if (this.focusId === rec.id) this.focusId = null
    this.ensureFocus()
    this.save()
    this.broadcast()
  }

  private remove(id: string): void {
    const rec = this.records.find((x) => x.id === id)
    if (rec) {
      this.o.revoke(rec.token)
      rmSync(this.authFile(rec), { force: true })
    }
    this.records = this.records.filter((x) => x.id !== id)
    this.rt.delete(id)
    if (this.focusId === id) this.focusId = null
    this.ensureFocus()
    this.save()
    this.broadcast()
  }

  private ensureFocus(): void {
    if (this.focusId && this.records.some((r) => r.id === this.focusId && r.open)) return
    const open = this.getState().sessions.filter((s) => s.open)
    this.focusId = (open.find((s) => s.attention) ?? open[0])?.id ?? null
  }

  private get(id: string): Stored {
    const rec = this.records.find((r) => r.id === id)
    if (!rec) throw new Error(`No such session: ${id}`)
    return rec
  }

  private load(): void {
    try {
      if (!existsSync(this.storePath)) return
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as { records?: Stored[]; focus?: string | null; recentCwds?: string[] }
      this.records = (raw.records ?? []).filter((r) => r && /^[0-9a-f]{6}$/.test(r.id) && r.tmuxName === `ws-${r.id}` && r.claudeSessionId && /^[0-9a-f]{48}$/.test(r.token))
      this.focusId = raw.focus ?? null
      this.recentCwds = (raw.recentCwds ?? []).filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, RECENT_KEEP)
    } catch (err) {
      console.warn('[sessions] could not read sessions.json:', err)
      this.records = []
    }
  }

  private save(): void {
    try {
      const tmp = `${this.storePath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ records: this.records, focus: this.focusId, recentCwds: this.recentCwds }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.storePath)
    } catch (err) {
      console.warn('[sessions] could not write sessions.json:', err)
    }
  }

  /** A permission prompt was answered from the tile: the call goes on, the session is working. */
  working(id: string): void {
    const r = this.rt.get(id)
    if (!r) return
    r.status = 'busy'
    r.attention = false
    this.broadcast()
  }

  /** Something drawn on a session changed outside the manager (the leash): tell the window. */
  changed(): void {
    this.broadcast()
  }

  private broadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.o.events.state(this.getState())
    }, 30)
  }
}

export function normalizeStatus(raw: string | undefined): SessionStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'busy':
    case 'working':
    case 'running':
      return 'busy'
    case 'idle':
    case 'completed':
    case 'stopped':
      return 'idle'
    case 'blocked':
    case 'waiting':
    case 'needs_input':
    case 'needs-input':
      return 'blocked'
    case 'failed':
    case 'error':
      return 'dead'
    default:
      return 'unknown'
  }
}
