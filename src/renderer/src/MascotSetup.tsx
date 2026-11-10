// The mascot's setup screen (CLAUDE.md §8), in the center column: use your own sprite sheet
// instead of the Knot. Drop in a sprite sheet, check
// the frame grid workshop guessed, pick the frames and speed for each pose with a live preview,
// name the mascot, save. It recommends Elthen's fox and links to it; workshop never downloads
// the sheet, and knows its layout so that dropping it in maps everything at once.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  DEFAULT_NAME,
  FOXTROT,
  MASCOT_STATES,
  MAX_SHEET_BYTES,
  STATE_HINT,
  STATE_LABEL,
  artBox,
  checkPack,
  framesPerRow,
  guessGrid,
  recognise,
  type FrameRun,
  type KnownSheet,
  type MascotPack,
  type MascotState,
  type Pixels
} from '@shared/mascot'
import { Sprite } from './Mascot'
import { useActiveMascot } from './mascot-store'

interface Draft {
  /** The sheet as a data: URL (the window may show images only from itself and data:). */
  url: string
  /** The file's bytes, saved as they came. */
  bytes: Uint8Array
  pixels: Pixels
  frame: { w: number; h: number }
  states: Partial<Record<MascotState, FrameRun>>
  known: KnownSheet | null
  /** Carried over from a pack being edited, or from the known sheet. */
  extra: Pick<MascotPack, 'worker' | 'credit'>
}

const DEFAULT_MS = 150

