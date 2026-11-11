// The launcher (the empty center: start a session) and the focus pane (the focused session's
// terminal). The session column is SessionColumn.tsx.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODELS, PERMISSION_MODES } from '@shared/models'
import type { LaunchPrefill, SessionView } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { fit, focusTerminal, mount, unmount } from './terminals'
import { SessionUsage } from './UsageMeter'
import { Mascot } from './Mascot'
import { KnotCanvas } from './Knot'
import { useFileDrop } from './drop'
import { ParkButton } from './SessionColumn'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

export function Launcher({ recent, prefill, onStarted }: { recent: string[]; prefill?: LaunchPrefill; onStarted: () => void }) {
  const [cwd, setCwd] = useState(recent[0] ?? '')
  const [worktree, setWorktree] = useState(false)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('auto')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [typing, setTyping] = useState(recent.length === 0)
  /** The worktree's name a tile asked for (workshop.sessions.launch); cleared when the box is unticked. */
  const [branch, setBranch] = useState('')
  const startButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!cwd && recent[0]) setCwd(recent[0])
  }, [recent, cwd])

  // A tile filled the form in: its folder and worktree, and Start focused for the user to press.
  useEffect(() => {
    if (!prefill) return
    setCwd(prefill.cwd)
    setWorktree(!!prefill.worktree)
    setBranch(prefill.worktree ? (prefill.branch ?? '') : '')
    // The worktree's name is shown as the session's name, which the user can still change.
    if (prefill.worktree && prefill.branch) setName(prefill.branch)
    setError('')
    startButton.current?.focus()
  }, [prefill?.nonce])

  const start = async (): Promise<void> => {
    if (!cwd || busy) return
    setBusy(true)
    setError('')
    try {
      await window.core.newSession({ cwd, worktree, ...(worktree && branch ? { worktreeName: branch } : {}), model, permissionMode: mode, name, prompt })
      setPrompt('')
      setName('')
      onStarted()
    } catch (err) {
      setError(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const choose = (): void => void window.core.pickFolder(cwd).then((p) => p && setCwd(p))
  // The recent folders as cards, the chosen one first if it is not among them.
  const cards = recent.slice(0, 6)
  const picked = MODELS.find((m) => m.id === model)
  const perm = PERMISSION_MODES.find((m) => m.id === mode)

  return (
    <section className="launcher launch">
      <div className="launch-hero">
        <KnotCanvas mode="rest" size={112} className="launch-knot" />
        <h1>What are you working on?</h1>
      </div>

      <div className="launch-compose">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          autoFocus
          placeholder="Describe the task, or leave this empty and start talking once the session opens."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) void start()
          }}
        />
        <div className="launch-compose-foot">
          <span className="launch-where" title={cwd || undefined}>
            {cwd ? <>in <b>{base(cwd)}</b></> : 'Pick a folder below'}
          </span>
          <button ref={startButton} className="launch-go" disabled={!cwd || busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start session'}
            <kbd>⌘↩</kbd>
          </button>
        </div>
      </div>
      {error && <p className="launch-error">{error}</p>}

      <div className="launch-section">
        <h2>Folder</h2>
        {cards.length > 0 && (
          <div className="launch-folders">
            {cards.map((r) => (
              <button key={r} className={`launch-folder${r === cwd ? ' on' : ''}`} onClick={() => setCwd(r)} title={r}>
                <b>{base(r)}</b>
                <span>{'\u200e' + (tilde(r.replace(/\/[^/]*\/?$/, '')) || '/') + '\u200e'}</span>
              </button>
            ))}
            <button className="launch-folder other" onClick={choose}>
              <b>Another folder…</b>
              <span>opens the Finder</span>
            </button>
          </div>
        )}
        {typing || cards.length === 0 || !cards.includes(cwd) ? (
          <span className="launch-path">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/my-project" spellCheck={false} />
            {cards.length === 0 && <button onClick={choose}>Choose…</button>}
          </span>
        ) : (
          <button className="launch-path-show" onClick={() => setTyping(true)} title="Type a path instead">
            Type a path instead
          </button>
        )}
      </div>

      <div className="launch-section">
        <h2>Model</h2>
        <div className="launch-pills" role="radiogroup" aria-label="Model">
          {MODELS.map((m) => (
            <button key={m.id} role="radio" aria-checked={m.id === model} className={m.id === model ? 'on' : ''} onClick={() => setModel(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        {picked && <p className="launch-hint">{picked.hint}</p>}
      </div>

      <div className="launch-section">
        <h2>Permissions</h2>
        <div className="launch-pills" role="radiogroup" aria-label="Permissions">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={m.id === mode}
              className={`${m.id === mode ? 'on' : ''}${m.risky ? ' risky' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {perm && <p className={`launch-hint${perm.risky ? ' risky' : ''}`}>{perm.hint}</p>}
      </div>

      <div className="launch-section launch-extras">
        <label className="launch-switch">
          <input type="checkbox" role="switch" checked={worktree} onChange={(e) => { setWorktree(e.target.checked); if (!e.target.checked) setBranch('') }} />
          <span className="track" aria-hidden="true" />
          <span>
            <b>Its own worktree</b>
            <span>A new branch in its own folder, so it can’t trip over other sessions</span>
          </span>
        </label>
        <label className="launch-name">
          <b>Name</b>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional, e.g. login fix" />
        </label>
      </div>
    </section>
  )
}

/**
 * The focused session: its terminal, under a head with what its tile in the column had (⌘ number,
 * status, name, usage, park), since that tile leaves the column while this is up. A file dropped
 * anywhere on it is pasted into the session, as a terminal does (deck's FocusPane).
 */
export function FocusPane({ session, usage, n }: { session: SessionView; usage: Usage | null; /** Its ⌘ number, if it has one. */ n?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const drop = useFileDrop(session.id)
  useLayoutEffect(() => {
    const host = box.current!
    mount(session.id, host, session.cwd)
    focusTerminal(session.id)
    const ro = new ResizeObserver(() => fit(session.id))
    ro.observe(host)
    return () => {
      ro.disconnect()
      unmount(session.id, host)
    }
  }, [session.id])
  return (
    <section className={`pane focus-pane ${drop.over ? 'file-over' : ''}`} data-session={session.id} {...drop.handlers}>
      <header className="head">
        {n && <span className="key">⌘{n}</span>}
        <Mascot id={session.id} status={session.status} attention={session.attention} />
        <span className="name" title={session.title ?? undefined}>
          {session.name}
          {session.title && session.title !== session.name && <span className="muted"> · {session.title}</span>}
        </span>
        <SessionUsage id={session.id} usage={usage} />
        <span className="session-folder" title={session.cwd}>
          {tilde(session.cwd)}
        </span>
        <ParkButton id={session.id} />
      </header>
      <div className="term-host" ref={box} />
    </section>
  )
}
