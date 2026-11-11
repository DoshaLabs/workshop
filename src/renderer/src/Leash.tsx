// The leash and permission prompts on a session (main/leash.ts; docs/progress/2026-11-11-leash.md):
// the pause button on its heads, and the card that shows what waits on you, at the foot of its tile
// and under the center's head. A permission prompt shows the tool and its input with Allow and
// Deny (a Claude Code session's PermissionRequest hook, or a Codex session's approval request);
// the terminal keeps its own dialog, whichever answers first wins, and the card goes when the
// terminal answered. A held call (the session paused) shows with Resume and Refuse.
//
// The tool call is text: React writes it as text nodes, never HTML, and nothing in it is a link.

import { useEffect, useState } from 'react'
import type { HeldCall, PermissionAsk, ToolCallView } from '@shared/leash'
import type { SessionView } from '@shared/sessions'

const stop = (e: { stopPropagation(): void }): void => e.stopPropagation()

/** ⏸ / ▶ on a session's head: pause its next tool call, or let it go on. */
export function PauseButton({ s }: { s: SessionView }) {
  const paused = s.leash.paused
  return (
    <button
      className={`ghost leash-toggle ${paused ? 'is-paused' : ''}`}
      data-leash={paused ? 'resume' : 'pause'}
      title={paused ? 'Resume: let it go on' : 'Pause: its next tool call waits until you resume'}
      aria-pressed={paused}
      onClick={(e) => {
        stop(e)
        void window.core.leash(s.id, paused ? 'resume' : 'pause')
      }}
    >
      {paused ? '▶' : '⏸'}
    </button>
  )
}

/**
 * ■ on a Codex session's head while a turn runs: Stop, in ⏸'s place (Colin, 11 Nov 2026: Codex
 * cannot hold a call from outside, so the choice was a stop). Two clicks: the first arms it for
 * three seconds. Core interrupts the turn (turn/interrupt), as Esc in the terminal; you carry on
 * by typing there.
 */
export function StopButton({ s }: { s: SessionView }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  const running = s.status === 'busy' || s.status === 'blocked'
  useEffect(() => {
    if (!running) setArmed(false)
  }, [running])
  if (!running) return null
  return (
    <button
      className={`ghost leash-stop ${armed ? 'armed' : ''}`}
      data-leash="stop"
      title={armed ? 'Click again to stop this turn' : 'Stop: interrupt this turn, as Esc in the terminal'}
      onClick={(e) => {
        stop(e)
        if (!armed) return setArmed(true)
        setArmed(false)
        void window.core.leash(s.id, 'stop')
      }}
    >
      {armed ? 'stop' : '■'}
    </button>
  )
}

/** What waits on you in a session: a permission prompt, or a call held by the pause. Nothing otherwise. */
export function SessionAsks({ s, where }: { s: SessionView; where: 'tile' | 'center' }) {
  const { asks, held, paused } = s.leash
  if (asks.length) return <AskCard s={s} ask={asks[0]} more={asks.length - 1} where={where} />
  if (paused) return <PausedCard s={s} held={held} where={where} />
  return null
}

function Call({ c }: { c: ToolCallView }) {
  return (
    <>
      <div className="leash-call">
        <span className="leash-tool">{c.tool}</span>
        {c.label && <span className="leash-label">{c.label}</span>}
      </div>
      {c.body && <pre className="leash-body">{c.body}</pre>}
    </>
  )
}

function AskCard({ s, ask, more, where }: { s: SessionView; ask: PermissionAsk; more: number; where: string }) {
  const [sent, setSent] = useState<string | null>(null)
  const answer = (allow: boolean): void => {
    setSent(ask.id)
    void window.core.answerPermission(s.id, ask.id, allow)
  }
  const busy = sent === ask.id
  return (
    <section className={`leash-card is-ask leash-${where}`} data-ask={ask.id} onClick={stop} role="alertdialog" aria-label={`Permission for ${ask.tool}`}>
      <header className="leash-head">
        <span>Wants to use</span>
        {more > 0 && <span className="muted">and {more} more</span>}
      </header>
      <Call c={ask} />
      <div className="leash-actions">
        {ask.terminal ? (
          <span className="leash-note">Answer in the terminal</span>
        ) : (
          <>
            <button className="leash-btn is-allow" data-answer="allow" disabled={busy} onClick={() => answer(true)}>
              Allow
            </button>
            <button className="leash-btn is-deny" data-answer="deny" disabled={busy} onClick={() => answer(false)}>
              Deny
            </button>
            <span className="leash-note">or answer in the terminal</span>
          </>
        )}
      </div>
    </section>
  )
}

function PausedCard({ s, held, where }: { s: SessionView; held: HeldCall[]; where: string }) {
  const first = held[0]
  return (
    <section className={`leash-card is-paused leash-${where}`} data-paused={s.id} onClick={stop}>
      <header className="leash-head">
        <span>{first ? 'Paused, holding' : 'Paused. Its next tool call waits.'}</span>
        {held.length > 1 && <span className="muted">and {held.length - 1} more</span>}
      </header>
      {first && <Call c={first} />}
      <div className="leash-actions">
        <button className="leash-btn is-allow" data-leash-action="resume" onClick={() => void window.core.leash(s.id, 'resume')}>
          Resume
        </button>
        {first && (
          <button className="leash-btn is-deny" data-leash-action="refuse" title="Refuse this call and stay paused" onClick={() => void window.core.leash(s.id, 'refuse')}>
            Refuse
          </button>
        )}
      </div>
    </section>
  )
}
