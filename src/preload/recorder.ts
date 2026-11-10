// The screen recorder's frame (main/recorder.ts): its own small bridge, window.rec. The page is
// core's, not a tile's, but it gets only what the frame needs.
//
// Sandboxed, so this must be one file that requires nothing but 'electron': the channel names are
// spelled out here rather than imported (they are REC in shared/recorder.ts, and smoke drives each).

import { contextBridge, ipcRenderer } from 'electron'
import type { RecHello, RecPrefs, RecSource } from '../shared/recorder'

const rec = {
  hello: (): Promise<RecHello> => ipcRenderer.invoke('ws:rec:hello'),
  setPrefs: (p: RecPrefs): Promise<void> => ipcRenderer.invoke('ws:rec:set-prefs', p),
  passThrough: (through: boolean): void => ipcRenderer.send('ws:rec:pass-through', through),
  move: (x: number, y: number): void => ipcRenderer.send('ws:rec:move', x, y),
  resize: (height: number): void => ipcRenderer.send('ws:rec:resize', height),
  close: (): void => ipcRenderer.send('ws:rec:close'),
  phase: (phase: string): void => ipcRenderer.send('ws:rec:phase', phase),
  source: (): Promise<RecSource> => ipcRenderer.invoke('ws:rec:source'),
  /** Route the Mac's output through BlackHole. Resolves an error, '' when routed. */
  audioOn: (): Promise<string> => ipcRenderer.invoke('ws:rec:audio-on'),
  audioOff: (): Promise<void> => ipcRenderer.invoke('ws:rec:audio-off'),
  begin: (ext: string): Promise<void> => ipcRenderer.invoke('ws:rec:begin', ext),
  chunk: (bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('ws:rec:chunk', bytes),
  /** The take is done: resolves the saved file's path. */
  end: (ext: string): Promise<string> => ipcRenderer.invoke('ws:rec:end', ext),
  reveal: (path: string): void => ipcRenderer.send('ws:rec:reveal', path),
  play: (path: string): void => ipcRenderer.send('ws:rec:play', path),
  /** ⌘⇧O or the top bar's button while the frame is up: stop a take, else close. */
  onCloseAsked: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('ws:rec:close-asked', h)
    return () => void ipcRenderer.removeListener('ws:rec:close-asked', h)
  },
  onTheme: (cb: (vars: Record<string, string>) => void): (() => void) => {
    const h = (_e: unknown, vars: Record<string, string>): void => cb(vars)
    ipcRenderer.on('ws:rec:theme', h)
    return () => void ipcRenderer.removeListener('ws:rec:theme', h)
  }
}

export type RecApi = typeof rec
contextBridge.exposeInMainWorld('rec', rec)
