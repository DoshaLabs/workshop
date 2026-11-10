// What the + menu (TilePicker.tsx) and main say to each other about installing tiles, reading the
// index and loading folders (main/tile-menu.ts). Kept apart from ipc.ts so this track's channels
// sit in one place.

import type { Permissions } from './manifest'
import type { IndexEntry } from './tile-index'
import type { PermissionChange } from './permissions'

/** What install remembers about a tile it put in userData `tiles/<id>`. */
export interface InstallRecord {
  id: string
  repo: string
  commit: string
  version: string
  /** What the user agreed to: an update that adds to these asks again. */
  permissions: Permissions
  installedAt: string
}

/** The index as the Marketplace tab sees it. */
export interface IndexState {
  /** Where it was read from, or null when none is set (the tab then says what it will hold). */
  source: string | null
  /** Set by WORKSHOP_INDEX rather than settings (tests, a local index): the tab's field is read-only then. */
  fromEnv: boolean
  entries: IndexEntry[]
  /** Entries that were dropped, and why. */
  errors: string[]
  /** Why the index could not be read at all, or null. */
  problem: string | null
}

/** A tile fetched and checked, waiting for the user's yes (or for nothing, when an update asks for no more). */
export interface PendingInstall {
  token: string
  id: string
  name: string
  author: string
  version: string
  hint: string
  repo: string
  commit: string
  permissions: Permissions
  /** Every permission in plain words. */
  words: string[]
  /** Null for a new install; else what is installed now and what changes. */
  update: { version: string; commit: string; change: PermissionChange } | null
  /** Whether the user must be asked: a new install always; an update only if it asks for more. */
  ask: boolean
  warnings: string[]
}

export interface InstallRequest {
  repo: string
  commit: string
  /** From the index: the id the entry names and the permissions it lists. The clone must match. */
  expect?: { id: string; permissions: Permissions }
}

export const MENU = {
  state: 'ws:menu:state', // → { installed: InstallRecord[]; index: IndexState }
  setIndex: 'ws:menu:set-index', // (source) → IndexState
  prepare: 'ws:menu:prepare', // (InstallRequest) → PendingInstall
  confirm: 'ws:menu:confirm', // (token) → { id }
  cancel: 'ws:menu:cancel', // (token)
  remove: 'ws:menu:remove', // (id, { storage }) → void
  loadFolder: 'ws:menu:load-folder' // () → the folder loaded, or null
} as const
