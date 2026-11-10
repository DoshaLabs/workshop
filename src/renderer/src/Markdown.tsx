// Claude's prose as elements (never HTML), from the tree @shared/markdown parses. Links open in the
// browser; task items are drawn, not clickable (the preview pane, when it comes, will write them).

import type { ReactNode } from 'react'
import { parseMarkdown, type Inline, type MdBlock } from '@shared/markdown'

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map(block)}</>
}

function block(b: MdBlock, k: number): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={k}>{inline(b.inl)}</p>
    case 'h': {
      // Tiles are small: a reply's h1 is drawn as an h3.
      const Tag = `h${Math.min(b.level + 2, 6)}` as 'h3'
      return <Tag key={k}>{inline(b.inl)}</Tag>
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
      return <blockquote key={k}>{b.blocks.map(block)}</blockquote>
    case 'table':
      return (
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c)}</td>
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
          {b.items.map((it, j) =>
            it.task === undefined ? (
              <li key={j}>
                {inline(it.inl)}
                {it.kids && block(it.kids, 0)}
              </li>
            ) : (
              <li key={j} className={it.task ? 'md-task done' : 'md-task'}>
                <input type="checkbox" checked={it.task} disabled readOnly />
                <span className="md-task-text">{inline(it.inl)}</span>
                {it.kids && block(it.kids, 0)}
              </li>
            )
          )}
        </Tag>
      )
    }
  }
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text':
        return n.v
      case 'code':
        return <code key={k}>{n.v}</code>
      case 'b':
        return <strong key={k}>{inline(n.kids)}</strong>
      case 'i':
        return <em key={k}>{inline(n.kids)}</em>
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
            {inline(n.kids)}
          </a>
        )
    }
  })
}