function bytesToDataUrl(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(s)}`
}
function dataUrlToBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function decode(url: string): Promise<Pixels> {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height)
  return { width: d.width, height: d.height, data: d.data }
}

/** A first mapping for a sheet workshop does not know: the rows in order, each with the frames it holds. */
function autoMap(counts: number[]): Partial<Record<MascotState, FrameRun>> {
  const out: Partial<Record<MascotState, FrameRun>> = {}
  let row = 0
  for (const s of MASCOT_STATES) {
    while (row < counts.length && counts[row] === 0) row++
    if (row >= counts.length) break
    out[s] = { row, from: 0, frames: counts[row], ms: s === 'run' || s === 'leap' ? 80 : DEFAULT_MS }
    row++
  }
  return out
}

/** Keeps only the runs that still fit a grid. */
function fit(states: Draft['states'], cols: number, rows: number): Draft['states'] {
  const out: Draft['states'] = {}
  for (const [k, r] of Object.entries(states) as [MascotState, FrameRun][]) if (r.row < rows && r.from + r.frames <= cols) out[k] = r
  return out
}

export function MascotSetup({ onClose }: { onClose: () => void }) {
  const active = useActiveMascot()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [name, setName] = useState(active?.pack.name ?? DEFAULT_NAME)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const load = async (bytes: Uint8Array, from?: MascotPack): Promise<void> => {
    setError('')
    if (bytes.byteLength > MAX_SHEET_BYTES) return setError(`That file is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB.`)
    const url = bytesToDataUrl(bytes)
    let pixels: Pixels
    try {
      pixels = await decode(url)
    } catch {
      return setError('That is not a PNG workshop can read.')
    }
    const known = from ? null : recognise(pixels)
    const frame = from?.frame ?? known?.frame ?? guessGrid(pixels)
    const states = from?.states ?? known?.pack.states ?? autoMap(framesPerRow(pixels, frame))
    const extra = from ? { worker: from.worker, credit: from.credit } : known ? { worker: known.pack.worker, credit: known.pack.credit } : {}
    setDraft({ url, bytes, pixels, frame, states, known, extra })
    if (known && !from) setName(DEFAULT_NAME)
  }

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return
    if (f.type && f.type !== 'image/png') return setError('A sprite sheet must be a PNG.')
    await load(new Uint8Array(await f.arrayBuffer()))
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    void pick(e.dataTransfer.files[0])
  }

  const grid = draft ? { cols: Math.floor(draft.pixels.width / draft.frame.w), rows: Math.floor(draft.pixels.height / draft.frame.h) } : null
  const counts = useMemo(() => (draft ? framesPerRow(draft.pixels, draft.frame) : []), [draft?.pixels, draft?.frame])

  /** The pack as it would be saved, checked by the same validator main uses. */
  const pack = useMemo(() => {
    if (!draft) return null
    const box = draft.known && draft.frame.w === draft.known.frame.w && draft.frame.h === draft.known.frame.h ? draft.known.pack.box : (artBox(draft.pixels, draft.frame) ?? undefined)
    return checkPack({ format: 1, name: name.trim(), image: 'sheet.png', sheet: { w: draft.pixels.width, h: draft.pixels.height }, frame: draft.frame, ...(box ? { box } : {}), states: draft.states, ...draft.extra })
  }, [draft, name])

  const setFrame = (w: number, h: number): void => {
    if (!draft || !(w >= 4 && h >= 4)) return
    const frame = { w: Math.min(w, draft.pixels.width), h: Math.min(h, draft.pixels.height) }
    const cols = Math.floor(draft.pixels.width / frame.w)
    const rows = Math.floor(draft.pixels.height / frame.h)
    const kept = fit(draft.states, cols, rows)
    setDraft({ ...draft, frame, states: Object.keys(kept).length ? kept : autoMap(framesPerRow(draft.pixels, frame)), known: null })
  }
  const setRun = (s: MascotState, r: FrameRun | null): void => {
    if (!draft) return
    const states = { ...draft.states }
    if (r) states[s] = r
    else delete states[s]
    setDraft({ ...draft, states })
  }

  const save = async (): Promise<void> => {
    if (!draft || !pack?.ok) return
    setBusy(true)
    setError('')
    try {
      await window.core.saveMascot(pack.pack, draft.bytes)
      setDraft(null)
    } catch (err) {
      setError(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="launcher mascot-setup">
      <h1>
        Mascot
        <button className="ghost close" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </h1>
      <p className="muted">
        Every session’s head shows the Knot: small and slow while it rests, full size and fast while Claude works, in the theme’s alert colour when it needs you. Use your own sprite sheet instead of the Knot: a PNG of frames, and which frames are which pose. Remove it to go back to the Knot.
      </p>

      <div className="mascot-reco">
        <strong>Recommended: Foxtrot, {FOXTROT.title}</strong>
        <p>
          Download the sheet from Elthen’s page (name your own price; $0 is allowed and the licence is the same) and drop the PNG in below. Workshop knows its layout, so there is nothing to set up.
        </p>
        <ul>
          <li>The art is Elthen’s, under his own licence, not this project’s.</li>
          <li>Credit is not required, but he appreciates it: workshop credits him here by name, and suggests a tip if you can.</li>
          <li>You may not redistribute the sheet, use it in anything blockchain-related, or train AI on it.</li>
        </ul>
        <button onClick={() => void window.core.openExternal(FOXTROT.url)}>Get Elthen’s fox on itch.io ↗</button>
      </div>

      <div
        className={`mascot-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        Drop a PNG sprite sheet here, or{' '}
        <button onClick={() => file.current?.click()}>Choose…</button>
        <input ref={file} type="file" accept="image/png" hidden onChange={(e) => void pick(e.target.files?.[0]).then(() => (e.target.value = ''))} />
      </div>

      {error && <p className="error">{error}</p>}

      {!draft && active && (
        <div className="mascot-current">
          <span>
            Now: <strong>{active.pack.name}</strong>
            {active.pack.credit && (
              <span className="muted">
                {' '}
                · art by{' '}
                <a href={active.pack.credit.url} onClick={(e) => {
                    e.preventDefault()
                    void window.core.openExternal(active.pack.credit!.url)
                  }}>
                  {active.pack.credit.by}
                </a>
              </span>
            )}
          </span>
          <span className="mascot-poses">
            {MASCOT_STATES.map((s) => (
              <span key={s} className="mascot-pose" title={STATE_HINT[s]}>
                <Sprite pack={active.pack} sheet="var(--mascot-sheet)" state={s} scale={2 * Math.max(1, Math.floor(18 / (active.pack.box?.h ?? active.pack.frame.h)))} />
                <small>{STATE_LABEL[s]}</small>
              </span>
            ))}
          </span>
          <span className="row">
            <button onClick={() => void load(dataUrlToBytes(active.sheet), active.pack).then(() => setName(active.pack.name))}>Edit</button>
            <button className="danger" onClick={() => void window.core.removeMascot()} title="Delete this pack and go back to the Knot">
              Remove
            </button>
          </span>
        </div>
      )}

      {draft && grid && (
        <>
          {draft.known && <p className="mascot-known">Recognised: {draft.known.title}. Every pose is mapped.</p>}
          <SheetView draft={draft} />
          <div className="grid2">
            <label>
              Frame width
              <input type="number" min={4} value={draft.frame.w} onChange={(e) => setFrame(Number(e.target.value), draft.frame.h)} />
            </label>
            <label>
              Frame height
              <input type="number" min={4} value={draft.frame.h} onChange={(e) => setFrame(draft.frame.w, Number(e.target.value))} />
            </label>
          </div>
          <p className="muted">
            {draft.pixels.width} × {draft.pixels.height}: {grid.rows} rows of {grid.cols} frames.{' '}
            <button className="link" onClick={() => setFrame(guessGrid(draft.pixels).w, guessGrid(draft.pixels).h)}>
              Guess again
            </button>
          </p>

          <div className="mascot-states">
            {MASCOT_STATES.map((s) => {
              const r = draft.states[s]
              return (
                <div key={s} className="mascot-state" data-state={s}>
                  <div className="mascot-state-name">
                    {STATE_LABEL[s]}
                    <small>{STATE_HINT[s]}</small>
                  </div>
                  <label>
                    Row
                    <select
                      value={r ? r.row : ''}
                      onChange={(e) => {
                        const row = e.target.value === '' ? null : Number(e.target.value)
                        setRun(s, row === null ? null : { row, from: 0, frames: Math.max(1, counts[row] || 1), ms: r?.ms ?? DEFAULT_MS })
                      }}
                    >
                      <option value="">none (borrows the nearest)</option>
                      {Array.from({ length: grid.rows }, (_, i) => (
                        <option key={i} value={i}>
                          {i + 1} · {counts[i]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    From
                    <input type="number" min={1} max={grid.cols} disabled={!r} value={r ? r.from + 1 : ''} onChange={(e) => r && setRun(s, { ...r, from: Math.max(0, Math.min(grid.cols - r.frames, Number(e.target.value) - 1)) })} />
                  </label>
                  <label>
                    Frames
                    <input type="number" min={1} max={grid.cols} disabled={!r} value={r ? r.frames : ''} onChange={(e) => r && setRun(s, { ...r, frames: Math.max(1, Math.min(grid.cols - r.from, Number(e.target.value))) })} />
                  </label>
                  <label>
                    ms / frame
                    <input type="number" min={16} step={10} disabled={!r} value={r ? r.ms : ''} onChange={(e) => r && setRun(s, { ...r, ms: Math.max(16, Number(e.target.value) || DEFAULT_MS) })} />
                  </label>
                  <span className="mascot-preview">
                    {pack?.ok && <Sprite pack={pack.pack} sheet={`url("${draft.url}")`} state={s} scale={2 * Math.max(1, Math.floor(18 / (pack.pack.box?.h ?? pack.pack.frame.h)))} />}
                  </span>
                </div>
              )
            })}
          </div>

          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={DEFAULT_NAME} maxLength={40} />
          </label>
          {pack && !pack.ok && (
            <ul className="error">
              {pack.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <span className="row">
            <button className="primary" disabled={!pack?.ok || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </span>
        </>
      )}
    </section>
  )
}

/** The sheet drawn large with its frame grid over it, crisp. */
function SheetView({ draft }: { draft: Draft }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const { width, height } = draft.pixels
    const scale = Math.max(1, Math.floor(520 / width))
    c.width = width * scale
    c.height = height * scale
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    const src = document.createElement('canvas')
    src.width = width
    src.height = height
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(draft.pixels.data), width, height), 0, 0)
    ctx.drawImage(src, 0, 0, c.width, c.height)
    ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--ws-accent').trim() || getComputedStyle(c).color
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = draft.frame.w; x < width; x += draft.frame.w) {
      ctx.moveTo(x * scale + 0.5, 0)
      ctx.lineTo(x * scale + 0.5, c.height)
    }
    for (let y = draft.frame.h; y < height; y += draft.frame.h) {
      ctx.moveTo(0, y * scale + 0.5)
      ctx.lineTo(c.width, y * scale + 0.5)
    }
    ctx.stroke()
  }, [draft.pixels, draft.frame])
  return (
    <div className="mascot-sheet">
      <canvas ref={canvas} />
    </div>
  )
}
