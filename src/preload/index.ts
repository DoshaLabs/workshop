// Core's own window's bridge (not a tile's: that is tile.ts).

import { contextBridge, ipcRenderer } from 'electron'
import { CH, type TileHead, type TileInfo, type TileProblem, type TileView } from '../shared/ipc'

const on = <A extends unknown[]>(ch: string, fn: (...a: A) => void): (() => void) => {
  const h = (_e: unknown, ...a: unknown[]): void => fn(...(a as A))
  ipcRenderer.on(ch, h)
  return () => void ipcRenderer.removeListener(ch, h)
}

const core = {
  listTiles: (): Promise<{ tiles: TileInfo[]; problems: TileProblem[]; vars: Record<string, string> }> => ipcRenderer.invoke(CH.listTiles),
  setView: (id: string, view: TileView): Promise<void> => ipcRenderer.invoke(CH.setView, id, view),
  onTileHead: (fn: (id: string, head: TileHead) => void) => on(CH.tileHead, fn),
  onTilePane: (fn: (id: string, open: boolean) => void) => on(CH.tilePane, fn),
  onTileNotify: (fn: (id: string, text: string) => void) => on(CH.tileNotify, fn),
  onTheme: (fn: (vars: Record<string, string>) => void) => on(CH.themeChanged, fn)
}

export type CoreApi = typeof core

contextBridge.exposeInMainWorld('core', core)
