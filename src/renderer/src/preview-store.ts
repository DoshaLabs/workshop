// Which file the preview pane shows, for the whole window. A click on a path in a conversation and
// a session's `node "$WORKSHOP_DOC" open` both land here; App draws the pane in the center while
// there is one, and what the center showed before comes back when it closes.
//
// The pane may hold unsaved edits. While it does it registers a guard, and every way of closing it
// or replacing its file (a new file, Esc, ×, a session or a tile taking the center) asks the guard
// first. The guard does not block: it shows its question in the pane and keeps what was asked for,
// which goes ahead if the user chooses to discard.

import { useSyncExternalStore } from 'react'
import type { PreviewRef } from '@shared/preview'

/** Asked before the pane's file goes away: true to go ahead now; false keeps it, and `go` runs if the user discards. */
export type DocGuard = (go: () => void) => boolean

let current: PreviewRef | null = null
const subs = new Set<() => void>()
let guard: DocGuard | null = null
let started = false

const changed = (): void => subs.forEach((f) => f())

function start(): void {
  if (started) return
  started = true
  window.core.onOpenDoc((ref) => openDoc(ref))
}

/** Show a file in the pane. A fresh object every time, so the same file asked for again reloads. */
export function openDoc(ref: PreviewRef, force = false): void {
  if (current && !force && guard && !guard(() => openDoc(ref, true))) return
  current = { ...ref }
  changed()
}

/** Close the pane. False if it holds unsaved edits: it asks, and closes if the user discards them. */
export function closeDoc(force = false): boolean {
  if (!current) return true
  if (!force && guard && !guard(() => closeDoc(true))) return false
  current = null
  changed()
  return true
}

export function setDocGuard(g: DocGuard | null): void {
  guard = g
}

export function useDoc(): PreviewRef | null {
  return useSyncExternalStore(
    (f) => {
      start()
      subs.add(f)
      return () => void subs.delete(f)
    },
    () => current
  )
}
