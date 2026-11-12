// The file viewer: a picture, a PDF, a web page, a film or a sound a session points at, in core's
// lightbox (Lightbox.tsx) over the whole window. Text and markdown go to the preview pane instead,
// where they can be edited (preview-store.ts routes by shared/viewer.ts). ⌘-click on a path still
// opens the file in its own Mac app; so does the head's "open in app".
//
// Main serves the file on a `view://` origin of its own (main/viewer.ts), so a web page shown here
// cannot reach core's window. A web page runs its scripts in a sandboxed frame that may not
// navigate the window; its popups go to the browser. A binary the viewer does not know is never
// drawn: main says so, and that note is what shows.

import { useEffect, useRef, useState } from 'react'
import type { PreviewRef } from '@shared/preview'
import { cropName, initialCrop, type Crop, type ViewDoc } from '@shared/viewer'
import { CropBox, renderCrop } from './Crop'
import { Lightbox } from './Lightbox'

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')
const dirOf = (p: string): string => p.replace(/\/[^/]*$/, '') || '/'
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
const WORD = { image: 'picture', pdf: 'PDF', html: 'web page', video: 'film', audio: 'sound' } as const

export function FileViewer({ target, onClose }: { target: PreviewRef; onClose: () => void }) {
  const [doc, setDoc] = useState<ViewDoc | null>(null)
  const [dims, setDims] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  /** Where the last download went, shown on the button for a few seconds. */
  const [saved, setSaved] = useState<string | null>(null)
  /** The 9:16 crop, in the picture's own pixels, while cropping (pictures only). */
  const [crop, setCrop] = useState<Crop | null>(null)
  /** Put the caption under the crop: off until ticked, and only for a picture that came with one. */
  const [withCaption, setWithCaption] = useState(false)
  const [cropErr, setCropErr] = useState<string | null>(null)
  const img = useRef<HTMLImageElement>(null)
  /** Re-render when the picture's drawn size changes, so the box stays on it. */
  const [, setDrawn] = useState(0)

  useEffect(() => {
    let live = true
    setDoc(null)
    setDims(null)
    setBroken(false)
    setSaved(null)
    setCrop(null)
    setWithCaption(false)
    setCropErr(null)
    void window.core.viewFile(target.path, target.cwd).then((d) => live && setDoc(d))
    return () => {
      live = false
    }
  }, [target])

  // While the viewer is up, main turns Esc anywhere in the window (inside a PDF or a page too) into a close.
  useEffect(() => {
    void window.core.viewOpen(true)
    const off = window.core.onViewClose(onClose)
    return () => {
      off()
      void window.core.viewOpen(false)
    }
  }, [onClose])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 3000)
    return () => clearTimeout(t)
  }, [saved])

  const download = async (): Promise<void> => {
    if (!doc || doc.kind === 'refused') return
    const to = await window.core.viewSave(doc.path).catch(() => null)
    if (to) setSaved(to)
  }

  useEffect(() => {
    const el = img.current
    if (!crop || !el) return
    const ro = new ResizeObserver(() => setDrawn((n) => n + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [crop !== null])

  const startCrop = (): void => {
    const el = img.current
    if (!el?.naturalWidth) return
    setCropErr(null)
    setCrop(crop ? null : initialCrop(el.naturalWidth, el.naturalHeight))
  }

  const saveCrop = async (): Promise<void> => {
    const el = img.current
    if (!el || !crop || !doc || doc.kind === 'refused') return
    setCropErr(null)
    try {
      const png = await renderCrop(el, crop, withCaption && target.caption ? target.caption : null)
      const to = await window.core.viewSaveCrop(png, cropName(doc.name))
      if (to) {
        setSaved(to)
        setCrop(null)
      }
    } catch (err) {
      setCropErr(err instanceof Error ? err.message : String(err))
    }
  }

  const path = doc?.path ?? target.path
  const name = doc?.name ?? path.split('/').pop()
  const wide = doc?.kind === 'pdf' || doc?.kind === 'html'

  return (
    <Lightbox onClose={onClose} place="center">
      <section className={`viewer ${wide ? 'wide' : ''} ${doc?.kind ?? ''}`} role="dialog" aria-label={name} data-viewer={path}>
        <header className="head">
          <span className="name" title={path}>
            {name}
          </span>
          <span className="preview-where" title={path}>
            {tilde(dirOf(path))}
          </span>
          {doc && doc.kind !== 'refused' && (
            <span className="preview-meta">
              {[WORD[doc.kind], dims, size(doc.size)].filter(Boolean).join(' · ')}
            </span>
          )}
          {doc?.kind === 'image' && !broken && (
            <button className={`preview-btn ${crop ? 'on' : ''}`} aria-pressed={!!crop} title="Choose a 9:16 part of the picture to save" onClick={startCrop}>
              crop 9:16
            </button>
          )}
          {doc && doc.kind !== 'refused' && (
            <button className="preview-btn" title={saved ? `Saved to ${tilde(saved)}` : 'Save a copy (Downloads first)'} onClick={() => void download()}>
              {saved ? 'saved' : 'download'}
            </button>
          )}
          <button className="preview-btn" title="Open it in the Mac app that owns its type" onClick={() => void window.core.openFileApp(path, target.cwd)}>
            open in app
          </button>
          <button className="ghost" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="viewer-body">
          {!doc ? (
            <p className="viewer-note">reading…</p>
          ) : doc.kind === 'refused' ? (
            <p className="viewer-note">{doc.note}</p>
          ) : broken ? (
            <p className="viewer-note">This {WORD[doc.kind]} could not be drawn here. “open in app” opens it in its own app.</p>
          ) : doc.kind === 'image' ? (
            <div className={`crop-stage ${crop ? 'cropping' : ''}`}>
              {/* With CORS (main sends it for a picture), so the crop can read it into a canvas. */}
              <img
                ref={img}
                src={doc.url}
                alt={doc.name}
                crossOrigin="anonymous"
                draggable={false}
                onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
                onError={() => setBroken(true)}
              />
              {crop && img.current && <CropBox img={img.current} crop={crop} onCrop={setCrop} />}
            </div>
          ) : doc.kind === 'video' ? (
            <video src={doc.url} controls autoPlay onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)} onError={() => setBroken(true)} />
          ) : doc.kind === 'audio' ? (
            <audio src={doc.url} controls autoPlay onError={() => setBroken(true)} />
          ) : doc.kind === 'pdf' ? (
            <iframe src={doc.url} title={doc.name} />
          ) : (
            <iframe src={doc.url} title={doc.name} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" />
          )}
        </div>
        {crop && withCaption && target.caption && (
          <div className="crop-caption-preview">
            <p>{target.caption.text}</p>
            {target.caption.source && <p className="from">{target.caption.source}</p>}
          </div>
        )}
        {crop && (
          <footer className="crop-bar">
            {target.caption && (
              <label className="crop-caption" title={[target.caption.text, target.caption.source].filter(Boolean).join(' · ')}>
                <input type="checkbox" checked={withCaption} onChange={(e) => setWithCaption(e.target.checked)} />
                include the caption beneath
              </label>
            )}
            <span className="crop-size">
              {Math.round(crop.w)} × {Math.round(crop.h)}
            </span>
            {cropErr && <span className="crop-err">{cropErr}</span>}
            <button className="preview-btn" onClick={() => setCrop(null)}>
              cancel
            </button>
            <button className="preview-btn primary" onClick={() => void saveCrop()}>
              download crop
            </button>
          </footer>
        )}
      </section>
    </Lightbox>
  )
}
