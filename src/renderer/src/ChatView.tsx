// A session tile's body: the conversation, tailed from Claude Code's transcript by main, instead
// of the CLI's screen. Your prompts in the interface face, Claude's prose as markdown in the
// reading face, a line per tool call in mono. Pinned to the latest while you leave it there; scroll
// up for history and it stays put until you come back down (deck's ChatView). Carried from deck's
// ChatView, without its fox (the mascot is its own piece). Nothing in it is a link (Colin, 11 Nov
// 2026): web links, file paths and pictures are text, and a click anywhere opens the session.

import { useLayoutEffect, useRef } from 'react'
import type { SessionStatus } from '@shared/sessions'
import type { ChatBlock } from '@shared/transcript'
import { Markdown } from './Markdown'
import { useTranscript } from './transcripts'

export function ChatView({ id, status, attention, empty }: { id: string; status: SessionStatus; attention: boolean; /** What an empty conversation says (a subagent's has nothing to ask). */ empty?: string }) {
  const t = useTranscript(id)
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const blocks = t?.blocks ?? []
  const busy = status === 'busy' || status === 'starting'

  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [t, status, attention])
  const onScroll = (): void => {
    const el = box.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  if (blocks.length === 0)
    return (
      <div className="chat chat-empty">
        <p>{empty ?? (t?.found ? 'Nothing to show yet.' : busy ? 'Starting…' : 'A fresh session. Ask it something below.')}</p>
      </div>
    )

  return (
    <div className="chat" ref={box} onScroll={onScroll}>
      {blocks.map((b, i) => (
        <Block key={`${b.ts}-${i}`} b={b} />
      ))}
      {busy && (
        <div className="chat-busy" aria-label="Working">
          <span />
          <span />
          <span />
        </div>
      )}
      {(attention || status === 'blocked') && !busy && <div className="chat-attn">{status === 'blocked' ? 'Waiting for you in the terminal. Click to open it.' : 'Your turn. Click to open the terminal.'}</div>}
    </div>
  )
}

function Block({ b }: { b: ChatBlock }) {
  if (b.kind === 'user')
    return (
      <div className="chat-user" title={new Date(b.ts).toLocaleTimeString()}>
        {b.text}
      </div>
    )
  if (b.kind === 'tool')
    return (
      <div className={`chat-tool ${b.done ? (b.error ? 'is-error' : 'is-done') : 'is-running'}`} title={b.path ?? b.name}>
        <span className="chat-tool-mark">{b.done ? (b.error ? '✗' : '✓') : '·'}</span>
        <span className="chat-tool-name">{b.name}</span>
        {b.label && <span className="chat-tool-label">{b.label}</span>}
      </div>
    )
  return (
    <div className="chat-text">
      <Markdown text={b.text} links={false} />
    </div>
  )
}
