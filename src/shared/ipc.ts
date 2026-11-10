// The messages between main, core's window and the tiles. Channel names live here so the three
// sides cannot drift apart.

import type { Manifest } from './manifest'

export type TileView = 'tile' | 'pane'

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
}

export const CH = {
  // tile page → main (invoke unless noted)
  hello: 'ws:tile:hello', // sendSync
  head: 'ws:tile:head',
  pane: 'ws:tile:pane',
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
  // main → core window
  tilesChanged: 'ws:core:tiles-changed',
  tileHead: 'ws:core:tile-head',
  tilePane: 'ws:core:tile-pane',
  tileNotify: 'ws:core:tile-notify',
  themeChanged: 'ws:core:theme'
} as const
