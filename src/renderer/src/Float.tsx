// A tile popped out (bridge 1.8, a manifest's `"float": true`): its page in a small square over the
// window, under a strip that is core's alone. The tile's page is laid over `.float-face` by the tile
// layer (TileLayer.tsx, `data-float`) as it is over a column cell; this box only says where. The
// strip is outside the page's rectangle, so nothing the page draws can cover the name, the grip or
// the ×, and a float cannot pass itself off as a session or a permission prompt over the terminal.
//
// It starts at the active session's top-right corner (the focused terminal, else the center column)
// and keeps its place as an offset from that corner (shared/column.ts placeFloat), so it follows the
// session as the window changes and is never left outside the window.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { FLOAT_DEFAULT, FLOAT_SIZE, FLOAT_STRIP, floatOffset, placeFloat, type FloatAt, type Rect } from '@shared/column'

const rect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

/** The active session: its terminal while one is focused, else the center column. */
function anchor(): Rect {
  const el = document.querySelector('.col.center .term-host') ?? document.querySelector('.col.center')
  return el ? rect(el.getBoundingClientRect()) : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

/** The window below the top bar. */
function bounds(): Rect {
  const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar')) || 0
  return { left: 0, top: bar, right: window.innerWidth, bottom: window.innerHeight }
}

export function Float({ id, name, icon, by, at, onMove, onClose }: { id: string; name: string; icon: ReactNode; by?: string; at?: FloatAt; onMove: (at: FloatAt) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const where = useRef<FloatAt>(at ?? FLOAT_DEFAULT)
  if (!drag.current) where.current = at ?? FLOAT_DEFAULT

  // Placed every frame from the anchor, as the tile layer places pages: the center changes under it
  // (a session focused, the launcher, a window resize) without telling anyone.
  useEffect(() => {
    let raf = 0
    let last = ''
    const step = () => {
      raf = requestAnimationFrame(step)
      const el = box.current
      if (!el || drag.current) return
      const p = placeFloat(anchor(), where.current, bounds())
      const key = `${p.left} ${p.top}`
      if (key === last) return
      last = key
      el.style.left = `${p.left}px`
      el.style.top = `${p.top}px`
    }
    step()
    return () => cancelAnimationFrame(raf)
  }, [])

  const dragging = (on: boolean): void => {
    document.documentElement.classList.toggle('ws-dragging', on)
  }
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') || !box.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = box.current.getBoundingClientRect()
    drag.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
    // Tile pages are webviews and would swallow the pointer as it crosses them (reorder.ts does the same).
    dragging(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = box.current
    if (!d || !el) return
    const a = anchor()
    const p = placeFloat(a, floatOffset(a, d.left + e.clientX - d.x, d.top + e.clientY - d.y), bounds())
    el.style.left = `${p.left}px`
    el.style.top = `${p.top}px`
  }
  const up = () => {
    const el = box.current
    if (!drag.current || !el) return
    const r = el.getBoundingClientRect()
    where.current = floatOffset(anchor(), r.left, r.top)
    drag.current = null
    dragging(false)
    onMove(where.current)
  }
  // Unmounted mid-drag (put back, turned off): the pages take the pointer again.
  useEffect(() => () => {
    if (drag.current) dragging(false)
  }, [])

  return (
    <div ref={box} className="float" role="dialog" aria-label={`${name}, popped out`} style={{ width: FLOAT_SIZE }}>
      <div className="float-strip" style={{ height: FLOAT_STRIP }} title="Drag to move" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}>
        {icon}
        <span className="name">{name}</span>
        {by && <span className="by">{by}</span>}
        <button className="float-close" title={`Put ${name} back in the column`} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="float-face" data-float={id} style={{ height: FLOAT_SIZE }} />
    </div>
  )
}
