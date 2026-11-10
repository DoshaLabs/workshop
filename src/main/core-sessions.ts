// Sessions in core: the tmux server, the session manager, the fleet poll, the hooks (routed by
// each session's token through the door's server), usage, and the IPC core's window drives them
// with. main/index.ts starts it and hands tiles what their permissions allow.

import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import type { NewSessionOpts, SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import type { Door } from './door'
import { shellEnv } from './env'
import { Fleet } from './fleet'
import { HOOK_ROUTES, SessionSettings } from './hooks'
import { SessionManager } from './sessions'
import { Tmux } from './tmux'
import { UsageTracker } from './usage'

export interface CoreSessions {
  sessions: SessionManager
  usage: UsageTracker
  tmux: Tmux
  settings: SessionSettings
  /** Route a /hook/<name> call (the door's server hands them here). */
  hook(name: string, token: string, payload: unknown): void
  stop(): void
}

export interface Options {
  win: () => BrowserWindow | null
  door: Door
  home: string
  profile: string
  appPath: string
  /** Every tile's plugin/ folder. */
  pluginDirs: () => string[]
  dark: boolean
  /** No fleet poll (the smoke test has no real sessions to poll for). */
  poll: boolean
  /** A folder put first on the sessions' PATH (the smoke test's stand-in `claude`). */
  pathFirst?: string
  /** State changed: the window gets it here; core also tells tiles. */
  onState: (s: SessionsState) => void
  onUsage: (u: Usage) => void
}

export async function startSessions(o: Options): Promise<CoreSessions> {
  const env = { ...shellEnv() }
  if (o.pathFirst) env.PATH = `${o.pathFirst}:${env.PATH ?? ''}`
  const tmux = new Tmux(o.profile, join(o.appPath, 'tmux.conf'), env)
  const settings = new SessionSettings(o.home, join(o.appPath, 'bin', 'workshop-tile.mjs'))
  settings.setDark(o.dark)
  settings.setPort(o.door.port)

  const send = (ch: string, ...a: unknown[]): void => {
    const w = o.win()
    if (w && !w.isDestroyed()) w.webContents.send(ch, ...a)
  }

  const sessions = new SessionManager({
    tmux,
    env,
    home: o.home,
    profile: o.profile,
    settingsPath: settings.path,
    pluginDirs: o.pluginDirs,
    register: (t, who, session) => o.door.register(t, who, session),
    revoke: (t) => o.door.revoke(t),
    events: {
      state: (s) => {
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
  await sessions.init()

  const fleet = new Fleet(env, (entries) => sessions.onFleet(entries))
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
  handle(CH.sessionResume, (id: string) => sessions.resume(String(id)))
  handle(CH.sessionPark, (id: string) => sessions.park(String(id)))
  handle(CH.sessionKill, (id: string) => sessions.kill(String(id)))
  handle(CH.sessionFocus, (id: string | null) => sessions.focus(id === null ? null : String(id)))
  handle(CH.usageGet, () => usage.get())
  handle(CH.openExternal, (url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  handle(CH.pickFolder, async (start?: string) => {
    const w = o.win()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof start === 'string' && existsSync(start) ? start : undefined })
    return r.canceled ? null : r.filePaths[0]
  })
  on(CH.ptyInput, (id: string, data: string) => typeof data === 'string' && sessions.input(String(id), data))
  on(CH.ptyResize, (id: string, cols: number, rows: number) => sessions.resize(String(id), Number(cols), Number(rows)))
  on(CH.ptyTitle, (id: string, title: string) => sessions.setTitle(String(id), String(title)))
  on(CH.ptyBell, (id: string) => sessions.bell(String(id)))

  return {
    sessions,
    usage,
    tmux,
    settings,
    hook(name, token, payload) {
      const rec = sessions.byToken(token)
      if (!rec) return // a call from outside any session: hooks are only for sessions
      if (name === 'status') return usage.onStatus(rec.id, payload)
      const event = HOOK_ROUTES[name]
      const p = (payload ?? {}) as { session_id?: string }
      // A session reports for itself only: the payload must name the session its token belongs to.
      if (event && p.session_id === rec.claudeSessionId) sessions.onHook(event, p)
    },
    stop() {
      fleet.stop()
      sessions.detachAll()
    }
  }
}
