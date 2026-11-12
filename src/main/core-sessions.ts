// Sessions in core: the tmux server, the session manager, the fleet poll, the hooks (routed by
// each session's token through the door's server), usage, and the IPC core's window drives them
// with. main/index.ts starts it and hands tiles what their permissions allow.

import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { isSession, type NewSessionOpts, type SessionView, type SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import type { Door } from './door'
import { findInPath, shellEnv } from './env'
import { Fleet } from './fleet'
import { HOOK_ROUTES, SessionSettings, type HookPayload } from './hooks'
import { SessionManager } from './sessions'
import { Tmux } from './tmux'
import { TranscriptWatcher } from './transcript'
import { UsageTracker } from './usage'
import { startPreview } from './preview'
import { startViewer } from './viewer'
import { keepImage } from './drops'
import { CommitRecorder, CommitStore, codexShellCall, type CommitRecord } from './commits'
import { codexKillLine } from '@shared/codex'
import { doorTools, type DoorTile } from '@shared/door-tools'
import { Leash } from './leash'
import { CodexLink } from './codex-link'
import { AgentTracker } from './agents'
import { Helpers } from './helpers'
import { agentTranscriptId, type AgentsState, type AgentView } from '@shared/agents'
import type { Transcript } from '@shared/transcript'

export interface CoreSessions {
  sessions: SessionManager
  usage: UsageTracker
  tmux: Tmux
  settings: SessionSettings
  transcripts: TranscriptWatcher
  /** The wolfpack's subagents (main/agents.ts). */
  agents: AgentTracker
  /** The wolfpack's helper sessions (main/helpers.ts). */
  helpers: Helpers
  /** Every open session's subagents and helpers, as the window shows them. */
  agentsState(): AgentsState
  /** Which session made which commit, as far as core saw (main/commits.ts). */
  commits: CommitRecorder
  /** Route a /hook/<name> call (the door's server hands them here). */
  hook(name: string, token: string, payload: unknown): void
  /** A /core/<name> call from a session (the preview pane's `doc`); answered. Sessions only. */
  call(name: string, token: string, payload: unknown): Promise<unknown>
  /** An /ask/<name> hook, held on purpose: the leash (`pretool`) and permission prompts (`permission`). */
  ask(name: string, token: string, payload: unknown, gone: (cb: () => void) => void): Promise<string | null>
  /** The leash and permission prompts (main/leash.ts). */
  leash: Leash
  stop(): void
}

export interface Options {
  win: () => BrowserWindow | null
  door: Door
  home: string
  profile: string
  /** Where core's own files are (tmux.conf, bin/): the repo in dev, Contents/Resources packaged (main/resources.ts). */
  appPath: string
  /** Every tile's plugin/ folder. */
  pluginDirs: () => string[]
  dark: boolean
  /** No fleet poll (the smoke test has no real sessions to poll for). */
  poll: boolean
  /** A folder put first on the sessions' PATH (the smoke test's stand-in `claude`). */
  pathFirst?: string
  /** CLAUDE_CONFIG_DIR for the sessions (the smoke test's stand-in writes its transcripts there). */
  claudeConfigDir?: string
  /** State changed: the window gets it here; core also tells tiles. */
  onState: (s: SessionsState) => void
  onUsage: (u: Usage) => void
  /** Core recorded a commit a session made: the whole list of records. */
  onCommits?: (all: CommitRecord[]) => void
  /** A transcript changed (a session's, or `agent:<id>`): tiles with "transcripts" may hear of it. */
  onTranscript?: (t: Transcript) => void
  /** The installed tiles with door ops, and their skills: a Codex session's MCP tools (`/core/tools`). */
  doorTiles?: () => Promise<DoorTile[]>
}

export async function startSessions(o: Options): Promise<CoreSessions> {
  const env = { ...shellEnv() }
  if (o.pathFirst) env.PATH = `${o.pathFirst}:${env.PATH ?? ''}`
  if (o.claudeConfigDir) env.CLAUDE_CONFIG_DIR = o.claudeConfigDir
  const tmux = new Tmux(o.profile, join(o.appPath, 'tmux.conf'), env)
  const settings = new SessionSettings(o.home, join(o.appPath, 'bin', 'workshop-tile.mjs'))
  settings.setDark(o.dark)
  settings.setPort(o.door.port)

  const send = (ch: string, ...a: unknown[]): void => {
    const w = o.win()
    if (w && !w.isDestroyed()) w.webContents.send(ch, ...a)
  }

  // Where the CLI the sessions run writes its transcripts: its config folder, as the sessions see it.
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  let agents: AgentTracker | null = null
  let helpers: Helpers | null = null
  const transcripts = new TranscriptWatcher(projects, (t) => {
    sessionsRef?.onTurn(t.id, t.turn)
    send(CH.transcriptChanged, t)
    agents?.onTranscript(t)
    o.onTranscript?.(t)
  })
  const watchOpen = (s: SessionsState): void => {
    const open = s.sessions.filter((x) => x.open)
    // Claude Code's transcripts only: a Codex session's conversation comes from its app-server (Codex plan, phase 2).
    transcripts.sync(open.filter((x) => x.cli !== 'codex').map((x) => ({ id: x.id, cliSessionId: x.cliSessionId })))
    agents?.keepParents(new Set(open.map((x) => x.id)))
    helpers?.keepParents(new Set(s.sessions.map((x) => x.id)))
    syncCodex(open.filter((x) => x.cli === 'codex' && x.tmuxAlive))
  }

  // Codex sessions: core is a second client of each one's app-server while it is open (main/codex-link.ts).
  const codexLinks = new Map<string, CodexLink>()
  /** Each open Codex session's subagents, as its link last reported them. */
  const codexAgents = new Map<string, AgentView[]>()
  let agentsStateRef: (() => AgentsState) | null = null
  /** The link that follows a Codex subagent. */
  const codexAgentLink = (agentId: string): CodexLink | undefined => [...codexLinks.values()].find((l) => l.hasAgent(agentId))
  /** `<session id>:<request key>` → drops that approval from the session's asks. */
  const codexAsks = new Map<string, () => void>()
  const syncCodex = (live: SessionView[]): void => {
    const keep = new Set(live.map((x) => x.id))
    for (const [id, link] of codexLinks) {
      if (keep.has(id)) continue
      link.stop()
      codexLinks.delete(id)
      transcripts.drop(id)
      for (const a of codexAgents.get(id) ?? []) transcripts.drop(agentTranscriptId(a.id))
      if (codexAgents.delete(id)) send(CH.agentsState, agentsStateRef?.())
    }
    for (const v of live) {
      if (codexLinks.has(v.id) || !sessionsRef) continue
      const id = v.id
      const link = new CodexLink(id, sessionsRef.codexSocket(v), v.cwd, v.cliSessionId, {
        thread: (tid) => sessionsRef?.setCodexThread(id, tid),
        status: (st, needsYou) => sessionsRef?.codexStatus(id, st, needsYou),
        turnDone: () => sessionsRef?.codexTurnDone(id),
        title: (name) => sessionsRef?.setTitle(id, name),
        transcript: (t) => transcripts.put(t),
        context: (pct) => usageRef?.setContext(id, pct),
        limits: (snap) => usageRef?.setCodex(snap),
        // An approval in the terminal, shown on the tile beside it; the link answers only on a click.
        ask: (key, a) => {
          const { answerable, ...call } = a
          codexAsks.set(`${id}:${key}`, leash.offer(id, call, (allow) => void link.answer(key, allow), { terminal: !answerable }))
        },
        askGone: (key) => {
          codexAsks.get(`${id}:${key}`)?.()
          codexAsks.delete(`${id}:${key}`)
        },
        // A command finished: if it made commits, they are this session's (as a Claude session's PostToolUse on Bash).
        itemDone: (item, at, startedAt) => {
          const call = codexShellCall(item, at, startedAt)
          const rec = call && sessionsRef?.find(id)
          if (rec && commitsRef) void commitsRef.onShell({ id, name: rec.name }, call).catch((err) => console.warn('[workshop] commits:', err))
        },
        // Its subagents (child threads), in the wolfpack beside Claude Code sessions' own.
        agents: (list) => {
          const gone = (codexAgents.get(id) ?? []).filter((a) => !list.some((b) => b.id === a.id))
          for (const a of gone) transcripts.drop(agentTranscriptId(a.id))
          codexAgents.set(id, list)
          send(CH.agentsState, agentsStateRef?.())
        }
      })
      codexLinks.set(id, link)
      link.start()
    }
  }
  let usageRef: UsageTracker | null = null
  let commitsRef: CommitRecorder | null = null

  // The leash and permission prompts. Its view is part of each session's state; a change is drawn at once.
  let sessionsRef: SessionManager | null = null
  const leash = new Leash(settings.leashDir, () => sessionsRef?.changed())

  const sessions = new SessionManager({
    tmux,
    env,
    home: o.home,
    profile: o.profile,
    settingsPath: settings.path,
    pluginDirs: o.pluginDirs,
    cliEnv: () => settings.sessionEnv(),
    register: (t, who, session) => o.door.register(t, who, session),
    revoke: (t) => o.door.revoke(t),
    leash: (id) => leash.view(id),
    events: {
      state: (s) => {
        watchOpen(s)
        send(CH.sessionsState, s)
        o.onState(s)
      },
      data: (id, d) => send(CH.ptyData, id, d),
      exit: (id) => send(CH.ptyExit, id)
    }
  })
  const usage = new UsageTracker(join(o.home, 'usage.json'), (u) => {
    send(CH.usageChanged, u)
    o.onUsage(u)
  })
  sessionsRef = sessions
  usageRef = usage
  const agentsState = (): AgentsState => ({ agents: [...tracker.list(), ...helperList.list(), ...[...codexAgents.values()].flat()], leash: tracker.hasLeash() })
  agentsStateRef = agentsState
  // The wolfpack's tails: the subagents' files once seen, and the helpers' by session id.
  let subagentTails: { id: string; path: string | null }[] = []
  const syncTails = (): void => transcripts.syncAgents([...subagentTails, ...helperList.tails()])
  const tracker = new AgentTracker(
    { open: (id) => !!sessions.find(id)?.open, paste: (id, text) => sessions.paste(id, text) },
    projects,
    (list) => {
      subagentTails = list
      syncTails()
    },
    () => {
      // A subagent paused or killed: its session's tool calls go to core (leash.sh), the rest stay quiet.
      leash.markAgents(tracker.leashed())
      send(CH.agentsState, agentsState())
    }
  )
  agents = tracker
  const helperList = new Helpers(
    {
      env,
      home: o.home,
      settingsPath: settings.path,
      pluginDirs: o.pluginDirs,
      register: (t, who, session) => o.door.register(t, who, session),
      revoke: (t) => o.door.revoke(t),
      find: (id) => sessions.find(id)
    },
    () => {
      syncTails()
      send(CH.agentsState, agentsState())
    }
  )
  helpers = helperList
  // The leash's PreToolUse hook is in the settings file and reaches tracker.preTool: subagents can be
  // paused. After the helpers exist: setLeash reports the whole pack, helpers included.
  tracker.setLeash(true)
  await sessions.init()
  // Pauses of sessions core still has stand (a session that outlived a restart stays paused); the rest go.
  leash.prune(new Set(sessions.getState().sessions.map((x) => x.id)))
  const commits = new CommitRecorder(new CommitStore(join(o.home, 'commits.json')), (all) => o.onCommits?.(all))
  commitsRef = commits

  const fleet = new Fleet(env, (entries) => {
    sessions.onFleet(entries)
    // A permission prompt answered in the terminal: the poll leaves "waiting for permission prompt".
    const byId = new Map(entries.map((e) => [e.sessionId, e]))
    for (const v of sessions.getState().sessions) if (v.leash.asks.length) leash.onFleet(v.id, byId.get(v.cliSessionId))
    helperList.onFleet(entries)
  })
  if (o.poll) fleet.start()

  // ---- core's window only
  const fromWin = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => e.sender === o.win()?.webContents
  const handle = (ch: string, fn: (...a: any[]) => unknown): void =>
    ipcMain.handle(ch, (e, ...a) => {
      if (!fromWin(e)) throw new Error('core only')
      return fn(...a)
    })
  const on = (ch: string, fn: (...a: any[]) => void): void => {
    ipcMain.on(ch, (e, ...a) => {
      if (fromWin(e)) fn(...a)
    })
  }

  handle(CH.sessionsGet, () => sessions.getState())
  handle(CH.sessionNew, (opts: NewSessionOpts) => sessions.newSession(opts ?? { cwd: '' }))
  // Asked each time the launcher opens, so installing Codex while the app runs is seen.
  handle(CH.sessionClis, () => ({ claude: !!findInPath(env.PATH, 'claude'), codex: !!findInPath(env.PATH, 'codex') }))
  handle(CH.sessionResume, (id: string) => sessions.resume(String(id)))
  handle(CH.sessionPark, (id: string) => sessions.park(String(id)))
  handle(CH.sessionKill, async (id: string) => {
    await sessions.kill(String(id))
    leash.forget(String(id))
  })
  // The leash and permission prompts, from the session's tile or the center head. Core's window only:
  // a tile page can never pause, release or approve anything.
  handle(CH.sessionLeash, (id: string, action: string) => {
    const s = sessions.find(String(id))
    if (!s) return
    // A Codex session has no pause (its CLI cannot hold a call from outside): Stop interrupts its turn.
    if (s.cli === 'codex') return action === 'stop' ? codexLinks.get(s.id)?.interrupt().catch(() => false) : undefined
    if (action === 'pause') leash.pause(s.id)
    else if (action === 'resume') leash.resume(s.id)
    else if (action === 'refuse') leash.refuseHeld(s.id)
  })
  handle(CH.sessionPermission, (id: string, askId: string, allow: boolean) => {
    const s = sessions.find(String(id))
    if (!s || typeof askId !== 'string') return false
    const done = leash.answer(s.id, askId, allow === true)
    if (done) sessions.working(s.id)
    return done
  })
  handle(CH.sessionFocus, (id: string | null) => sessions.focus(id === null ? null : String(id)))
  handle(CH.usageGet, () => usage.get())
  handle(CH.transcriptGet, (id: string) => transcripts.get(String(id)))
  handle(CH.agentsGet, () => agentsState())
  const helperPause = (): never => {
    throw new Error('a helper is a background session of its own: stop it, or open it with claude attach')
  }
  const codexPause = (): never => {
    throw new Error('a Codex subagent cannot be paused: stop it, or answer it in the terminal')
  }
  handle(CH.agentPause, (id: string) => (helperList.has(String(id)) ? helperPause() : codexAgentLink(String(id)) ? codexPause() : tracker.pause(String(id))))
  handle(CH.agentResume, (id: string) => (helperList.has(String(id)) ? helperPause() : codexAgentLink(String(id)) ? codexPause() : tracker.resume(String(id))))
  // A helper is stopped with the CLI's own `claude stop` (kill, or clearing a finished one); a Codex
  // subagent's turn is interrupted (Codex tells its parent); a Claude subagent as tracker.kill says.
  handle(CH.agentKill, async (id: string) => {
    const cx = codexAgentLink(String(id))
    if (cx) {
      const killed = await cx.pack.kill(String(id))
      // The parent is told in one typed line, as a Claude Code session is (main/agents.ts kill).
      if (killed?.running && sessions.find(cx.sessionId)?.open) sessions.paste(cx.sessionId, codexKillLine(killed))
      return
    }
    return helperList.has(String(id)) ? helperList.stop(String(id)) : tracker.kill(String(id))
  })
  handle(CH.agentDismiss, (id: string) => {
    const cx = codexAgentLink(String(id))
    if (cx) return void cx.pack.dismiss(String(id))
    return helperList.has(String(id)) ? helperList.stop(String(id)) : tracker.dismiss(String(id))
  })
  handle(CH.openExternal, (url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  handle(CH.pickFolder, async (start?: string) => {
    const w = o.win()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof start === 'string' && existsSync(start) ? start : undefined })
    return r.canceled ? null : r.filePaths[0]
  })
  // The preview pane (track E): files read and written for the window, and a session's `doc open`.
  const preview = startPreview({ win: o.win, handle })
  // The file viewer: pictures, PDFs, web pages, films and sounds, served on view:// for the lightbox.
  startViewer({ handle })
  // A picture dropped on a session (from a browser or another app, with no file of its own), kept as a file the session can read.
  handle(CH.dropKeep, (file: unknown) => keepImage(o.home, file))
  on(CH.ptyInput, (id: string, data: string) => typeof data === 'string' && sessions.input(String(id), data))
  on(CH.ptyResize, (id: string, cols: number, rows: number) => sessions.resize(String(id), Number(cols), Number(rows)))
  on(CH.ptyTitle, (id: string, title: string) => sessions.setTitle(String(id), String(title)))
  on(CH.ptyBell, (id: string) => sessions.bell(String(id)))

  return {
    sessions,
    usage,
    tmux,
    settings,
    transcripts,
    agents: tracker,
    helpers: helperList,
    agentsState,
    commits,
    hook(name, token, payload) {
      const rec = sessions.byToken(token)
      if (!rec) {
        // A helper session's hooks come with its own token (main/helpers.ts); anything else is from outside any session.
        const event = HOOK_ROUTES[name]
        if (event && helperList.byToken(token)) helperList.onHook(token, event, (payload ?? {}) as HookPayload)
        return
      }
      if (name === 'status') return usage.onStatus(rec.id, payload)
      const p = (payload ?? {}) as HookPayload
      // A Bash call ended (PostToolUse): if it made commits, they are recorded as this session's.
      if (name === 'tool') {
        if (isSession(rec, p.session_id)) void commits.onTool({ id: rec.id, name: rec.name }, payload).catch((err) => console.warn('[workshop] commits:', err))
        return
      }
      // A tool call finished while a permission prompt was open: the terminal answered the one that asked about it.
      if (name === 'ran') {
        if (isSession(rec, p.session_id)) leash.settleCall(rec.id, payload as { tool_name?: unknown; tool_input?: unknown })
        return
      }
      const event = HOOK_ROUTES[name]
      // A session reports for itself only: the payload must name the session its token belongs to.
      if (!event || !isSession(rec, p.session_id)) return
      // The turn ended, or a new prompt was typed: no permission prompt is open any more.
      if (event === 'Stop' || event === 'UserPromptSubmit') leash.settle(rec.id)
      sessions.onHook(event, p)
      // A subagent's hooks carry its PARENT's session id (and its own agent_id): they are the parent's.
      tracker.onHook(rec, event, p)
    },
    leash,
    async ask(name, token, payload, gone) {
      const rec = sessions.byToken(token)
      const p = (payload ?? {}) as HookPayload
      // Only a session, and only about itself: anything else is answered with nothing, at once.
      if (!rec || !isSession(rec, p.session_id)) return null
      if (name === 'pretool') {
        // A subagent's call (it carries agent_id): its own pause or kill first, then its session's.
        if (p.agent_id) {
          const d = await tracker.preTool(rec, p, gone)
          if (d) return JSON.stringify(d)
        }
        return leash.hold(rec.id, p, gone)
      }
      if (name === 'permission') return leash.ask(rec.id, p, gone)
      return null
    },
    async call(name, token, payload) {
      const rec = sessions.byToken(token)
      if (!rec) throw new Error(helperList.byToken(token) ? 'a helper cannot do that; its session can' : 'only a session inside workshop can do that')
      if (name === 'helper') return helperList.call(rec, payload)
      // A Codex session's MCP server (bin/workshop-mcp.mjs) lists the door as tools.
      if (name === 'tools') return doorTools((await o.doorTiles?.()) ?? [])
      return preview.call(name, payload, { id: rec.id, cwd: rec.cwd })
    },
    stop() {
      fleet.stop()
      tracker.stop()
      for (const link of codexLinks.values()) link.stop()
      codexLinks.clear()
      transcripts.stop()
      preview.stop()
      sessions.detachAll()
    }
  }
}
