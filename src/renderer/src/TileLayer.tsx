// Every live tile's page, in one layer over the window. A webview that leaves the DOM loses its
// page, so a tile's webview is mounted once and never moved in the tree: each frame it is laid
// over wherever the tile is showing (its face in the column, clipped to the column as it
// scrolls, or the center pane) and hidden with `visibility` when it is nowhere. (deck's WebLayer.)

import { useEffect, useRef } from 'react'
import type { TileInfo } from '@shared/ipc'

export function TileLayer({ tiles, pane }: { tiles: TileInfo[]; pane: string | null }) {
  return (
    <div className="tile-layer">
      {tiles.map((t) => (
        <TileView key={`${t.manifest.id}:${t.rev}`} tile={t} inPane={pane === t.manifest.id} />
      ))}
    </div>
  )
}

function TileView({ tile, inPane }: { tile: TileInfo; inPane: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const id = tile.manifest.id

  useEffect(() => {
    const el = box.current
    if (!el) return
    let raf = 0
    let last = ''
    const step = () => {
      raf = requestAnimationFrame(step)
      const face = document.querySelector<HTMLElement>(inPane ? `[data-pane="${id}"]` : `[data-face="${id}"]`)
      let key = 'hidden'
      let style: Partial<CSSStyleDeclaration> = { visibility: 'hidden' }
      if (face) {
        const r = face.getBoundingClientRect()
        const clip = (face.closest('.tile-scroll') as HTMLElement | null)?.getBoundingClientRect() ?? r
        const top = Math.max(r.top, clip.top)
        const bottom = Math.min(r.bottom, clip.bottom)
        if (r.width > 0 && bottom > top) {
          key = `${r.left} ${r.top} ${r.width} ${r.height} ${top} ${bottom}`
          style = {
            visibility: 'visible',
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            clipPath: `inset(${top - r.top}px 0 ${Math.max(0, r.bottom - bottom)}px 0)`
          }
        }
      }
      if (key === last) return
      last = key
      Object.assign(el.style, style)
    }
    step()
    return () => cancelAnimationFrame(raf)
  }, [id, inPane])

  return (
    <div ref={box} className="tile-page" style={{ visibility: 'hidden' }}>
      <webview partition={tile.partition} src={tile.src} />
    </div>
  )
}
