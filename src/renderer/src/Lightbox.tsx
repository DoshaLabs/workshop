// Core's lightbox: a card over the whole window, above every tile's page. Tile pages are webviews
// in .tile-layer, a fixed layer; .lightbox is a later fixed layer with a higher z-index, so it
// covers them, as the overlay's strip does. A click on the backdrop or Esc closes it.
//
// Used by the + menu (TilePicker.tsx) and the file viewer (FileViewer.tsx). `place` pins the card's
// top (the menu: a taller tab grows it downward only) or centres it (the viewer).

import { useEffect, type ReactNode } from 'react'

export function Lightbox({ onClose, place = 'top', children }: { onClose: () => void; place?: 'top' | 'center'; children: ReactNode }) {
  // Esc closes the lightbox, and only the lightbox: caught on the way down so a pane open in the
  // center (whose Esc is a bubbling listener on the window) stays open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className={`lightbox ${place}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {children}
    </div>
  )
}
