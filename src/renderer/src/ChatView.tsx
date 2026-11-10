// A session tile's body: the conversation, tailed from Claude Code's transcript by main, instead
// of the CLI's screen. Your prompts in the interface face, Claude's prose as markdown in the
// reading face, a line per tool call in mono. Pinned to the latest: in a tile the wheel belongs to
// the column, and the whole conversation is one click away in the terminal. Carried from deck's
// ChatView, without its fox (the mascot is its own piece). File paths in it (a tool's file, a path
// in a prompt or in Claude's prose) open in the preview pane, resolved against the session's folder.

import { useLayoutEffect, useRef } from 'react'
import type { SessionStatus } from '@shared/sessions'
import type { ChatBlock } from '@shared/transcript'
import { linkPaths } from '@shared/paths'
import { Markdown } from './Markdown'
import { useTranscript } from './transcripts'
import { openDoc } from './preview-store'

type OnPath = (path: string, line: number | null) => void

export function ChatView({ id, status, attention, cwd }: { id: string; status: SessionStatus; attention: boolean; /** The session's folder: relative paths resolve against it. */ cwd: string }) {
  const t = useTranscript(id)
  const box = useRef<HTMLDivElement>(null)
  const blocks = t?.blocks ?? []
  const busy = status === 'busy' || status === 'starting'
  const onPath: OnPath = (path, line) => openDoc({ path, line, cwd })

  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [t, status, attention])

  if (blocks.length === 0)
    return (
      <div className="chat chat-empty">
        <p>{t?.found ? 'Nothing to show yet.' : busy ? 'Starting…' : 'A fresh session. Ask it something below.'}</p>
      </div>
    )

  return (
    <div className="chat" ref={box}>
      {blocks.map((b, i) => (
        <Block key={`${b.ts}-${i}`} b={b} onPath={onPath} />
      ))}
      {busy && (
        <div className="chat-busy" aria-label="Claude is working">
          <span />
          <span />
          <span />
        </div>
      )}
      {(attention || status === 'blocked') && !busy && <div className="chat-attn">{status === 'blocked' ? 'Waiting for you in the terminal. Click to open it.' : 'Your turn. Click to open the terminal.'}</div>}
    </div>
  )
}

/** A click on a path opens the preview pane; it must not also open the session's terminal. */
const pathClick =
  (onPath: OnPath, path: string, line: number | null) =>
  (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    onPath(path, line)
  }

function Block({ b, onPath }: { b: ChatBlock; onPath: OnPath }) {
  if (b.kind === 'user')
    return (
      <div className="chat-user" title={new Date(b.ts).toLocaleTimeString()}>
        {linkPaths(b.text).map((p, i) =>
          p.t === 'text' ? (
            p.v
          ) : (
            <a key={i} className="md-path" href="#" title={`Open ${p.path} in the preview pane`} onClick={pathClick(onPath, p.path, p.line)}>
              {p.v}
            </a>
          )
        )}
      </div>
    )
  if (b.kind === 'tool')
    return (
      <div className={`chat-tool ${b.done ? (b.error ? 'is-error' : 'is-done') : 'is-running'}`} title={b.path ? `${b.path}\nClick to open it in the preview pane` : b.name}>
        <span className="chat-tool-mark">{b.done ? (b.error ? '✗' : '✓') : '·'}</span>
        <span className="chat-tool-name">{b.name}</span>
        {b.label &&
          (b.path ? (
            <a className="chat-tool-label md-path" href="#" onClick={pathClick(onPath, b.path, null)}>
              {b.label}
            </a>
          ) : (
            <span className="chat-tool-label">{b.label}</span>
          ))}
      </div>
    )
  return (
    <div className="chat-text">
      <Markdown text={b.text} onPath={onPath} />
    </div>
  )
}
