// The file viewer: a picture, a PDF, a web page, a film or a sound a session points at, in core's
// lightbox (Lightbox.tsx) over the whole window. Text and markdown go to the preview pane instead,
// where they can be edited (preview-store.ts routes by shared/viewer.ts). ⌘-click on a path still
// opens the file in its own Mac app; so does the head's "open in app".
//
// Main serves the file on a `view://` origin of its own (main/viewer.ts), so a web page shown here
// cannot reach core's window. A web page runs its scripts in a sandboxed frame that may not
// navigate the window; its popups go to the browser. A binary the viewer does not know is never
// drawn: main says so, and that note is what shows.

import { useEffect, useState } from 'react'
import type { PreviewRef } from '@shared/preview'
import type { ViewDoc } from '@shared/viewer'
import { Lightbox } from './Lightbox'

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')
const dirOf = (p: string): string => p.replace(/\/[^/]*$/, '') || '/'
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
const WORD = { image: 'picture', pdf: 'PDF', html: 'web page', video: 'film', audio: 'sound' } as const

export function FileViewer({ target, onClose }: { target: PreviewRef; onClose: () => void }) {
  const [doc, setDoc] = useState<ViewDoc | null>(null)
  const [dims, setDims] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let live = true
    setDoc(null)
    setDims(null)
    setBroken(false)
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
            <img
              src={doc.url}
              alt={doc.name}
              draggable={false}
              onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
              onError={() => setBroken(true)}
            />
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
      </section>
    </Lightbox>
  )
}
