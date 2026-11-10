// The left column (CLAUDE.md §7): a column of session tiles, each the live conversation, most
// recently active first until the user drags one (⠿ on its head), then in their order, which ⌘1–9
// follow too (shared/sessions.ts shortcutOrder). Every tile is one row of the tile column's height,
// so the two columns line up, as deck's grid does. The focused session's terminal is in the center
// (the only terminal mounted, so the only WebGL context any session holds), and its tile leaves the
// column, as in deck: the center's head carries its ⌘ number, status and park button, and the
// conversation would only repeat the terminal beside it. A + for a new session, then the parked
// sessions as a card at the foot. deck's grid tile (components/Tile.tsx) without slots, the
// wolfpack or the leash.

import { Mascot } from './Mascot'
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { hasFiles, shellPath, useFileDrop } from './drop'
import { MODELS } from '@shared/models'
import { columnOrder, shortcutOrder, type SessionView, type SessionsState } from '@shared/sessions'
import { useReorder } from './reorder'
import type { Usage } from '@shared/usage'
import { ChatView } from './ChatView'
import { Guard } from './Guard'
import { useTranscript } from './transcripts'
import { SessionUsage } from './UsageMeter'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')
const modelLabel = (m: string): string => MODELS.find((x) => x.id === m)?.label ?? m

/** A ⌘ key for each of the first nine open sessions: in the order they were started, or the user's. */
function keysOf(state: SessionsState | null, order?: string[]): Map<string, number> {
  return new Map(
    shortcutOrder(state, order)
      .slice(0, 9)
      .map((id, i) => [id, i + 1])
  )
}

export function SessionColumn({
  state,
  usage,
  center,
  order,
  onMove,
  onRecent,
  onNew,
  onPick
}: {
  state: SessionsState | null
  usage: Usage | null
  /** The session whose terminal is in the center now, if any: its tile leaves the column. */
  center: string | null
  /** The order the user dragged the column into, or undefined for most recently active first. */
  order?: string[]
  onMove: (key: string, target: string | null, after: boolean) => void
  /** Back to most recently active first. */
  onRecent: () => void
  onNew: () => void
  onPick: () => void
}) {
  const sessions = state?.sessions ?? []
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const open = columnOrder(state, order).map((id) => byId.get(id)!)
  const parked = sessions.filter((s) => !s.open)
  const keys = keysOf(state, order)
  const drag = useReorder('sessions', onMove)
  const pick = (s: SessionView): void => {
    onPick()
    void (s.open ? window.core.focusSession(s.id) : window.core.resume(s.id))
  }

  return (
    <aside className="col sessions">
      <div className="session-scroll">
        {open
          .filter((s) => s.id !== center)
          .map((s) => (
            <SessionTile key={s.id} s={s} n={keys.get(s.id)} usage={usage} onPick={() => pick(s)} drag={drag} />
          ))}
        <button className={`tile tile-plus session-plus ${drag.mark(null)}`} title="New session (⌘N)" onClick={onNew} {...drag.target(null)}>
          +
        </button>
        {order && open.length > 1 && (
          <button className="ghost session-recent" title="Stop keeping your order: most recently active first, and ⌘1–9 in the order sessions were started" onClick={onRecent}>
            most recent first
          </button>
        )}
        {parked.length > 0 && <ParkedCard parked={parked} onPick={pick} />}
      </div>
    </aside>
  )
}

type Drag = ReturnType<typeof useReorder>

export function ParkButton({ id }: { id: string }) {
  return (
    <button
      className="ghost park"
      title="Close (it keeps running in tmux, and waits under Closed)"
      onClick={(e) => {
        e.stopPropagation()
        void window.core.park(id)
      }}
    >
      ×
    </button>
  )
}

/**
 * A session's tile: its head, the live tail of its conversation and a prompt bar. A click opens its
 * terminal in the center. A file dropped on it is pasted into the session, which comes into focus
 * (deck's Tile); one dropped on the prompt bar waits there as a chip instead.
 */
