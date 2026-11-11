// Core's own window's bridge (not a tile's: that is tile.ts).

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LaunchPrefill, NewSessionOpts, SessionsState } from '../shared/sessions'
import type { Usage } from '../shared/usage'
import type { Transcript } from '../shared/transcript'
import type { AgentsState } from '../shared/agents'
import type { Shortcut } from '../shared/shortcuts'
import type { ColumnState } from '../shared/column'
import type { ActiveMascot } from '../shared/mascot'
import { MENU, type IndexState, type InstallRecord, type InstallRequest, type PendingInstall } from '../shared/tile-menu'
import type { PreviewDoc, PreviewRef, PreviewWrite } from '../shared/preview'
import type { RecState } from '../shared/recorder'
import type { AppUpdate } from '../shared/update'
import { CH, type ThemeState, type TileHead, type TileInfo, type TileProblem, type TileView } from '../shared/ipc'

const on = <A extends unknown[]>(ch: string, fn: (...a: A) => void): (() => void) => {
  const h = (_e: unknown, ...a: unknown[]): void => fn(...(a as A))
  ipcRenderer.on(ch, h)
  return () => void ipcRenderer.removeListener(ch, h)
}

const core = {
  listTiles: (): Promise<{ tiles: TileInfo[]; problems: TileProblem[]; theme: ThemeState }> => ipcRenderer.invoke(CH.listTiles),
  setSettings: (patch: { theme?: string; appearance?: 'system' | 'light' | 'dark' }): Promise<ThemeState> => ipcRenderer.invoke(CH.setSettings, patch),
  setView: (id: string, view: TileView): Promise<void> => ipcRenderer.invoke(CH.setView, id, view),
  /** A new tile from the starter, shown at once, and a Claude session in its folder told what to build. */
  createTile: (name: string, idea: string): Promise<{ id: string; folder: string }> => ipcRenderer.invoke(CH.tileCreate, name, idea),
  /** Stop loading a tile under development. Its folder is left alone. */
  forgetTile: (id: string): Promise<void> => ipcRenderer.invoke(CH.tileForget, id),
  onTileHead: (fn: (id: string, head: TileHead) => void) => on(CH.tileHead, fn),
  onTilePane: (fn: (id: string, open: boolean) => void) => on(CH.tilePane, fn),
  onTileOverlay: (fn: (id: string, open: boolean) => void) => on(CH.tileOverlay, fn),
  onTileNotify: (fn: (id: string, text: string) => void) => on(CH.tileNotify, fn),
  onTileWheel: (fn: (id: string, dy: number) => void) => on(CH.tileWheel, fn),
  onTheme: (fn: (theme: ThemeState) => void) => on(CH.themeChanged, fn),
  onTilesChanged: (fn: () => void) => on(CH.tilesChanged, fn),
  // sessions
  sessions: (): Promise<SessionsState> => ipcRenderer.invoke(CH.sessionsGet),
  onSessions: (fn: (s: SessionsState) => void) => on(CH.sessionsState, fn),
  /** A tile asked for the launcher, filled in (workshop.sessions.launch). */
  onLaunch: (fn: (p: LaunchPrefill) => void) => on(CH.sessionsLaunch, fn),
  newSession: (opts: NewSessionOpts): Promise<unknown> => ipcRenderer.invoke(CH.sessionNew, opts),
  /** Which agent CLIs are installed (on the sessions' PATH). */
  clis: (): Promise<{ claude: boolean; codex: boolean }> => ipcRenderer.invoke(CH.sessionClis),
  resume: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionResume, id),
  park: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionPark, id),
  kill: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionKill, id),
  focusSession: (id: string | null): Promise<void> => ipcRenderer.invoke(CH.sessionFocus, id),
  /** The leash: pause a session (its next tool call waits), resume it, or refuse the call it holds. */
  leash: (id: string, action: 'pause' | 'resume' | 'refuse'): Promise<void> => ipcRenderer.invoke(CH.sessionLeash, id, action),
  /** Answer a permission prompt from the session's tile. False if the terminal answered it first. */
  answerPermission: (id: string, askId: string, allow: boolean): Promise<boolean> => ipcRenderer.invoke(CH.sessionPermission, id, askId, allow),
  pickFolder: (start?: string): Promise<string | null> => ipcRenderer.invoke(CH.pickFolder, start),
  ptyInput: (id: string, data: string): void => ipcRenderer.send(CH.ptyInput, id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send(CH.ptyResize, id, cols, rows),
  setTitle: (id: string, title: string): void => ipcRenderer.send(CH.ptyTitle, id, title),
  bell: (id: string): void => ipcRenderer.send(CH.ptyBell, id),
  onPtyData: (fn: (id: string, data: string) => void) => on(CH.ptyData, fn),
  onPtyExit: (fn: (id: string) => void) => on(CH.ptyExit, fn),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.openExternal, url),
  usage: (): Promise<Usage> => ipcRenderer.invoke(CH.usageGet),
  onUsage: (fn: (u: Usage) => void) => on(CH.usageChanged, fn),
  // session tiles
  transcript: (id: string): Promise<Transcript | null> => ipcRenderer.invoke(CH.transcriptGet, id),
  onTranscript: (fn: (t: Transcript) => void) => on(CH.transcriptChanged, fn),
  /** The wolfpack: every open session's subagents and helper sessions. */
  agents: {
    get: (): Promise<AgentsState> => ipcRenderer.invoke(CH.agentsGet),
    onChange: (fn: (s: AgentsState) => void) => on(CH.agentsState, fn),
    pause: (id: string): Promise<void> => ipcRenderer.invoke(CH.agentPause, id),
    resume: (id: string): Promise<void> => ipcRenderer.invoke(CH.agentResume, id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(CH.agentKill, id),
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke(CH.agentDismiss, id)
  },
  /** ⌘1–9, ⌘[ ⌘], ⌘N, caught by main wherever the focus is. */
  onShortcut: (fn: (s: Shortcut) => void) => on(CH.shortcut, fn),
  /** The tile column's state, kept in core's settings; null until it has first been saved. */
  column: (): Promise<ColumnState | null> => ipcRenderer.invoke(CH.columnGet),
  setColumn: (c: ColumnState): Promise<void> => ipcRenderer.invoke(CH.columnSet, c),
  // the mascot
  mascot: (): Promise<ActiveMascot | null> => ipcRenderer.invoke(CH.mascotGet),
  /** Saves a pack made in the setup screen (its PNG as bytes) and makes it the active one. */
  saveMascot: (pack: unknown, png: Uint8Array, workerPng?: Uint8Array): Promise<ActiveMascot | null> => ipcRenderer.invoke(CH.mascotSave, pack, png, workerPng),
  /** Deletes the active pack: back to the plain status dot. */
  removeMascot: (): Promise<void> => ipcRenderer.invoke(CH.mascotRemove),
  onMascot: (fn: (m: ActiveMascot | null) => void) => on(CH.mascotChanged, fn),
  /** A session's mascot should leap once (a tile's `notify({ attention: true })`). */
  onAttention: (fn: (sessionId: string) => void) => on(CH.attention, fn),
  /** The + menu: installed tiles, the index, install / update / remove, load a folder (main/tile-menu.ts). */
  menu: {
    state: (): Promise<{ installed: InstallRecord[]; index: IndexState }> => ipcRenderer.invoke(MENU.state),
    setIndex: (source: string): Promise<IndexState> => ipcRenderer.invoke(MENU.setIndex, source),
    prepare: (req: InstallRequest): Promise<PendingInstall> => ipcRenderer.invoke(MENU.prepare, req),
    confirm: (token: string): Promise<{ id: string }> => ipcRenderer.invoke(MENU.confirm, token),
    cancel: (token: string): Promise<void> => ipcRenderer.invoke(MENU.cancel, token),
    remove: (id: string, opts: { storage: boolean }): Promise<void> => ipcRenderer.invoke(MENU.remove, id, opts),
    loadFolder: (): Promise<{ folder: string; message: string } | null> => ipcRenderer.invoke(MENU.loadFolder)
  },
  // track E: the preview pane, and images for a session's prompt
  readDoc: (path: string, cwd?: string): Promise<PreviewDoc> => ipcRenderer.invoke(CH.previewRead, path, cwd),
  writeDoc: (path: string, text: string, mtime: number): Promise<PreviewWrite> => ipcRenderer.invoke(CH.previewWrite, path, text, mtime),
  tickTask: (path: string, line: number, checked: boolean, mtime: number): Promise<PreviewWrite> => ipcRenderer.invoke(CH.previewTask, path, line, checked, mtime),
  /** A file in the Mac app that owns its type (a ⌘-click on a path; HTML lands in the browser). False if refused. */
  openFileApp: (path: string, cwd?: string): Promise<boolean> => ipcRenderer.invoke(CH.previewOpenApp, path, cwd),
  /** Watch the file the pane shows (null: none); a change comes back through onDocChanged. */
  watchDoc: (path: string | null): Promise<void> => ipcRenderer.invoke(CH.previewWatch, path),
  onDocChanged: (fn: (path: string, mtime: number) => void) => on(CH.previewChanged, fn),
  /** A session ran `node "$WORKSHOP_DOC" open <path>`. */
  onOpenDoc: (fn: (ref: PreviewRef, sessionId: string) => void) => on(CH.previewOpen, fn),
  /** A pasted or dropped file, kept where a session can read it; its path. A Finder file keeps its own path. */
  /** The screen recorder (main/recorder.ts): the top bar's button. */
  recorder: {
    /** Open the frame; while it is up, stop the take or close it (⌘⇧O does the same). */
    toggle: (): Promise<void> => ipcRenderer.invoke(CH.recToggle),
    state: (): Promise<RecState> => ipcRenderer.invoke(CH.recStateGet),
    onState: (fn: (s: RecState) => void) => on(CH.recState, fn)
  },
  /** Install update (main/updates.ts): whether the repo the app was built from has changed, and building and swapping in the new app. */
  update: {
    state: (): Promise<AppUpdate> => ipcRenderer.invoke(CH.updateGet),
    install: (): Promise<void> => ipcRenderer.invoke(CH.updateInstall),
    onState: (fn: (u: AppUpdate) => void) => on(CH.updateState, fn)
  },
  keepDrop: async (file: File): Promise<string> => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      // a pasted picture has no file behind it
    }
    const bytes = path ? undefined : new Uint8Array(await file.arrayBuffer())
    return ipcRenderer.invoke(CH.dropKeep, { name: file.name, path, bytes, type: file.type })
  }
}

export type CoreApi = typeof core

contextBridge.exposeInMainWorld('core', core)
