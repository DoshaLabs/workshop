// The bridge's side of `workshop.music` in main: who is watching, what each tile is sent, and the
// three calls. The host (main/music.ts) does the reading and the driving; this file only decides
// which page may ask and which page hears. Every call is checked like the rest of the bridge: a
// tile page core attached, its top frame, its own origin, and "music" in its manifest.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { CH } from '@shared/ipc'
import type { Manifest } from '@shared/manifest'
import { MusicHost, forTile, type ArtFetcher, type Runner } from './music'
import { setMusicArt } from './tiles'

interface Asker {
  tile: { manifest: Manifest }
  wc: WebContents
}

export interface MusicBridge {
  host: MusicHost
  /** A page reloaded or went away: it watches nothing now. */
  forget(wcId: number): void
}

export function startMusic(o: { guest: (e: IpcMainEvent | IpcMainInvokeEvent) => Asker | null; runner: Runner; fetchArt: ArtFetcher }): MusicBridge {
  const watching = new Map<number, Asker>()
  const hooked = new WeakSet<WebContents>()
  const host = new MusicHost({
    runner: o.runner,
    fetchArt: o.fetchArt,
    onChange: (s) => {
      for (const a of watching.values()) if (!a.wc.isDestroyed()) a.wc.send(CH.musicChanged, forTile(s, a.tile.manifest.id))
    }
  })
  setMusicArt((key) => host.artwork(key))

  const need = (e: IpcMainEvent | IpcMainInvokeEvent): Asker => {
    const g = o.guest(e)
    if (!g) throw new Error('not a tile')
    if (!g.tile.manifest.permissions.music) throw new Error('this tile did not ask for "music" in tile.json')
    return g
  }
  const forget = (id: number): void => {
    watching.delete(id)
    host.unwatch(id)
  }

  ipcMain.handle(CH.musicGet, async (e) => forTile(await host.get(), need(e).tile.manifest.id))
  ipcMain.handle(CH.musicControl, async (e, op: unknown, arg: unknown) => {
    need(e)
    await host.control(op, arg)
  })
  ipcMain.on(CH.musicWatch, (e, on: unknown) => {
    let g: Asker
    try {
      g = need(e)
    } catch {
      return
    }
    const id = g.wc.id
    if (on !== true) return forget(id)
    if (!hooked.has(g.wc)) {
      hooked.add(g.wc)
      g.wc.once('destroyed', () => forget(id))
    }
    watching.set(id, g)
    host.watch(id)
    // A page that starts watching hears the state at once, not at the next change.
    const now = host.last()
    if (now) g.wc.send(CH.musicChanged, forTile(now, g.tile.manifest.id))
  })

  return { host, forget }
}