function SessionTile({ s, n, usage, onPick, drag }: { s: SessionView; n?: number; usage: Usage | null; onPick: () => void; drag: Drag }) {
  const t = useTranscript(s.id)
  const title = t?.title ?? s.title
  const addFiles = useRef<((files: File[]) => void) | null>(null)
  const drop = useFileDrop(s.id, onPick, drag.target(s.id))
  return (
    <article
      className={`tile session-tile ${s.attention ? 'attention' : ''} ${drag.mark(s.id)} ${drop.over ? 'file-over' : ''}`}
      data-session={s.id}
      title={n ? `Open the terminal (⌘${n})` : 'Open the terminal'}
      onClick={() => {
        // Selecting text in the conversation must not swap the session into focus on mouse-up.
        if (window.getSelection()?.toString()) return
        onPick()
      }}
      {...drop.handlers}
    >
      <header className="head">
        <span {...drag.grip(s.id, s.name)}>⠿</span>
        {n && <span className="key">⌘{n}</span>}
        <Mascot id={s.id} status={s.status} attention={s.attention} />
        <span className="name" title={tilde(s.cwd)}>
          {s.name}
        </span>
        {title && title !== s.name && (
          <span className="subname" title={title}>
            {title}
          </span>
        )}
        {s.worktree && (
          <span className="badge" title="In a git worktree of its own">
            wt
          </span>
        )}
        {s.model && (
          <span className="badge" title={`--model ${s.model}`}>
            {modelLabel(s.model)}
          </span>
        )}
        <SessionUsage id={s.id} usage={usage} />
        <ParkButton id={s.id} />
      </header>
      <div className="session-body">
        <Guard what="This conversation" reset={t}>
          <ChatView id={s.id} status={s.status} attention={s.attention} cwd={s.cwd} />
        </Guard>
        <TilePrompt id={s.id} addFiles={addFiles} />
      </div>
    </article>
  )
}

/** A picture (or a dropped file) waiting in the prompt bar: the path the session will be sent. */
interface Attached {
  path: string
  name: string
  /** A data: URL to show it by, or '' for a file that is not a picture. */
  thumb: string
}

/** A picture's thumbnail as a data: URL (the window's CSP allows data: images, not blob:). */
const thumbOf = (f: File): Promise<string> =>
  f.type.startsWith('image/')
    ? new Promise((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(typeof r.result === 'string' ? r.result : '')
        r.onerror = () => resolve('')
        r.readAsDataURL(f)
      })
    : Promise.resolve('')


/**
 * The prompt bar along a session tile's foot: type, ⏎, and the text goes into that session and is
 * sent, without bringing it into focus. ⇧⏎ is a new line; Esc empties it. From deck's TilePrompt.
 *
 * A picture pasted into it (or a file dropped anywhere on the tile) waits as a chip with its
 * thumbnail; × takes it off. On ⏎ each one goes in first as its own paste of its path, the way a
 * terminal hands over a dropped file, which the CLI turns into an attached image; then the text.
 * A pasted picture has no file of its own, so main keeps it in the profile's drops/ folder first.
 */
