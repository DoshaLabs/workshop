// A small markdown parser for Claude's prose in session tiles: paragraphs, headings, bullet and
// numbered lists (nested; `- [ ]` / `- [x]` task items), fenced code, pipe tables, quotes, rules,
// and inline code, bold, italic and links. It builds a tree that the window turns into elements
// (renderer/src/Markdown.tsx), never HTML, so nothing in a reply can inject markup. Carried from
// deck's lib/markdown.tsx, split so the parsing is pure and tested (test/markdown.test.ts); deck's
// clickable file references wait for the preview pane.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; kids: Inline[] }
  | { t: 'i'; kids: Inline[] }
  | { t: 'a'; href: string; kids: Inline[] }

export interface ListItem {
  inl: Inline[]
  /** A task item: done or not. Undefined for a plain item. */
  task?: boolean
  kids: MdBlock | null
}

export type MdBlock =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; level: number; inl: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; blocks: MdBlock[] }

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TASK_ITEM = /^\[([ xX])\](?:\s+(.*))?$/

interface RawItem {
  indent: number
  ordered: boolean
  text: string
  kids: RawItem[]
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split(/\r?\n/)
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = /^\s*(```+|~~~+)\s*(\S*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      out.push({ t: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ t: 'h', level: h[1].length, inl: parseInline(h[2]) })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => parseInline(c.trim()))
      const head = cells(line)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push({ t: 'table', head, rows })
      continue
    }
    if (LIST_ITEM.test(line)) {
      const roots: RawItem[] = []
      const open: RawItem[] = []
      let last: RawItem | null = null
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (m) {
          const item: RawItem = { indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3], kids: [] }
          while (open.length && open[open.length - 1].indent >= item.indent) open.pop()
          ;(open.length ? open[open.length - 1].kids : roots).push(item)
          open.push(item)
          last = item
        } else if (/^\s{2,}\S/.test(lines[i]) && last) last.text += ' ' + lines[i].trim()
        else break
        i++
      }
      out.push(list(roots))
      continue
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ t: 'quote', blocks: parseMarkdown(q.join('\n')) })
      continue
    }
    const p: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|))/.test(lines[i])) p.push(lines[i++])
    out.push({ t: 'p', inl: parseInline(p.join(' ')) })
  }
  return out
}

function list(items: RawItem[]): MdBlock {
  return {
    t: 'list',
    ordered: !!items[0]?.ordered,
    items: items.map((it) => {
      const task = TASK_ITEM.exec(it.text)
      const kids = it.kids.length ? list(it.kids) : null
      return task ? { inl: parseInline(task[2] ?? ''), task: task[1] !== ' ', kids } : { inl: parseInline(it.text), kids }
    })
  }
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2] })
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'b', kids: parseInline(m[3] ?? m[4]) })
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: 'i', kids: parseInline(m[5] ?? m[6]) })
    else if (m[7] !== undefined) out.push({ t: 'a', href: m[8], kids: parseInline(m[7]) })
    else if (m[9] !== undefined) out.push({ t: 'a', href: m[9], kids: [{ t: 'text', v: m[9] }] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}
