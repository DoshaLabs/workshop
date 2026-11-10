// Core's own window's bridge (not a tile's: that is tile.ts).

import { contextBridge, ipcRenderer } from 'electron'
import type { NewSessionOpts, SessionsState } from '../shared/sessions'
import type { Usage } from '../shared/usage'
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
  onTheme: (fn: (theme: ThemeState) => void) => on(CH.themeChanged, fn),
  onTilesChanged: (fn: () => void) => on(CH.tilesChanged, fn),
  // sessions
  sessions: (): Promise<SessionsState> => ipcRenderer.invoke(CH.sessionsGet),
  onSessions: (fn: (s: SessionsState) => void) => on(CH.sessionsState, fn),
  newSession: (opts: NewSessionOpts): Promise<unknown> => ipcRenderer.invoke(CH.sessionNew, opts),
  resume: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionResume, id),
  park: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionPark, id),
  kill: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionKill, id),
  focusSession: (id: string | null): Promise<void> => ipcRenderer.invoke(CH.sessionFocus, id),
  pickFolder: (start?: string): Promise<string | null> => ipcRenderer.invoke(CH.pickFolder, start),
  ptyInput: (id: string, data: string): void => ipcRenderer.send(CH.ptyInput, id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send(CH.ptyResize, id, cols, rows),
  setTitle: (id: string, title: string): void => ipcRenderer.send(CH.ptyTitle, id, title),
  bell: (id: string): void => ipcRenderer.send(CH.ptyBell, id),
  onPtyData: (fn: (id: string, data: string) => void) => on(CH.ptyData, fn),
  onPtyExit: (fn: (id: string) => void) => on(CH.ptyExit, fn),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.openExternal, url),
  usage: (): Promise<Usage> => ipcRenderer.invoke(CH.usageGet),
  onUsage: (fn: (u: Usage) => void) => on(CH.usageChanged, fn)
}

export type CoreApi = typeof core

contextBridge.exposeInMainWorld('core', core)
