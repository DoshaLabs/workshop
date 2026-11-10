// The left column (sessions, most recently active first, parked ones under them), the launcher
// (the empty center: start a session) and the focus pane (the focused session's terminal).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODELS, PERMISSION_MODES } from '@shared/models'
import type { SessionView, SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { fit, focusTerminal, mount, unmount } from './terminals'
import { SessionUsage } from './UsageMeter'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

export function SessionColumn({ state, usage, onNew, onPick, launcher }: { state: SessionsState | null; usage: Usage | null; onNew: () => void; onPick: () => void; launcher: boolean }) {
  const [arm, setArm] = useState<string | null>(null)
  useEffect(() => {
    if (!arm) return
    const t = window.setTimeout(() => setArm(null), 3000)
    return () => window.clearTimeout(t)
  }, [arm])
  const sessions = state?.sessions ?? []
  const open = sessions.filter((s) => s.open)
  const parked = sessions.filter((s) => !s.open)

  const row = (s: SessionView) => (
    <div
      key={s.id}
      className={`session ${s.id === state?.focus && !launcher ? 'on' : ''} ${s.attention ? 'attention' : ''} ${s.open ? '' : 'parked'}`}
      title={`${s.title ? `${s.title}\n` : ''}${tilde(s.cwd)}`}
      onClick={() => {
        onPick()
        void (s.open ? window.core.focusSession(s.id) : window.core.resume(s.id))
      }}
    >
      <span className={`dot ${s.status}`} />
      <span className="session-text">
        <span className="session-name">{s.name}</span>
        <span className="session-folder">
          {base(s.cwd)} <SessionUsage id={s.id} usage={usage} />
        </span>
      </span>
      {s.open ? (
        <button
          className="ghost"
          title="Close (it keeps running in tmux; click it again to come back)"
          onClick={(e) => {
            e.stopPropagation()
            void window.core.park(s.id)
          }}
        >
          ×
        </button>
      ) : (
        <button
          className={`ghost ${arm === s.id ? 'armed' : ''}`}
          title={arm === s.id ? 'Click again to end it for good' : 'End this session (the conversation stays in Claude Code’s history)'}
          onClick={(e) => {
            e.stopPropagation()
            if (arm !== s.id) return setArm(s.id)
            setArm(null)
            void window.core.kill(s.id)
          }}
        >
          {arm === s.id ? 'end' : '⌫'}
        </button>
      )}
    </div>
  )
  return (
    <aside className="col sessions">
      <div className="col-title">
        Sessions
        <button className="ghost new" title="New session" onClick={onNew}>
          +
        </button>
      </div>
      <div className="session-list">
        {open.map(row)}
        {parked.length > 0 && <div className="col-sub">Closed</div>}
        {parked.map(row)}
        {sessions.length === 0 && <p className="empty">No sessions yet. Start one in the middle.</p>}
      </div>
    </aside>
  )
}

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