function TilePrompt({ id, addFiles }: { id: string; addFiles: MutableRefObject<((files: File[]) => void) | null> }) {
  const [text, setText] = useState('')
  const [attached, setAttached] = useState<Attached[]>([])
  const [problem, setProblem] = useState('')
  const add = async (files: File[]): Promise<void> => {
    setProblem('')
    for (const f of files) {
      try {
        const path = await window.core.keepDrop(f)
        const thumb = await thumbOf(f)
        setAttached((a) => (a.some((x) => x.path === path) ? a : [...a, { path, name: f.name || path.split('/').pop() || 'image', thumb }]))
      } catch (err) {
        setProblem(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    }
  }
  addFiles.current = (files) => void add(files)
  const send = (): void => {
    const t = text.trim()
    if (!t && attached.length === 0) return
    // Each path its own bracketed paste, a beat apart, then the text, then ⏎.
    const pastes = [...attached.map((a) => shellPath(a.path) + ' '), ...(t ? [t] : [])]
    pastes.forEach((p, i) => window.setTimeout(() => window.core.ptyInput(id, `\x1b[200~${p}\x1b[201~`), i * 40))
    window.setTimeout(() => window.core.ptyInput(id, '\r'), pastes.length * 40)
    setText('')
    setAttached([])
    setProblem('')
  }
  // Clicks in the bar must not reach the tile (which would open the terminal).
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  const ready = !!text.trim() || attached.length > 0
  return (
    <div
      className={`tile-prompt ${text ? 'has-text' : ''}`}
      onClick={stop}
      onMouseDown={stop}
      onDragOver={(e) => {
        if (hasFiles(e.dataTransfer)) e.preventDefault()
      }}
      onDrop={(e) => {
        // A file dropped on the bar is a chip here; the tile (which this bubbles to) sees it taken.
        if (!hasFiles(e.dataTransfer)) return
        e.preventDefault()
        void add(Array.from(e.dataTransfer.files))
      }}
    >
      {(attached.length > 0 || problem) && (
        <div className="prompt-chips">
          {attached.map((a) => (
            <span key={a.path} className="prompt-chip" title={a.path}>
              {a.thumb ? <img src={a.thumb} alt={a.name} /> : <span className="prompt-chip-name">{a.name}</span>}
              <button type="button" title="Take it off" aria-label={`Remove ${a.name}`} onClick={() => setAttached((x) => x.filter((y) => y.path !== a.path))}>
                ×
              </button>
            </span>
          ))}
          {problem && <span className="prompt-problem">{problem}</span>}
        </div>
      )}
      <textarea
        rows={1}
        value={text}
        spellCheck={false}
        placeholder="Reply…"
        aria-label="Prompt this session"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pics = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
          if (pics.length === 0) return
          e.preventDefault()
          void add(pics)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            if (text || attached.length) {
              setText('')
              setAttached([])
            } else e.currentTarget.blur()
          }
        }}
      />
      <button type="button" className="tile-prompt-send" onClick={send} disabled={!ready} title="Send (⏎)">
        ↵
      </button>
    </div>
  )
}

/** Closed sessions: still running in tmux, or resumable with --resume after a reboot. A click brings one back. */
function ParkedCard({ parked, onPick }: { parked: SessionView[]; onPick: (s: SessionView) => void }) {
  const [arm, setArm] = useState<string | null>(null)
  useEffect(() => {
    if (!arm) return
    const t = window.setTimeout(() => setArm(null), 3000)
    return () => window.clearTimeout(t)
  }, [arm])
  return (
    <section className="parked">
      <header className="head">
        <span className="name">Closed</span>
        <span className="muted">{parked.length}</span>
      </header>
      {parked.map((s) => (
        <div key={s.id} className="session" data-session={s.id} title={`${s.title ? `${s.title}\n` : ''}${tilde(s.cwd)}\nClick to bring it back`} onClick={() => onPick(s)}>
          <Mascot id={s.id} status={s.status} attention={s.attention} />
          <span className="session-text">
            <span className="session-name">{s.name}</span>
            <span className="session-folder">{base(s.cwd)}</span>
          </span>
          <button
            className={`ghost ${arm === s.id ? 'armed' : ''}`}
            title={arm === s.id ? 'Click again to end it for good' : 'End this session (its conversation is kept)'}
            onClick={(e) => {
              e.stopPropagation()
              if (arm !== s.id) return setArm(s.id)
              setArm(null)
              void window.core.kill(s.id)
            }}
          >
            {arm === s.id ? 'end' : '⌫'}
          </button>
        </div>
      ))}
    </section>
  )
}
