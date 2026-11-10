// Finding file references in a conversation, so a path Claude wrote (or a tool touched) opens in
// the preview pane with a click. Carried from deck's lib/paths.ts. A reference may be absolute,
// ~-rooted, explicitly relative, relative to the session's folder, or a bare name with a telling
// extension, and may carry a `:42`. Resolving it and whether it exists are main's business
// (main/preview.ts); a wrong guess opens the pane on "no such file".
//
// deck linked every match in prose. That turns "Node.js" or "e.g. index.ts" in a sentence into a
// link that leads nowhere, so here a reference in running text is linked only when it is clearly
// a path (it has a slash in it); inside an inline code span, any reference is.

/** Extensions that make a bare name a file reference ("package.json", "index.ts"). */
const EXT = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'ndjson', 'md', 'markdown', 'mdx', 'txt', 'text', 'log',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svelte', 'vue', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'sh', 'zsh', 'bash', 'fish', 'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm',
  'cs', 'php', 'pl', 'lua', 'sql', 'csv', 'tsv', 'diff', 'patch', 'lock', 'plist', 'ipynb', 'r', 'jl', 'gradle', 'mk'
].join('|')

// Three shapes, tried in order: something rooted at / ~/ ./ ../ ; a name (nested or not) ending in
// a known extension; a folder written with a trailing slash. The lookbehind keeps a match from
// starting inside a word or after a colon, so "https://x/y.ts" stays a URL, and the last group
// takes the line number off "index.ts:42".
const REF = new RegExp(
  String.raw`(?<![\w@./~:-])(?:` +
    String.raw`(?:~|\.{1,2})?\/[A-Za-z0-9._~@+\-/]*[A-Za-z0-9_~@+]` +
    '|' +
    String.raw`[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\.(?:${EXT})` +
    '|' +
    String.raw`[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/` +
    String.raw`)(?::(\d+))?(?![\w/])`,
  'g'
)

export interface PathRef {
  /** The path as written, without the `:42`. */
  path: string
  /** The line it pointed at, or null. */
  line: number | null
  /** The reference as it appears in the text, `:42` included. */
  raw: string
  start: number
  end: number
}

/** Every file reference in `text`, in order. */
export function pathRefs(text: string): PathRef[] {
  const out: PathRef[] = []
  for (const m of text.matchAll(REF)) {
    const raw = m[0]
    const line = m[1] ? Number(m[1]) : null
    const path = line === null ? raw : raw.slice(0, raw.length - m[1].length - 1)
    if (path.length < 2 || path === '..' || path === './' || path === '//') continue
    out.push({ path, line, raw, start: m.index ?? 0, end: (m.index ?? 0) + raw.length })
  }
  return out
}

/** True when the whole string is one file reference (an inline code span, a tool line's label). */
export function isPathRef(text: string): boolean {
  const t = text.trim()
  if (!t || /\s/.test(t)) return false
  const refs = pathRefs(t)
  return refs.length === 1 && refs[0].raw === t
}

/** Split a reference into the path and the line it points at (`a.ts:12` or `a.ts:12:5`). */
export function splitRef(ref: string): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(ref.trim())
  return m ? { path: m[1], line: Number(m[2]) } : { path: ref.trim(), line: null }
}

/** A piece of running text: plain, or a reference worth a link. */
export type TextPiece = { t: 'text'; v: string } | { t: 'path'; v: string; path: string; line: number | null }

/**
 * Running text cut into plain pieces and links. Only references with a slash in them are linked
 * here (`src/main/index.ts`, `~/notes.md`, `/etc/hosts`); a bare `index.ts` in a sentence stays
 * text, since prose is full of words like "Node.js".
 */
export function linkPaths(text: string): TextPiece[] {
  const out: TextPiece[] = []
  let last = 0
  for (const r of pathRefs(text)) {
    if (!r.path.includes('/') || /^\/+$/.test(r.path)) continue
    if (r.start > last) out.push({ t: 'text', v: text.slice(last, r.start) })
    out.push({ t: 'path', v: r.raw, path: r.path, line: r.line })
    last = r.end
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}
