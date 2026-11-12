// The launcher (the empty center: start a session) and the focus pane (the focused session's
// terminal). The session column is SessionColumn.tsx.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { MODELS, PERMISSION_MODES } from '@shared/models'
import { CODEX_MODES, promptWithFiles, type CliKind } from '@shared/cli'
import type { LaunchPrefill, SessionView } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { fit, focusTerminal, mount, unmount } from './terminals'
import { SessionUsage } from './UsageMeter'
import { Mascot } from './Mascot'
import { KnotCanvas } from './Knot'
import { dropEffectFor, hasFiles, useFileDrop } from './drop'
import { ParkButton } from './SessionColumn'
import { PauseButton, SessionAsks, StopButton } from './Leash'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

/** Codex's model: its own config's until core reads the server's model list (Codex plan, phase 2). */
const CODEX_MODELS = [{ id: '', label: 'Default', hint: 'Your Codex config’s model (`model` in ~/.codex/config.toml), else its own default' }]
/** Each CLI's own default permission mode in the launcher. */
const DEFAULT_MODE: Record<CliKind, string> = { claude: 'auto', codex: '' }

/** A file attached in the launcher: the path main kept (drops.ts), and a small picture if it is one. */
interface Attached {
  path: string
  name: string
  thumb?: string
}

const THUMB_MAX = 8 * 1024 * 1024
/** A data: URL for a picture's chip (the window's CSP takes data: in img, not blob:). */
const thumbOf = (f: File): Promise<string | undefined> =>
  !f.type.startsWith('image/') || f.size > THUMB_MAX
    ? Promise.resolve(undefined)
    : new Promise((done) => {
        const r = new FileReader()
        r.onload = () => done(typeof r.result === 'string' ? r.result : undefined)
        r.onerror = () => done(undefined)
        r.readAsDataURL(f)
      })

export function Launcher({ recent, prefill, onStarted }: { recent: string[]; prefill?: LaunchPrefill; onStarted: () => void }) {
  const [cwd, setCwd] = useState(recent[0] ?? '')
  const [worktree, setWorktree] = useState(false)
  const [cli, setCli] = useState<CliKind>('claude')
  /** Codex is offered only when it is installed: asked each time the launcher opens. */
  const [hasCodex, setHasCodex] = useState(false)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState(DEFAULT_MODE.claude)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<Attached[]>([])
  const [fileOver, setFileOver] = useState(false)
  const dragDepth = useRef(0)
  const filePicker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [typing, setTyping] = useState(recent.length === 0)
  /** The worktree's name a tile asked for (workshop.sessions.launch); cleared when the box is unticked. */
  const [branch, setBranch] = useState('')
  const startButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!cwd && recent[0]) setCwd(recent[0])
  }, [recent, cwd])

  useEffect(() => {
    void window.core.clis().then((c) => setHasCodex(c.codex)).catch(() => setHasCodex(false))
  }, [])

  const pickCli = (next: CliKind): void => {
    if (next === cli) return
    setCli(next)
    setModel('')
    setMode(DEFAULT_MODE[next])
  }

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
      const first = promptWithFiles(codex ? 'codex' : 'claude', prompt, files.map((f) => f.path))
      await window.core.newSession({ ...(cli === 'codex' ? { cli } : {}), cwd, worktree, ...(worktree && branch ? { worktreeName: branch } : {}), model, permissionMode: mode, name, prompt: first })
      setPrompt('')
      setFiles([])
      setName('')
      onStarted()
    } catch (err) {
      setError(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  /** Keeps each file (main/drops.ts: a Finder file's own path, else a copy) and adds it once. */
  const attach = async (list: File[]): Promise<void> => {
    const added: Attached[] = []
    for (const f of list) {
      try {
        const path = await window.core.keepDrop(f)
        added.push({ path, name: base(path), thumb: await thumbOf(f) })
      } catch (err) {
        console.warn('[launcher] not attachable:', f.name, String(err))
      }
    }
    if (added.length) setFiles((was) => [...was, ...added.filter((a) => !was.some((w) => w.path === a.path))])
  }
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current += 1
      setFileOver(true)
    },
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer)
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!hasFiles(e.dataTransfer)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setFileOver(false)
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      dragDepth.current = 0
      setFileOver(false)
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      // The DataTransfer is readable only during the event: take the File objects now.
      void attach(Array.from(e.dataTransfer.files))
    }
  }
  const choose = (): void => void window.core.pickFolder(cwd).then((p) => p && setCwd(p))
  // The recent folders as cards, the chosen one first if it is not among them.
  const cards = recent.slice(0, 6)
  const codex = cli === 'codex' && hasCodex
  const models = codex ? CODEX_MODELS : MODELS
  const modes = codex ? CODEX_MODES : PERMISSION_MODES
  const picked = models.find((m) => m.id === model)
  const perm = modes.find((m) => m.id === mode)

  return (
    <section className="launcher launch">
      <div className="launch-hero">
        <KnotCanvas mode="rest" size={112} className="launch-knot" />
        <h1>What are you working on?</h1>
      </div>

      {hasCodex && (
        <div className="launch-agent">
          <button className={`launch-agent-side${codex ? '' : ' on'}`} onClick={() => pickCli('claude')}>
            Claude Code
          </button>
          <button
            role="switch"
            aria-checked={codex}
            aria-label="Run Codex instead of Claude Code"
            className={`launch-toggle${codex ? ' on' : ''}`}
            onClick={() => pickCli(codex ? 'claude' : 'codex')}
          >
            <span className="knob" aria-hidden="true" />
          </button>
          <button className={`launch-agent-side${codex ? ' on' : ''}`} onClick={() => pickCli('codex')}>
            Codex
          </button>
        </div>
      )}

      <div className={`launch-compose${fileOver ? ' file-over' : ''}`} {...dropHandlers}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(e) => {
            // A picture on the clipboard (a screenshot) is attached, not pasted as text.
            const pasted = Array.from(e.clipboardData.files)
            if (!pasted.length) return
            e.preventDefault()
            void attach(pasted)
          }}
          rows={4}
          autoFocus
          placeholder="Describe the task, or leave this empty and start talking once the session opens. Drop pictures or files here to attach them."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) void start()
          }}
        />
        {files.length > 0 && (
          <ul className="launch-files" aria-label="Attached files">
            {files.map((f) => (
              <li key={f.path} title={f.path}>
                {f.thumb ? <img src={f.thumb} alt="" /> : <span className="launch-file-icon" aria-hidden="true">▤</span>}
                <span className="launch-file-name">{f.name}</span>
                <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((was) => was.filter((w) => w.path !== f.path))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="launch-compose-foot">
          <button className="launch-attach" onClick={() => filePicker.current?.click()} title="Attach files: read in when the session starts">
            + Attach
          </button>
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              e.target.value = ''
              void attach(picked)
            }}
          />
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
          {models.map((m) => (
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
          {modes.map((m) => (
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
        {session.cli === 'codex' ? <StopButton s={session} /> : <PauseButton s={session} />}
        <ParkButton id={session.id} />
      </header>
      <SessionAsks s={session} where="center" />
      <div className="term-host" ref={box} />
    </section>
  )
}
