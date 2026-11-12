// The preview pane's shapes, and the one edit it makes to a file by itself: ticking a task box.
// Main reads and writes (main/preview.ts); this part is pure so it can be tested on its own
// (test/preview.test.ts).

/** What the pane is asked to show: a path, the folder to resolve it against, and a line to mark. */
export interface PreviewRef {
  path: string
  /** The session's folder, when the reference came from its conversation. */
  cwd?: string
  line: number | null
  /** A picture a tile handed the viewer comes with its caption (shared/viewer.ts, bridge 1.9). */
  caption?: import('./viewer').ViewCaption
}

/**
 * A file as main read it for the pane. `kind` says how to draw it: markdown rendered, text in the
 * mono face, or nothing but a polite note (`refused`: a folder, a binary, too large, missing).
 */
export interface PreviewDoc {
  path: string
  name: string
  kind: 'markdown' | 'text' | 'refused'
  /** The text, for markdown and text. */
  text?: string
  /** Why it is not shown, for `refused`. */
  note?: string
  /** Refused because there is nothing at that path. */
  missing?: boolean
  /** Refused as binary, but its first bytes are a picture or a PDF: the lightbox viewer shows it. */
  view?: boolean
  size: number
  /** The modification time read with it: the lock a save or a tick must match. */
  mtime: number
}

export type PreviewWrite = { ok: true; doc: PreviewDoc } | { ok: false; error: string; stale?: boolean }

/** Files bigger than this are not shown (nor edited): a session's notes and code are far smaller. */
export const PREVIEW_MAX = 2 * 1024 * 1024

const MARKDOWN = new Set(['md', 'markdown', 'mdx'])
export const isMarkdownName = (name: string): boolean => MARKDOWN.has(name.toLowerCase().split('.').pop() ?? '')

/** A task item's line: the list marker, then `[ ]` or `[x]`. Group 1 runs up to the mark itself. */
const TASK = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/

/**
 * `text` with the task box on `line` (0-based) flipped, and not one other character changed. The
 * line must still be a task that is `checked` now (the pane ticked what it saw); if it is not,
 * the file changed underneath and the answer is why, as an error.
 */
export function toggleTask(text: string, line: number, checked: boolean): { text: string } | { error: string } {
  if (!Number.isInteger(line) || line < 0) return { error: 'No such line.' }
  let start = 0
  for (let n = 0; n < line; n++) {
    const nl = text.indexOf('\n', start)
    if (nl < 0) return { error: 'That line is not in the file any more.' }
    start = nl + 1
  }
  const nl = text.indexOf('\n', start)
  const row = text.slice(start, nl < 0 ? text.length : nl)
  const m = TASK.exec(row)
  if (!m || (m[2] !== ' ') !== checked) return { error: 'That line is not the task it was. Reload the file.' }
  const at = start + m[1].length
  return { text: text.slice(0, at) + (checked ? ' ' : 'x') + text.slice(at + 1) }
}
