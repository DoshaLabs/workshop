// The left column (CLAUDE.md §7): a column of session tiles, each the live conversation, most
// recently active first until the user drags one (⠿ on its head), then in their order, which ⌘1–9
// follow too (shared/sessions.ts shortcutOrder). Every tile is one row of the tile column's height,
// so the two columns line up, as deck's grid does. The focused session's terminal is in the center
// (the only terminal mounted, so the only WebGL context any session holds), and its tile leaves the
// column, as in deck: the center's head carries its ⌘ number, status and park button, and the
// conversation would only repeat the terminal beside it. A + for a new session, then the parked
// sessions as a card at the foot. deck's grid tile (components/Tile.tsx) without slots. A session's
// subagents and helper sessions are one pack tile under it (PackTile.tsx). The leash (⏸ on the
// head) and a permission prompt answered from the tile are Leash.tsx.

import { Mascot } from './Mascot'
import { useEffect, useState } from 'react'
import { useFileDrop } from './drop'
import { MODELS } from '@shared/models'
import { columnOrder, shortcutOrder, type SessionView, type SessionsState } from '@shared/sessions'
import { useReorder } from './reorder'
import type { Usage } from '@shared/usage'
import { ChatView } from './ChatView'
import { Guard } from './Guard'
import { useTranscript } from './transcripts'
import { SessionUsage } from './UsageMeter'
import { PauseButton, SessionAsks } from './Leash'
import { useAgents } from './agents-store'
import { PackTile } from './PackTile'

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
  const pack = useAgents()
  const pick = (s: SessionView): void => {
    onPick()
    void (s.open ? window.core.focusSession(s.id) : window.core.resume(s.id))
  }

  return (
    <aside className="col sessions">
      <div className="session-scroll">
        {open.flatMap((s) => {
          // A session's wolfpack right under it, or where it would be while its terminal is in the center.
          const agents = pack.agents.filter((a) => a.parent === s.id)
          return [
            s.id !== center && <SessionTile key={s.id} s={s} n={keys.get(s.id)} usage={usage} onPick={() => pick(s)} drag={drag} />,
            agents.length > 0 && <PackTile key={`pack:${s.id}`} parent={s} agents={agents} leash={pack.leash} onPick={() => pick(s)} />
          ]
        })}
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
 * A session's tile: its head and the live tail of its conversation. A click opens its terminal in
 * the center, where you type to it. A file dropped on it is pasted into the session, which comes
 * into focus (deck's Tile).
 */
function SessionTile({ s, n, usage, onPick, drag }: { s: SessionView; n?: number; usage: Usage | null; onPick: () => void; drag: Drag }) {
  const t = useTranscript(s.id)
  const title = t?.title ?? s.title
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
        {s.cli === 'codex' && (
          <span className="badge" title="A Codex session">
            codex
          </span>
        )}
        {s.model && (
          <span className="badge" title={`--model ${s.model}`}>
            {s.cli === 'codex' ? s.model : modelLabel(s.model)}
          </span>
        )}
        <SessionUsage id={s.id} usage={usage} />
        {s.cli !== 'codex' && <PauseButton s={s} />}
        <ParkButton id={s.id} />
      </header>
      <div className="session-body">
        <Guard what="This conversation" reset={t}>
          <ChatView id={s.id} status={s.status} attention={s.attention} />
        </Guard>
        <Guard what="This prompt" reset={s.leash}>
          <SessionAsks s={s} where="tile" />
        </Guard>
      </div>
    </article>
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
