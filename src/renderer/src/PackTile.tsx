// A session's wolfpack in the left column: its subagents and helper sessions, as ONE tile right
// under the session's own (where the session would be when its terminal is in the center). One
// row tall, like every tile in the column, so the columns still line up. From deck's PackTile and
// AgentPane, folded into one: the head names the parent (click: its terminal) and the tally; a
// roster of chips, one per agent in the order they started, each its mark in the worker coat and
// its name; under it the chosen agent's live conversation (ChatView, unchanged). The newest one
// still working is chosen until you pick one.
//
// Per agent, on its line: pause / resume (only when the leash is wired, since nothing else can
// hold a tool call), kill (two clicks in place: the first arms it red for three seconds), and ×
// for a finished one, or the last resort for one whose stop never came.

import { useEffect, useState } from 'react'
import { agentKind, agentName, agentStatus, agentTranscriptId, type AgentView } from '@shared/agents'
import type { SessionView } from '@shared/sessions'
import { ChatView } from './ChatView'
import { Guard } from './Guard'
import { Mascot } from './Mascot'
import { useTranscript } from './transcripts'

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])
  return now
}

export function PackTile({ parent, agents, leash, onPick }: { parent: SessionView; agents: AgentView[]; leash: boolean; onPick: () => void }) {
  const [chosen, setChosen] = useState<string | null>(null)
  const running = agents.filter((a) => a.endedAt === null)
  // The one you picked while it is here; else the newest still working; else the newest.
  const a = agents.find((x) => x.id === chosen) ?? running[running.length - 1] ?? agents[agents.length - 1]
  const now = useNow(running.length > 0)
  const done = agents.length - running.length
  const tally = [running.length && `${running.length} working`, done && `${done} done`].filter(Boolean).join(' · ')
  if (!a) return null
  return (
    <article className="tile session-tile pack-tile" data-pack={parent.id} onClick={(e) => e.stopPropagation()}>
      <header className="head">
        <Mascot status={running.length ? 'busy' : 'idle'} coat="worker" />
        <button className="pack-parent" title="Open the session they work for" onClick={onPick}>
          {parent.name}
        </button>
        <span className="subname">{tally}</span>
      </header>
      <div className="pack-roster" role="tablist">
        {agents.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === a.id} className={`pack-chip ${x.id === a.id ? 'is-on' : ''} ${x.endedAt !== null ? 'is-done' : ''}`} data-agent={x.id} title={`${agentName(x)}\n${agentKind(x)}`} onClick={() => setChosen(x.id)}>
            <Mascot status={agentStatus(x)} coat="worker" />
            <span className="pack-chip-name">{agentName(x)}</span>
          </button>
        ))}
      </div>
      <AgentLine a={a} leash={leash} now={now} />
      <div className="session-body">
        <Guard what="This conversation" reset={a.id}>
          <AgentChat a={a} />
        </Guard>
      </div>
    </article>
  )
}

function AgentChat({ a }: { a: AgentView }) {
  const t = useTranscript(agentTranscriptId(a.id))
  const status = agentStatus(a)
  if (!t?.blocks.length && a.lastText) return <div className="chat chat-empty"><p>{a.lastText.slice(0, 300)}</p></div>
  return <ChatView id={agentTranscriptId(a.id)} status={status} attention={false} empty={a.found ? 'Nothing to show yet.' : 'Starting…'} />
}

/** The chosen agent: what it is, how long, and what you can do to it. */
function AgentLine({ a, leash, now }: { a: AgentView; leash: boolean; now: number }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  useEffect(() => setArmed(false), [a.id])
  const finished = a.endedAt !== null
  const act = (p: Promise<void>): void => void p.catch((err: Error) => console.warn('[pack]', err.message))
  return (
    <div className="pack-line" data-agent={a.id}>
      <span className="pack-kind">{agentKind(a)}</span>
      {a.background && <span className="badge" title="Started in the background: the session went on without waiting">bg</span>}
      <span className="pack-state">{finished ? `✓ ${clock(a.endedAt! - a.startedAt)}` : a.held ? 'paused, holding' : a.paused ? 'paused' : clock(now - a.startedAt)}</span>
      {!finished && leash && (
        <button className="ghost pack-pause" title={a.paused ? 'Let it go on' : 'Hold its next tool call until you let it go on'} onClick={() => act(a.paused ? window.core.agents.resume(a.id) : window.core.agents.pause(a.id))}>
          {a.paused ? '▶' : '⏸'}
        </button>
      )}
      {!finished && (
        <button
          className={`ghost pack-kill ${armed ? 'armed' : ''}`}
          title={armed ? 'Click again to stop it' : leash ? 'Stop it: its next tool call is refused, and the session is told' : 'Stop it: the tile goes, and the session is told to stop it'}
          onClick={() => {
            if (!armed) return setArmed(true)
            setArmed(false)
            act(window.core.agents.kill(a.id))
          }}
        >
          {armed ? 'stop' : '✕'}
        </button>
      )}
      <button className="ghost pack-dismiss" title={finished ? 'Clear it' : 'Forget it (if its end never came through)'} onClick={() => act(window.core.agents.dismiss(a.id))}>
        ×
      </button>
    </div>
  )
}
