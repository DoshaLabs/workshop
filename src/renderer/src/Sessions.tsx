// The launcher (the empty center: start a session) and the focus pane (the focused session's
// terminal). The session column is SessionColumn.tsx.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODELS, PERMISSION_MODES } from '@shared/models'
import type { SessionView } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { fit, focusTerminal, mount, unmount } from './terminals'
import { SessionUsage } from './UsageMeter'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

export function Launcher({ recent, onStarted }: { recent: string[]; onStarted: () => void }) {
  const [cwd, setCwd] = useState(recent[0] ?? '')
  const [worktree, setWorktree] = useState(false)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!cwd && recent[0]) setCwd(recent[0])
  }, [recent, cwd])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.core.newSession({ cwd, worktree, model, permissionMode: mode, name, prompt })
      setPrompt('')
      setName('')
      onStarted()
    } catch (err) {
      setError(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="launcher">
      <h1>New session</h1>
      <label>
        Folder
        <span className="row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/my-project" spellCheck={false} />
          <button onClick={() => void window.core.pickFolder(cwd).then((p) => p && setCwd(p))}>Choose…</button>
        </span>
      </label>
      {recent.length > 0 && (
        <div className="chips">
          {recent.map((r) => (
            <button key={r} className={r === cwd ? 'on' : ''} onClick={() => setCwd(r)} title={r}>
              {base(r)}
            </button>
          ))}
        </div>
      )}
      <div className="grid2">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Permissions
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
                {m.risky ? ' ⚠' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        In a new git worktree (its own branch, so it cannot trip over other sessions)
      </label>
      <label>
        Name <span className="muted">(optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="what this session is for" />
      </label>
      <label>
        First message <span className="muted">(optional)</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey && cwd && !busy) void start()
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!cwd || busy} onClick={() => void start()}>
        {busy ? 'Starting…' : 'Start session'} <span className="muted">⌘↩</span>
      </button>
    </section>
  )
}

export function FocusPane({ session, usage }: { session: SessionView; usage: Usage | null }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = box.current!
    mount(session.id, host)
    focusTerminal(session.id)
    const ro = new ResizeObserver(() => fit(session.id))
    ro.observe(host)
    return () => {
      ro.disconnect()
      unmount(session.id, host)
    }
  }, [session.id])
  return (
    <section className="pane">
      <header className="head">
        <span className={`dot ${session.status}`} />
        <span className="name" title={session.title ?? undefined}>
          {session.name}
          {session.title && session.title !== session.name && <span className="muted"> · {session.title}</span>}
        </span>
        <SessionUsage id={session.id} usage={usage} />
        <span className="session-folder" title={session.cwd}>
          {tilde(session.cwd)}
        </span>
      </header>
      <div className="term-host" ref={box} />
    </section>
  )
}
