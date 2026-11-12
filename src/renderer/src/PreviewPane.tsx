// The preview pane (CLAUDE.md §3): a file a session points at, in the center column. Markdown is
// rendered through @shared/markdown (a tree, never HTML) and its task boxes tick on disk; code and
// plain text are shown in the mono face with line numbers; `edit` turns any text file into a plain
// editor (⌘S saves). Main does all the reading and writing (main/preview.ts) and refuses folders,
// binaries and very large files with a note, which is what the pane then shows.
//
// Every write carries the mtime the pane read, so a file that changed underneath is never
// overwritten without asking. Main watches the file: a change on disk reloads it, unless there are
// unsaved edits, in which case the pane says so and leaves them alone. Unsaved edits also make every
// way out ask first (preview-store.ts's guard), in a bar in the pane rather than a native dialog.
// After deck's DocPane, without its images, PDFs and folder walking.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewDoc, PreviewRef } from '@shared/preview'
import { Markdown } from './Markdown'
import { closeDoc, openDoc, openView, setDocGuard } from './preview-store'

/** Past this many lines the text is one plain block without numbers (the DOM's cost). */
const LINE_CAP = 5000

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')
const dirOf = (p: string): string => p.replace(/\/[^/]*$/, '') || '/'
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)

export function PreviewPane({ target, onClose }: { target: PreviewRef; onClose: () => void }) {
  const [doc, setDoc] = useState<PreviewDoc | null>(null)
  const [reloads, setReloads] = useState(0)
  const [edit, setEdit] = useState(false)
  const [source, setSource] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<{ text: string; stale?: boolean } | null>(null)
  /** The file changed on disk while there were unsaved edits. */
  const [changed, setChanged] = useState(false)
  /** Something asked the pane to go away while it held unsaved edits: what to do on "discard". */
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const ticking = useRef(false)
  const body = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLElement>(null)

  const dirty = edit && doc?.text !== undefined && draft !== doc.text
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // A new reference (a click, a session's `open`) starts fresh, even for the file already showing.
  useEffect(() => {
    setEdit(false)
    setSource(!!target.line && /\.(md|markdown|mdx)$/i.test(target.path))
    setChanged(false)
    setLeaving(null)
  }, [target])

  useEffect(() => {
    let live = true
    setProblem(null)
    void window.core.readDoc(target.path, target.cwd).then((d) => {
      if (!live) return
      // A binary whose first bytes are a picture or a PDF, under a name that did not say so: the viewer's.
      if (d.view) {
        openView(target)
        closeDoc(true)
        return
      }
      setDoc(d)
      setDraft(d.text ?? '')
      setChanged(false)
    })
    return () => {
      live = false
    }
  }, [target, reloads])

  // Main watches the file the pane shows. A change is read at once: if the text on disk is what the
  // pane already has (our own save or tick, whose answer may come after the change does), only the
  // lock moves; otherwise it replaces what is shown, unless there are unsaved edits.
  const docRef = useRef(doc)
  docRef.current = doc
  const draftRef = useRef(draft)
  draftRef.current = draft
  const path = doc?.path ?? null
  useEffect(() => {
    if (!path) return
    void window.core.watchDoc(path)
    const off = window.core.onDocChanged((p, mtime) => {
      const d = docRef.current
      if (!d || p !== d.path || mtime === d.mtime) return
      void window.core.readDoc(p).then((fresh) => {
        const now = docRef.current
        if (!now || now.path !== fresh.path) return
        if (dirtyRef.current) {
          if (fresh.text === draftRef.current) setDoc(fresh)
          else if (fresh.text !== now.text) setChanged(true)
          else setDoc(fresh)
          return
        }
        setDoc(fresh)
        setDraft(fresh.text ?? '')
      })
    })
    return () => {
      off()
      void window.core.watchDoc(null)
    }
  }, [path])

  // While there are unsaved edits, anything that would take the pane away asks here first.
  useEffect(() => {
    if (!dirty) return setDocGuard(null)
    setDocGuard((go) => {
      setLeaving(() => go)
      return false
    })
    return () => setDocGuard(null)
  }, [dirty])

  useEffect(() => root.current?.focus(), [])

  const save = async (force = false): Promise<boolean> => {
    if (!doc || !edit || saving) return false
    setSaving(true)
    // "Save mine over it": the lock is the file as it is now, which the user chose to overwrite.
    const mtime = force ? (await window.core.readDoc(doc.path)).mtime : doc.mtime
    const r = await window.core.writeDoc(doc.path, draft, mtime)
    setSaving(false)
    if (r.ok) {
      setDoc(r.doc)
      setProblem(null)
      setChanged(false)
    } else setProblem({ text: r.error, stale: r.stale })
    return r.ok
  }

  /** The unsaved-edits question answered: what was asked for goes ahead. */
  const goOn = (): void => {
    const go = leaving
    setLeaving(null)
    setEdit(false)
    setDocGuard(null)
    go?.()
  }

  const tick = async (line: number, checked: boolean): Promise<void> => {
    if (!doc || ticking.current) return
    ticking.current = true
    const r = await window.core.tickTask(doc.path, line, checked, doc.mtime)
    ticking.current = false
    if (r.ok) {
      setDoc(r.doc)
      setDraft(r.doc.text ?? '')
      setProblem(null)
    } else setProblem({ text: r.error, stale: r.stale })
  }

  const reload = (): void => {
    setEdit(false)
    setReloads((n) => n + 1)
  }

  const close = (): void => {
    if (dirtyRef.current) setLeaving(() => onClose)
    else onClose()
  }

  // ⌘S saves; Esc closes. Taken before App's own Esc (which would close a tile's pane under this one).
  const keys = useRef({ close, save })
  keys.current = { close, save }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void keys.current.save()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        keys.current.close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const lines = useMemo(() => (doc?.text === undefined ? null : doc.text.split('\n')), [doc])
  const readable = doc && doc.kind !== 'refused'

  // The line a reference asked for, once it is drawn (once per file: a tick's re-read does not jump back).
  useEffect(() => {
    if (!path || !target.line) return
    body.current?.querySelector('[data-hit="1"]')?.scrollIntoView({ block: 'center' })
  }, [path, target, source])

  // Paths in a markdown file are relative to the file's own folder.
  const onPath = (p: string, line: number | null): void => openDoc({ path: p, line, cwd: doc ? dirOf(doc.path) : target.cwd })

  return (
    <section ref={root} className="pane preview" tabIndex={-1} data-preview={doc?.path ?? target.path}>
      <header className="head">
        <span className="name" title={doc?.path ?? target.path}>
          {doc?.name ?? target.path.split('/').pop()}
          {dirty && (
            <span className="preview-dirty" title="Unsaved edits (⌘S saves)">
              {' '}
              ●
            </span>
          )}
          {target.line && <span className="muted">:{target.line}</span>}
        </span>
        <span className="preview-where" title={doc?.path ?? target.path}>
          {tilde(dirOf(doc?.path ?? target.path))}
        </span>
        <span className="preview-meta">{doc ? describe(doc, lines) : 'reading…'}</span>
        {dirty && (
          <button className="preview-btn on" title="Write it to disk (⌘S)" disabled={saving} onClick={() => void save()}>
            {saving ? 'saving…' : 'save'}
          </button>
        )}
        {readable && (
          <button
            className={`preview-btn ${edit ? 'on' : ''}`}
            title={edit ? 'Back to reading' : 'Edit the file here (⌘S saves)'}
            onClick={() => {
              if (edit && dirty) return setLeaving(() => () => setEdit(false))
              setDraft(doc.text ?? '')
              setEdit(!edit)
            }}
          >
            edit
          </button>
        )}
        {doc?.kind === 'markdown' && !edit && (
          <button className={`preview-btn ${source ? 'on' : ''}`} title="Show the markdown as written" onClick={() => setSource((v) => !v)}>
            source
          </button>
        )}
        <button className="ghost" title="Close (Esc)" onClick={close}>
          ×
        </button>
      </header>
      {leaving && (
        <div className="preview-bar">
          <span>You have unsaved edits to {doc?.name}.</span>
          <button className="preview-btn on" onClick={() => void save().then((ok) => ok && goOn())}>
            save
          </button>
          <button className="preview-btn" onClick={goOn}>
            discard
          </button>
          <button className="preview-btn" onClick={() => setLeaving(null)}>
            keep editing
          </button>
        </div>
      )}
      {changed && !leaving && (
        <div className="preview-bar">
          <span>The file changed on disk while you were editing it.</span>
          <button className="preview-btn" title="Throw your edits away and read the file as it is now" onClick={reload}>
            reload
          </button>
          <button className="preview-btn" title="Write your version over the one on disk" onClick={() => void save(true)}>
            save mine over it
          </button>
        </div>
      )}
      {problem && (
        <div className="preview-bar is-problem">
          <span>{problem.text}</span>
          {problem.stale && (
            <button className="preview-btn" onClick={reload}>
              reload
            </button>
          )}
        </div>
      )}
      <div className={`preview-body ${edit ? 'is-editing' : ''}`} ref={body}>
        {!doc && <p className="preview-note">Reading…</p>}
        {doc?.kind === 'refused' && (
          <div className="preview-refused">
            <p>{doc.note}</p>
            <p className="preview-path">{doc.path}</p>
          </div>
        )}
        {readable && edit && (
          <textarea
            className="preview-edit"
            value={draft}
            spellCheck={false}
            autoFocus
            aria-label={`Edit ${doc.name}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Tab indents (a nested list item) instead of leaving the box; execCommand keeps ⌘Z working.
              if (e.key === 'Tab' && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
                e.preventDefault()
                document.execCommand('insertText', false, '  ')
              }
            }}
          />
        )}
        {readable && !edit && doc.kind === 'markdown' && !source && (
          <div className="chat-text preview-md">
            <Markdown text={doc.text ?? ''} big onPath={onPath} onTask={(line, checked) => void tick(line, checked)} />
          </div>
        )}
        {readable && !edit && lines && (doc.kind === 'text' || source) && (lines.length > LINE_CAP ? <pre className="preview-plain">{doc.text}</pre> : <Numbered lines={lines} hit={target.line} />)}
      </div>
    </section>
  )
}

/** Text with a line-number gutter; the line a reference pointed at is marked. */
function Numbered({ lines, hit }: { lines: string[]; hit: number | null }) {
  return (
    <div className="preview-code">
      {lines.map((l, i) => (
        <div className="preview-row" key={i} data-hit={hit === i + 1 ? '1' : undefined}>
          <span className="preview-ln">{i + 1}</span>
          <code>{l || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function describe(doc: PreviewDoc, lines: string[] | null): string {
  if (doc.kind === 'refused') return doc.missing ? 'missing' : doc.size ? size(doc.size) : ''
  return [doc.kind === 'markdown' ? 'markdown' : '', lines ? `${lines.length} lines` : '', size(doc.size)].filter(Boolean).join(' · ')
}
