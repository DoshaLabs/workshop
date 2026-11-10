// The + menu's side in main: the index the Marketplace tab reads, install / update / remove
// (install.ts) wired into the live registry, and "load a folder" (the macOS chooser, then the same
// path as `workshop tile dev`). Only core's window may call any of it, never a tile.

import { app, dialog, ipcMain, session, type BrowserWindow } from 'electron'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CH } from '@shared/ipc'
import { MENU, type IndexState, type InstallRequest } from '@shared/tile-menu'
import { INDEX_MAX_BYTES, checkIndex } from '@shared/tile-index'
import { Installer } from './install'
import { MAX_INSTANCES, armSession, partitionOf, readTile, sessionsFor, type Registry, type Tile } from './tiles'
import type { SettingsStore } from './settings'

export interface MenuDeps {
  win: () => BrowserWindow | null
  registry: () => Registry
  settings: () => SettingsStore
  userData: string
  addDevTile: (folder: string) => Promise<string>
  /** Forgets what main holds in memory for a tile's data (its store and file grants), before the folder goes. */
  dropData: (id: string) => void
  /** A smoke run: a local index and local repos are allowed without WORKSHOP_INDEX. */
  smoke: boolean
}

/** The index's address: WORKSHOP_INDEX (tests, a local index) wins over settings. */
function indexSource(deps: MenuDeps): { source: string | null; fromEnv: boolean } {
  if (process.env.WORKSHOP_INDEX) return { source: process.env.WORKSHOP_INDEX, fromEnv: true }
  return { source: deps.settings().get().index ?? null, fromEnv: false }
}

const isLocal = (src: string | null): boolean => !!src && (src.startsWith('/') || src.startsWith('file:'))

/** Reads and checks the index. Never throws: a problem is part of the answer, for the tab to show. */
export async function readIndex(source: string | null, fromEnv = false): Promise<IndexState> {
  const state: IndexState = { source, fromEnv, entries: [], errors: [], problem: null }
  if (!source) return state
  let text: string
  try {
    if (source.startsWith('https://')) {
      const res = await fetch(source, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      if (Number(res.headers.get('content-length') ?? 0) > INDEX_MAX_BYTES) throw new Error('larger than an index may be')
      text = await res.text()
    } else if (isLocal(source)) {
      text = await readFile(source.startsWith('file:') ? fileURLToPath(source) : source, 'utf8')
    } else throw new Error('an index is an https URL or a file on this Mac')
    if (text.length > INDEX_MAX_BYTES) throw new Error('larger than an index may be')
    const checked = checkIndex(JSON.parse(text), { local: isLocal(source) })
    state.entries = checked.entries
    state.errors = checked.errors
  } catch (err) {
    state.problem = `could not read the index: ${(err as Error).message}`
  }
  return state
}

/** The ids of the tiles that ship with workshop, read from tiles/ itself: no installed tile may take one, even one that failed to load. */
async function builtinIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  const dir = join(app.getAppPath(), 'tiles')
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    try {
      const id = (JSON.parse(await readFile(join(dir, e.name, 'tile.json'), 'utf8')) as { id?: unknown }).id
      if (typeof id === 'string') ids.add(id)
    } catch {
      // not a tile
    }
  }
  return ids
}

export async function startTileMenu(deps: MenuDeps): Promise<{ installer: Installer }> {
  const builtin = await builtinIds()
  const stagingDir = join(deps.userData, 'tile-staging')
  // Clones left waiting when core last quit: nobody will answer for them now.
  await rm(stagingDir, { recursive: true, force: true })
  const installer = new Installer({
    tilesDir: join(deps.userData, 'tiles'),
    stagingDir,
    takenBy: (id) => (builtin.has(id) ? 'core' : deps.registry().tiles.get(id)?.source === 'dev' ? 'dev' : null),
    local: () => deps.smoke || isLocal(indexSource(deps).source)
  })
  const changed = (): void => deps.win()?.webContents.send(CH.tilesChanged)
  const coreOnly = (e: Electron.IpcMainInvokeEvent): void => {
    if (e.sender !== deps.win()?.webContents) throw new Error('core only')
  }

  /** Puts an installed folder into the live registry (again, after an update: a new rev makes the window load a fresh page). */
  const register = async (folder: string): Promise<void> => {
    const reg = deps.registry()
    const t = await readTile(folder, 'installed')
    reg.problems = reg.problems.filter((p) => p.folder !== folder)
    if ('errors' in t) {
      reg.problems.push(t)
      throw new Error(`installed, but it would not load: ${t.errors.join('; ')}`)
    }
    const old = reg.tiles.get(t.manifest.id)
    const tile: Tile = { ...t, rev: (old?.rev ?? 0) + 1, sessions: old?.sessions.length === (t.manifest.multiple ? MAX_INSTANCES : 1) ? old.sessions : sessionsFor(t) }
    reg.tiles.set(t.manifest.id, tile)
    await armSession(tile)
  }

  ipcMain.handle(MENU.state, async (e) => {
    coreOnly(e)
    const src = indexSource(deps)
    return { installed: await installer.list(), index: await readIndex(src.source, src.fromEnv) }
  })
  ipcMain.handle(MENU.setIndex, async (e, source: unknown) => {
    coreOnly(e)
    await deps.settings().patch({ index: typeof source === 'string' ? source.trim() : '' })
    const src = indexSource(deps)
    return readIndex(src.source, src.fromEnv)
  })
  ipcMain.handle(MENU.prepare, (e, req: InstallRequest) => {
    coreOnly(e)
    return installer.prepare(req)
  })
  ipcMain.handle(MENU.confirm, async (e, token: string) => {
    coreOnly(e)
    const done = await installer.confirm(token)
    try {
      await register(done.folder)
    } finally {
      changed()
    }
    return { id: done.id }
  })
  ipcMain.handle(MENU.cancel, (e, token: string) => {
    coreOnly(e)
    return installer.cancel(token)
  })
  ipcMain.handle(MENU.remove, async (e, id: string, opts: { storage?: boolean }) => {
    coreOnly(e)
    id = String(id)
    const reg = deps.registry()
    const tile = reg.tiles.get(id)
    await installer.remove(id)
    if (tile?.source === 'installed') reg.tiles.delete(id)
    if (opts?.storage === true) {
      deps.dropData(id)
      await rm(join(deps.userData, 'tile-data', id), { recursive: true, force: true })
      // Its pages' own web storage and cookies, every instance's.
      const n = tile?.manifest.multiple ? MAX_INSTANCES : 1
      await Promise.all(Array.from({ length: n }, (_, i) => session.fromPartition(partitionOf(`persist:tile-${id}`, i + 1)).clearStorageData().catch(() => undefined)))
    }
    changed()
  })
  ipcMain.handle(MENU.loadFolder, async (e) => {
    coreOnly(e)
    const w = deps.win()
    if (!w) return null
    const r = await dialog.showOpenDialog(w, { title: 'Load a tile folder', buttonLabel: 'Load', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return { folder: r.filePaths[0], message: await deps.addDevTile(r.filePaths[0]) }
  })

  return { installer }
}
