// The file viewer's 9:16 crop (FileViewer.tsx): a box over the picture, everything outside it
// dimmed. Drag inside the box to move it, its corner to size it, anywhere else to draw a new one
// from there. The box is kept in the picture's own pixels (shared/viewer.ts Crop), so what is saved
// is cut from the full picture, not from what the screen shows. `render` draws the result, with the
// caption beneath when asked.

import { useRef } from 'react'
import { CROP_RATIO, clampCrop, resizeCrop, wrapLines, type Crop, type ViewCaption } from '@shared/viewer'
import { FONT_SERIF } from '@shared/fonts'

type Drag = { mode: 'move'; dx: number; dy: number } | { mode: 'size' } | { mode: 'new'; ox: number; oy: number }

export function CropBox({ img, crop, onCrop }: { img: HTMLImageElement; crop: Crop; onCrop: (c: Crop) => void }) {
  const drag = useRef<Drag | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  /** Screen pixels per picture pixel. */
  const k = img.clientWidth / nw || 1

  /** The pointer, in the picture's own pixels. */
  const at = (e: React.PointerEvent): { x: number; y: number } => {
    const r = layer.current!.getBoundingClientRect()
    return { x: Math.min(nw, Math.max(0, (e.clientX - r.left) / k)), y: Math.min(nh, Math.max(0, (e.clientY - r.top) / k)) }
  }

  const down = (e: React.PointerEvent, d: (p: { x: number; y: number }) => Drag): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    layer.current!.setPointerCapture(e.pointerId)
    drag.current = d(at(e))
  }

  const move = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = at(e)
    if (d.mode === 'move') onCrop(clampCrop({ ...crop, x: p.x - d.dx, y: p.y - d.dy }, nw, nh))
    else if (d.mode === 'size') onCrop(resizeCrop(crop, p.x, p.y, nw, nh))
    else {
      // A new box grows from where the drag began toward the pointer, whichever way it goes.
      const w = Math.max(Math.abs(p.x - d.ox), Math.abs(p.y - d.oy) * CROP_RATIO)
      const h = w / CROP_RATIO
      onCrop(clampCrop({ x: p.x < d.ox ? d.ox - w : d.ox, y: p.y < d.oy ? d.oy - h : d.oy, w, h }, nw, nh))
    }
  }

  const up = (): void => {
    drag.current = null
  }

  return (
    <div
      ref={layer}
      className="crop-layer"
      onPointerDown={(e) => down(e, (p) => ({ mode: 'new', ox: p.x, oy: p.y }))}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className="crop-box"
        style={{ left: crop.x * k, top: crop.y * k, width: crop.w * k, height: crop.h * k }}
        onPointerDown={(e) => down(e, (p) => ({ mode: 'move', dx: p.x - crop.x, dy: p.y - crop.y }))}
      >
        <span className="crop-third v" />
        <span className="crop-third h" />
        <span className="crop-handle" title="Drag to size" onPointerDown={(e) => down(e, () => ({ mode: 'size' }))} />
      </div>
    </div>
  )
}

/** The caption's colours: a dark band, so it reads the same whatever theme the app is in. */
const BAND = '#111111'
const TEXT = '#f3efe6'
const SOURCE = '#a9a399'

/** The crop as a PNG, cut from the full picture, with the caption in a band beneath when given. */
export async function renderCrop(img: HTMLImageElement, crop: Crop, caption: ViewCaption | null): Promise<Uint8Array> {
  const w = Math.max(1, Math.round(crop.w))
  const h = Math.max(1, Math.round(crop.h))
  const pad = Math.round(w * 0.06)
  const size = Math.max(14, Math.round(w * 0.045))
  const small = Math.max(11, Math.round(size * 0.68))
  const font = (px: number, weight: number): string => `${weight} ${px}px ${FONT_SERIF}`
  const canvas = document.createElement('canvas')
  const g = canvas.getContext('2d')!
  let lines: string[] = []
  let from: string[] = []
  let band = 0
  if (caption) {
    await Promise.all([document.fonts.load(font(size, 600)), document.fonts.load(font(small, 400))]).catch(() => undefined)
    g.font = font(size, 600)
    lines = wrapLines(caption.text, w - pad * 2, (s) => g.measureText(s).width)
    g.font = font(small, 400)
    from = caption.source ? wrapLines(caption.source, w - pad * 2, (s) => g.measureText(s).width) : []
    band = pad + lines.length * size * 1.3 + (from.length ? size * 0.5 + from.length * small * 1.4 : 0) + pad
  }
  canvas.width = w
  canvas.height = h + Math.round(band)
  g.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
  if (caption) {
    g.fillStyle = BAND
    g.fillRect(0, h, w, canvas.height - h)
    g.textBaseline = 'top'
    g.fillStyle = TEXT
    g.font = font(size, 600)
    let y = h + pad
    for (const line of lines) {
      g.fillText(line, pad, y)
      y += size * 1.3
    }
    g.fillStyle = SOURCE
    g.font = font(small, 400)
    y += size * 0.5
    for (const line of from) {
      g.fillText(line, pad, y)
      y += small * 1.4
    }
  }
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
  if (!blob) throw new Error('the crop could not be drawn')
  return new Uint8Array(await blob.arrayBuffer())
}
