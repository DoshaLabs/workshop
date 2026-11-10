// Drag to reorder, in either side column (track E). A tile is dragged by the grip (⠿) on its head
// and lands before or after the tile under the pointer, by which half of it the pointer is over (a
// bar shows where), or at the foot on the column's +. Each column has its own drag type, so a
// session cannot be dropped among the tiles or a tile among the sessions. The order itself is
// shared/order.ts; App saves it in settings.column.
//
// Tile pages are webviews laid over the window (TileLayer), and a webview takes every pointer
// event over it, drags included: the column under it would never hear the dragover. While a drag
// is on, the root carries `ws-dragging` and the pages stop taking the pointer (styles.css), so the
// drop lands on the cell beneath.

import { useEffect, useState } from 'react'
import type React from 'react'

export type Column = 'tiles' | 'sessions'
type Over = { key: string | null; after: boolean } | null

const mime = (col: Column): string => `application/x-workshop-${col}`

/** The class that lets drags through the tile pages. Removed on every way a drag can end. */
function dragging(on: boolean): void {
  document.documentElement.classList.toggle('ws-dragging', on)
}

/**
 * What rides under the pointer: a detached copy of the tile's head, never the live tile (Chromium
 * would picture a tile inside a scroller together with its neighbours). The browser takes its
 * picture at once, so it is removed a tick later.
 */
function ghost(from: HTMLElement | null, label: string): HTMLElement {
  const g = document.createElement('div')
  g.className = 'drag-ghost'
  const head = from?.closest('.tile, .session-center')?.querySelector(':scope > .head')
  if (head) {
    const copy = head.cloneNode(true) as HTMLElement
    for (const b of copy.querySelectorAll('button, canvas')) b.remove()
    g.append(copy)
  } else g.textContent = label
  document.body.append(g)
  return g
}

export function useReorder(col: Column, onMove: (key: string, target: string | null, after: boolean) => void) {
  const [over, setOver] = useState<Over>(null)
  useEffect(() => {
    const end = (): void => {
      dragging(false)
      setOver(null)
    }
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [])

  const half = (e: React.DragEvent, key: string | null): boolean => {
    if (key === null) return false
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY - r.top > r.height / 2
  }

  return {
    /** Props for the grip on a tile's head. */
    grip: (key: string, label: string) => ({
      draggable: true,
      className: 'grip',
      title: 'Drag to move it up or down the column',
      'aria-label': `Move ${label}`,
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      onDragStart: (e: React.DragEvent) => {
        e.stopPropagation()
        e.dataTransfer.setData(mime(col), key)
        e.dataTransfer.effectAllowed = 'move'
        const g = ghost(e.currentTarget as HTMLElement, label)
        e.dataTransfer.setDragImage(g, 16, 14)
        window.setTimeout(() => g.remove(), 0)
        dragging(true)
      }
    }),
    /** Props for a cell that takes a drop (`key` null: the column's foot). */
    target: (key: string | null) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(mime(col))) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const after = half(e, key)
        if (over?.key !== key || over.after !== after) setOver({ key, after })
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o?.key === key ? null : o))
      },
      onDrop: (e: React.DragEvent) => {
        const moved = e.dataTransfer.getData(mime(col))
        setOver(null)
        dragging(false)
        if (!moved) return
        e.preventDefault()
        e.stopPropagation()
        onMove(moved, key, half(e, key))
      }
    }),
    /** Where a drop on `key` would land, for the bar: 'before', 'after' or ''. */
    mark: (key: string | null): string => (over && over.key === key ? (over.after ? 'drop-after' : 'drop-before') : '')
  }
}
