// The messages between main, core's window and the tiles. Channel names live here so the three
// sides cannot drift apart.

import type { Manifest } from './manifest'
import type { TermPalette } from './themes'

/** Where a tile's page is showing: its cell in the column, the center pane, or over the whole window. */
export type TileView = 'tile' | 'pane' | 'overlay'

/** The theme as core's window paints it. */
export interface ThemeState {
  theme: string
  appearance: 'system' | 'light' | 'dark'
  dark: boolean
  /** A wall of its own behind see-through panes (Deep Space's sky, Glass). */
  wall: boolean
  vars: Record<string, string>
  /** The terminal palette (xterm's ITheme fields). */
  term: TermPalette
}

/** What core's window knows about a registered tile. */
export interface TileInfo {
  manifest: Manifest
  /** The page to load in the tile's webview. */
  src: string
  /** The webview's partition: one per tile, so its storage and cookies are its own. */
  partition: string
  /** The icon as a data: URL (shown in an <img>, so an SVG's scripts never run), or ''. */
  icon: string
  /** Where it was loaded from: shipped with core, installed, or a folder under development. */
  source: 'core' | 'installed' | 'dev'
  /** Changes when a dev tile is loaded again: the window then makes a fresh page for it. */
  rev: number
}

/** A tile that was found but refused, with why. Shown in the column so an author sees it. */
export interface TileProblem {
  folder: string
  errors: string[]
}

export interface TileHead {
  title?: string
  badge?: string
}

/** What a tile's preload gets back from its one synchronous hello. */
export interface TileHello {
  id: string
  /** This page's instance: the id for a tile's first, `<id>.<n>` after (manifest `multiple`). */
  instance: string
  view: TileView
  vars: Record<string, string>
  bridge: string
  permissions: Manifest['permissions']
}

export interface DoorCall {
  callId: string
  op: string
  args: string[]
  /** Who called, as core knows it. Never read from the request body. */
  caller: string
  /**
   * The calling session's id (the one `workshop.sessions` lists), or null from outside a session.
   * Names are not unique ("new session" twice); a tile that must know WHICH session called, to
   * find its project folder, matches this id.
   */
  session: string | null
}

export const CH = {
  // tile page → main (invoke unless noted)
  hello: 'ws:tile:hello', // sendSync
  head: 'ws:tile:head',
  pane: 'ws:tile:pane',
  overlay: 'ws:tile:overlay',
  external: 'ws:tile:external',
  storageGet: 'ws:tile:storage-get',
  storageSet: 'ws:tile:storage-set',
  notify: 'ws:tile:notify',
  filesPick: 'ws:tile:files-pick',
  filesList: 'ws:tile:files-list',
  filesEntries: 'ws:tile:files-entries',
  filesForget: 'ws:tile:files-forget',
  doorReady: 'ws:tile:door-ready', // send: the ops the page now answers
  doorReply: 'ws:tile:door-reply', // send
  // main → tile page
  view: 'ws:tile:view',
  theme: 'ws:tile:theme',
  storageChanged: 'ws:tile:storage-changed',
  doorCall: 'ws:tile:door-call',
  // core window → main
  listTiles: 'ws:core:list-tiles',
  setView: 'ws:core:set-view',
  tileCreate: 'ws:core:tile-create',
  tileForget: 'ws:core:tile-forget',
  // main → core window
  tilesChanged: 'ws:core:tiles-changed',
  tileHead: 'ws:core:tile-head',
  tilePane: 'ws:core:tile-pane',
  tileOverlay: 'ws:core:tile-overlay',
  tileNotify: 'ws:core:tile-notify',
  themeChanged: 'ws:core:theme',
  setSettings: 'ws:core:set-settings',
  // sessions: core window ⇄ main
  sessionsGet: 'ws:core:sessions-get',
  sessionsState: 'ws:core:sessions-state', // main → window
  sessionNew: 'ws:core:session-new',
  sessionResume: 'ws:core:session-resume',
  sessionPark: 'ws:core:session-park',
  sessionKill: 'ws:core:session-kill',
  sessionFocus: 'ws:core:session-focus',
  pickFolder: 'ws:core:pick-folder',
  ptyInput: 'ws:core:pty-input', // send
  ptyResize: 'ws:core:pty-resize', // send
  ptyTitle: 'ws:core:pty-title', // send
  ptyBell: 'ws:core:pty-bell', // send
  ptyData: 'ws:core:pty-data', // main → window
  ptyExit: 'ws:core:pty-exit', // main → window
  openExternal: 'ws:core:open-external',
  usageGet: 'ws:core:usage-get',
  usageChanged: 'ws:core:usage', // main → window
  // sessions and usage: tile page ⇄ main
  tileSessionsList: 'ws:tile:sessions-list',
  tileSessionsChanged: 'ws:tile:sessions-changed', // main → tile
  tileSessionsPaste: 'ws:tile:sessions-paste',
  tileUsageGet: 'ws:tile:usage-get',
  tileUsageChanged: 'ws:tile:usage-changed', // main → tile
  // session tiles: the conversation, tailed by main (main/transcript.ts)
  transcriptGet: 'ws:core:transcript-get',
  transcriptChanged: 'ws:core:transcript', // main → window
  // ⌘1–9, ⌘[ ⌘], ⌘N, caught by main wherever the focus is (shared/shortcuts.ts)
  shortcut: 'ws:core:shortcut', // main → window
  // the tile column's state (off, extra instances, heights), kept in core's settings
  columnGet: 'ws:core:column-get',
  columnSet: 'ws:core:column-set',
  // the mascot (§8): core window ⇄ main
  mascotGet: 'ws:core:mascot-get',
  mascotSave: 'ws:core:mascot-save',
  mascotRemove: 'ws:core:mascot-remove',
  mascotChanged: 'ws:core:mascot', // main → window: the active pack, or null
  mascotBark: 'ws:core:mascot-bark' // main → window: a session's mascot leaps once
} as const
