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
  /** The ops a built-in tile's backend answers (manifest `backend.ops`); absent without one. */
  backendOps?: string[]
  /** `workshop.oauth.redirectUri`, on a tile that asks for "oauth" (bridge 1.5). */
  oauthRedirect?: string
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
  backendCall: 'ws:tile:backend-call',
  backendStatus: 'ws:tile:backend-status',
  musicGet: 'ws:tile:music-get',
  oauthAuthorize: 'ws:tile:oauth-authorize',
  oauthCancel: 'ws:tile:oauth-cancel',
  musicWatch: 'ws:tile:music-watch', // send: true when the page starts watching, false when it stops
  musicControl: 'ws:tile:music-control',
  /** send: a wheel the page could not use (it has nothing left to scroll that way), for the column: dy in px. */
  wheel: 'ws:tile:wheel',
  // main → tile page
  view: 'ws:tile:view',
  theme: 'ws:tile:theme',
  storageChanged: 'ws:tile:storage-changed',
  doorCall: 'ws:tile:door-call',
  backendStatusChanged: 'ws:tile:backend-status-changed',
  /** Something a tile's backend told its pages (`kit.emit`): { name, data }. */
  backendEvent: 'ws:tile:backend-event',
  musicChanged: 'ws:tile:music-changed',
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
  /** A wheel a tile's page passed on: (instance key, dy in px). The tile column scrolls by it. */
  tileWheel: 'ws:core:tile-wheel',
  themeChanged: 'ws:core:theme',
  setSettings: 'ws:core:set-settings',
  // sessions: core window ⇄ main
  sessionsGet: 'ws:core:sessions-get',
  sessionsState: 'ws:core:sessions-state', // main → window
  /** A tile asked for the launcher, filled in (workshop.sessions.launch): main → window. */
  sessionsLaunch: 'ws:core:sessions-launch',
  sessionNew: 'ws:core:session-new',
  sessionResume: 'ws:core:session-resume',
  sessionPark: 'ws:core:session-park',
  sessionKill: 'ws:core:session-kill',
  sessionFocus: 'ws:core:session-focus',
  /** The leash: (id, 'pause' | 'resume' | 'refuse'). Core's window only (main/leash.ts). */
  sessionLeash: 'ws:core:session-leash',
  /** A permission prompt answered from a session's tile: (id, askId, allow) → whether it was still open. */
  sessionPermission: 'ws:core:session-permission',
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
  tileSessionsLaunch: 'ws:tile:sessions-launch',
  tileUsageGet: 'ws:tile:usage-get',
  tileUsageChanged: 'ws:tile:usage-changed', // main → tile
  // session tiles: the conversation, tailed by main (main/transcript.ts)
  transcriptGet: 'ws:core:transcript-get',
  transcriptChanged: 'ws:core:transcript', // main → window
  // the wolfpack: a session's subagents and helper sessions (main/agents.ts, main/helpers.ts)
  agentsGet: 'ws:core:agents-get',
  agentsState: 'ws:core:agents', // main → window
  agentPause: 'ws:core:agent-pause',
  agentResume: 'ws:core:agent-resume',
  agentKill: 'ws:core:agent-kill',
  agentDismiss: 'ws:core:agent-dismiss',
  // transcripts for tiles ("transcripts", bridge 1.7)
  tileTranscriptGet: 'ws:tile:transcript-get',
  tileTranscriptWatch: 'ws:tile:transcript-watch', // send: (session id, true to start, false to stop)
  tileTranscriptChanged: 'ws:tile:transcript-changed', // main → tile
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
  attention: 'ws:core:attention', // main → window: a session's mascot leaps once
  // track E: the preview pane (main/preview.ts) and images for a prompt (main/drops.ts)
  previewRead: 'ws:core:preview-read',
  previewWrite: 'ws:core:preview-write',
  previewTask: 'ws:core:preview-task',
  previewWatch: 'ws:core:preview-watch',
  previewOpenApp: 'ws:core:preview-open-app', // ⌘-click on a path: the file in its own Mac app
  previewOpen: 'ws:core:preview-open', // main → window: a session asked for a file (the doc CLI)
  previewChanged: 'ws:core:preview-changed', // main → window: the watched file changed on disk
  dropKeep: 'ws:core:drop-keep',
  // the screen recorder (main/recorder.ts): the top bar's button
  recToggle: 'ws:core:rec-toggle',
  recStateGet: 'ws:core:rec-state-get',
  recState: 'ws:core:rec-state', // main → window
  // install update (main/updates.ts): the top bar's button, packaged app only
  updateGet: 'ws:core:update-get',
  updateInstall: 'ws:core:update-install',
  updateState: 'ws:core:update-state' // main → window
} as const
