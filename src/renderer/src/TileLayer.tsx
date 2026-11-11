// Every live tile's page, in one layer over the window. A webview that leaves the DOM loses its
// page, so a tile's webview is mounted once and never moved in the tree: each frame it is laid
// over wherever the tile is showing (its face in the column, clipped to the column as it
// scrolls, the center pane, or the overlay's box over the whole window) and hidden with
// `visibility` when it is nowhere. (deck's WebLayer.)

import { useEffect, useRef } from 'react'
import type { TileInfo, TileView } from '@shared/ipc'

/** One page in the column: a tile's first instance (key = its id) or a later one (`<id>.<n>`). */
export interface Instance {
  key: string
  n: number
  tile: TileInfo
}

export function TileLayer({ instances, viewOf }: { instances: Instance[]; viewOf: (key: string) => TileView }) {
  return (
    <div className="tile-layer">
      {instances.map((i) => (
        <TilePage key={`${i.key}:${i.tile.rev}`} inst={i} where={viewOf(i.key)} />
      ))}
    </div>
  )
}

/** The radius inside a tile's border, where its page meets the tile's rounded bottom. */
function innerRadius(face: HTMLElement): number {
  const tile = face.closest('.tile')
  if (!tile) return 0
  const cs = getComputedStyle(tile)
  return Math.max(0, parseFloat(cs.borderBottomLeftRadius) - parseFloat(cs.borderBottomWidth))
}

/** The element a page is laid over in each view. */
const TARGET: Record<TileView, string> = { tile: 'data-face', pane: 'data-pane', overlay: 'data-overlay' }

function TilePage({ inst, where }: { inst: Instance; where: TileView }) {
  const box = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLElement>(null)
  const id = inst.key
  const { tile } = inst

  useEffect(() => {
    const el = box.current
    if (!el) return
    let raf = 0
    let last = ''
    const step = () => {
      raf = requestAnimationFrame(step)
      const face = document.querySelector<HTMLElement>(`[${TARGET[where]}="${id}"]`)
      let key = 'hidden'
      let style: Partial<CSSStyleDeclaration> = { visibility: 'hidden' }
      if (face) {
        const r = face.getBoundingClientRect()
        const clip = (face.closest('.tile-scroll') as HTMLElement | null)?.getBoundingClientRect() ?? r
        const top = Math.max(r.top, clip.top)
        const bottom = Math.min(r.bottom, clip.bottom)
        if (r.width > 0 && bottom > top) {
          // In the column the page is the tile's lower part, so its bottom corners are the tile's
          // (--tile-radius less the 1 px border), unless the column's edge cuts it there.
          const round = where === 'tile' && r.bottom <= clip.bottom ? innerRadius(face) : 0
          key = `${r.left} ${r.top} ${r.width} ${r.height} ${top} ${bottom} ${round}`
          style = {
            visibility: 'visible',
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            clipPath: `inset(${top - r.top}px 0 ${Math.max(0, r.bottom - bottom)}px 0 round 0 0 ${round}px ${round}px)`
          }
        }
      }
      if (key === last) return
      last = key
      Object.assign(el.style, style)
    }
    step()
    return () => cancelAnimationFrame(raf)
  }, [id, where])

  // Over the window the page takes the keyboard, so its own keys work at once. (Esc is core's:
  // main closes the overlay before the page sees it.)
  useEffect(() => {
    if (where === 'overlay') view.current?.focus()
  }, [where])

  return (
    <div ref={box} className={`tile-page ${where === 'overlay' ? 'over' : ''}`} style={{ visibility: 'hidden' }}>
      {/* Main matches the partition to the tile and instance (main/tiles.ts partitionOf). */}
      <webview ref={view} partition={inst.n === 1 ? tile.partition : `${tile.partition}.${inst.n}`} src={tile.src} />
    </div>
  )
}
