// Files dropped on a session: from Finder, a screenshot's thumbnail, or a picture dragged out of a
// browser or another app. After deck's lib/drop.ts and useDropTarget. The CLI takes a file the way
// a terminal hands one over: its path, shell-escaped, as a bracketed paste. main decides which path
// that is (main/drops.ts): a Finder file's own, else a copy kept under the profile's drops/.
//
// Where a drop lands (as in deck, plus the prompt bar's chips from track E):
//   - the focused session's terminal in the center: the paths are pasted into it;
//   - a session tile's conversation or head: pasted into that session, which comes into focus;
//   - a session tile's prompt bar: a chip in the bar, sent with the text on ⏎.
// Anywhere else the window ignores a file drop (main.tsx), so it never navigates to the file.

import { useRef, useState } from 'react'
import type React from 'react'

export const hasFiles = (dt: DataTransfer | null): boolean => !!dt && Array.from(dt.types).includes('Files')

/**
 * The effect to claim while a drag hovers: one the SOURCE allows, or Chromium turns it into 'none'
 * and the drop never fires (a screenshot's thumbnail offers copy only).
 */
export function dropEffectFor(dt: DataTransfer): 'copy' | 'link' | 'move' {
  switch (dt.effectAllowed) {
    case 'link':
    case 'linkMove':
      return 'link'
    case 'move':
      return 'move'
    default:
      return 'copy'
  }
}

/** A path as a terminal pastes a dropped file: everything a shell would read is escaped. */
export const shellPath = (p: string): string => p.replace(/([^A-Za-z0-9_\-.,:/@+=~])/g, '\\$1')

/** The paths to send for these files; one main cannot keep is left out (and logged). */
export async function keptPaths(files: File[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    try {
      out.push(await window.core.keepDrop(f))
    } catch (err) {
      console.warn('[drop] not usable:', f.name, f.type, f.size, String(err))
    }
  }
  return out
}

/** Pastes `paths` into session `id`'s prompt, the way a terminal does for a drop: escaped, space-separated, a space after. */
export function pastePaths(id: string, paths: string[]): void {
  if (paths.length) window.core.ptyInput(id, `\x1b[200~${paths.map(shellPath).join(' ')} \x1b[201~`)
}

/**
 * Props that make an element take file drops for session `id`: the paths go into that session,
 * then `onDropped` runs (a tile brings its session into focus). `over` is true while a file hovers;
 * enter and leave are counted, since they fire for every child the pointer crosses. A drag that is
 * not files (a column's reorder) passes through untouched to `pass`.
 */
export function useFileDrop(id: string, onDropped?: () => void, pass?: Partial<Pick<React.DOMAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>>) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const handlers = {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth.current += 1
      setOver(true)
    },
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return pass?.onDragOver?.(e)
      e.preventDefault()
      e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer)
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return pass?.onDragLeave?.(e)
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      depth.current = 0
      setOver(false)
      if (!hasFiles(e.dataTransfer)) return pass?.onDrop?.(e)
      // Taken already by something inside (a tile's prompt bar makes it a chip).
      if (e.defaultPrevented) return
      // Always claim a file drop, even one that cannot be used. The File objects are taken now:
      // the DataTransfer is readable only during the event.
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files)
      void keptPaths(files).then((paths) => {
        if (!paths.length) return
        pastePaths(id, paths)
        onDropped?.()
      })
    }
  }
  return { over, handlers }
}
