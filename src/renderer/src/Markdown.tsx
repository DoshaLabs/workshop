// Markdown as elements (never HTML), from the tree @shared/markdown parses. Links open in the
// browser. Two things are optional, for whoever draws it:
// - `onPath`: file references become links that open in the preview pane (a session's
//   conversation passes it; shared/paths.ts says what counts as one).
// - `onTask`: task boxes are clickable and report their source line (the preview pane writes the
//   tick to disk). Without it they are drawn, not clickable.

import type { ReactNode } from 'react'
import { parseMarkdown, type Inline, type MdBlock } from '@shared/markdown'
import { isPathRef, linkPaths, splitRef } from '@shared/paths'

export interface MdHandlers {
  onPath?: (path: string, line: number | null) => void
  onTask?: (line: number, checked: boolean) => void
}

export function Markdown({ text, onPath, onTask, big = false }: MdHandlers & { text: string; /** Headings at their own size (the preview pane), not shrunk for a tile. */ big?: boolean }) {
  const h: Ctx = { onPath, onTask, big }
  return <>{parseMarkdown(text).map((b, k) => block(b, k, h))}</>
}

type Ctx = MdHandlers & { big: boolean }

function block(b: MdBlock, k: number, h: Ctx): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={k}>{inline(b.inl, h)}</p>
    case 'h': {
      // Tiles are small: a reply's h1 is drawn as an h3.
      const Tag = `h${Math.min(b.level + (h.big ? 0 : 2), 6)}` as 'h3'
      return <Tag key={k}>{inline(b.inl, h)}</Tag>
    }
    case 'code':
      return (
        <pre key={k} className="md-code" data-lang={b.lang || undefined}>
          <code>{b.text}</code>
        </pre>
      )
    case 'hr':
      return <hr key={k} />
    case 'quote':
      return <blockquote key={k}>{b.blocks.map((x, j) => block(x, j, h))}</blockquote>
    case 'table':
      return (
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c, h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, h)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      const tasks = b.items.some((i) => i.task !== undefined)
      return (
        <Tag key={k} className={tasks ? 'md-tasks' : undefined}>
          {b.items.map((it, j) => {
            if (it.task === undefined)
              return (
                <li key={j}>
                  {inline(it.inl, h)}
                  {it.kids && block(it.kids, 0, h)}
                </li>
              )
            const live = !!h.onTask && it.line !== undefined
            return (
              <li key={j} className={it.task ? 'md-task done' : 'md-task'} data-line={it.line}>
                <input
                  type="checkbox"
                  checked={it.task}
                  disabled={!live}
                  readOnly={!live}
                  title={live ? (it.task ? 'Untick (saves to the file)' : 'Tick (saves to the file)') : undefined}
                  onChange={live ? () => h.onTask!(it.line!, it.task!) : undefined}
                />
                <span className="md-task-text">{inline(it.inl, h)}</span>
                {it.kids && block(it.kids, 0, h)}
              </li>
            )
          })}
        </Tag>
      )
    }
  }
}

/** A file reference as a link to the preview pane. */
function PathLink({ text, path, line, h, code = false }: { text: string; path: string; line: number | null; h: Ctx; code?: boolean }) {
  return (
    <a
      className={`md-path ${code ? 'is-code' : ''}`}
      href="#"
      title={`Open ${path}${line ? ` at line ${line}` : ''} in the preview pane`}
      onClick={(e) => {
        // The click must not open the session's terminal (the tile's own click).
        e.preventDefault()
        e.stopPropagation()
        h.onPath!(path, line)
      }}
    >
      {code ? <code>{text}</code> : text}
    </a>
  )
}

function inline(nodes: Inline[], h: Ctx): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text':
        if (!h.onPath) return n.v
        return linkPaths(n.v).map((p, j) => (p.t === 'text' ? p.v : <PathLink key={`${k}.${j}`} text={p.v} path={p.path} line={p.line} h={h} />))
      case 'code':
        if (h.onPath && isPathRef(n.v)) {
          const r = splitRef(n.v)
          return <PathLink key={k} text={n.v} path={r.path} line={r.line} h={h} code />
        }
        return <code key={k}>{n.v}</code>
      case 'b':
        return <strong key={k}>{inline(n.kids, h)}</strong>
      case 'i':
        return <em key={k}>{inline(n.kids, h)}</em>
      case 'a':
        return (
          <a
            key={k}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              // Never navigate core's window; the click must not focus the tile either.
              e.preventDefault()
              e.stopPropagation()
              void window.core.openExternal(n.href)
            }}
          >
            {inline(n.kids, h)}
          </a>
        )
    }
  })
}
