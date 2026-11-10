// The left column (CLAUDE.md §7): a column of session tiles, each the live conversation, most
// recently active first. The focused session's terminal is in the center (the only terminal
// mounted, so the only WebGL context any session holds), and its tile gives way to a slim line
// saying so. A + for a new session, then the parked sessions as a card at the foot. deck's grid
// tile (components/Tile.tsx) without slots, the wolfpack or the leash.

import { Mascot } from './Mascot'
import { useEffect, useState } from 'react'
import { MODELS } from '@shared/models'
import { shortcutOrder, type SessionView, type SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { ChatView } from './ChatView'
import { Guard } from './Guard'
import { useTranscript } from './transcripts'
import { SessionUsage } from './UsageMeter'

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')
const modelLabel = (m: string): string => MODELS.find((x) => x.id === m)?.label ?? m

/** A ⌘ key for each of the first nine open sessions, in the order they were started. */
function keysOf(state: SessionsState | null): Map<string, number> {
  return new Map(
    shortcutOrder(state)
      .slice(0, 9)
      .map((id, i) => [id, i + 1])
  )
}

export function SessionColumn({
  state,
  usage,
  center,
  onNew,
  onPick
}: {
  state: SessionsState | null
  usage: Usage | null
  /** The session whose terminal is in the center now, if any: its tile gives way. */
  center: string | null
  onNew: () => void
  onPick: () => void
}) {
  const sessions = state?.sessions ?? []
  const open = sessions.filter((s) => s.open)
  const parked = sessions.filter((s) => !s.open)
  const keys = keysOf(state)
  const pick = (s: SessionView): void => {
    onPick()
    void (s.open ? window.core.focusSession(s.id) : window.core.resume(s.id))
  }

  return (
    <aside className="col sessions">
      <div className="session-scroll">
        {open.map((s) =>
          s.id === center ? (
            <CenterLine key={s.id} s={s} n={keys.get(s.id)} usage={usage} />
          ) : (
            <SessionTile key={s.id} s={s} n={keys.get(s.id)} usage={usage} onPick={() => pick(s)} />
          )
        )}
        <button className="tile tile-plus session-plus" title="New session (⌘N)" onClick={onNew}>
          +
        </button>
        {parked.length > 0 && <ParkedCard parked={parked} onPick={pick} />}
      </div>
    </aside>
  )
}

/** The focused session, while its terminal is in the center: a line, so the column still says where it is. */
function CenterLine({ s, n, usage }: { s: SessionView; n?: number; usage: Usage | null }) {
  return (
    <div className={`session-center ${s.attention ? 'attention' : ''}`} data-session={s.id} title={tilde(s.cwd)}>
      <header className="head">
        {n && <span className="key">⌘{n}</span>}
        <Mascot id={s.id} status={s.status} attention={s.attention} />
        <span className="name">{s.name}</span>
        <SessionUsage id={s.id} usage={usage} />
        <span className="muted">in the center</span>
        <ParkButton id={s.id} />
      </header>
    </div>
  )
}

function ParkButton({ id }: { id: string }) {
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

/** A session's tile: its head, its conversation and a prompt bar. A click opens its terminal in the center. */
function SessionTile({ s, n, usage, onPick }: { s: SessionView; n?: number; usage: Usage | null; onPick: () => void }) {
  const t = useTranscript(s.id)
  const title = t?.title ?? s.title
  return (
    <article
      className={`tile session-tile ${s.attention ? 'attention' : ''}`}
      data-session={s.id}
      title={n ? `Open the terminal (⌘${n})` : 'Open the terminal'}
      onClick={() => {
        // Selecting text in the conversation must not swap the session into focus on mouse-up.
        if (window.getSelection()?.toString()) return
        onPick()
      }}
    >
      <header className="head">
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
          <ChatView id={s.id} status={s.status} attention={s.attention} />
        </Guard>
        <TilePrompt id={s.id} />
      </div>
    </article>
  )
}

/**
 * The prompt bar along a session tile's foot: type, ⏎, and the text goes into that session and is
 * sent, without bringing it into focus. ⇧⏎ is a new line; Esc empties it. From deck's TilePrompt.
 */
function TilePrompt({ id }: { id: string }) {
  const [text, setText] = useState('')
  const send = (): void => {
    const t = text.trim()
    if (!t) return
    // Bracketed paste lands first, so a newline in it is not a ⏎; the ⏎ follows a beat later.
    window.core.ptyInput(id, `\x1b[200~${t}\x1b[201~`)
    window.setTimeout(() => window.core.ptyInput(id, '\r'), 40)
    setText('')
  }
  // Clicks in the bar must not reach the tile (which would open the terminal).
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <div className={`tile-prompt ${text ? 'has-text' : ''}`} onClick={stop} onMouseDown={stop}>
      <textarea
        rows={1}
        value={text}
        spellCheck={false}
        placeholder="Reply…"
        aria-label="Prompt this session"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            if (text) setText('')
            else e.currentTarget.blur()
          }
        }}
      />
      <button type="button" className="tile-prompt-send" onClick={send} disabled={!text.trim()} title="Send (⏎)">
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
        </div>
      ))}
    </section>
  )
}
