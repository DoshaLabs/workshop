// How the Git tile reads a diff, the parts with rules in them: which words of a changed line
// changed (delta's word highlights), a light syntax colouring by file type, and the rows of a
// unified or a side-by-side (split) view. No DOM, so it is tested as shipped (test/git-diff.test.ts).

// ---- syntax: a line at a time, by a small tokenizer per family of languages. Wrong now and then
// (a string that spans lines), never dangerous: the result is text in spans, never HTML.

const KW = {
  js: 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  go: 'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
  rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  sh: 'case do done elif else esac export fi for function if in local readonly return then until while',
  css: 'important inherit initial unset none auto',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual namespace template typename new delete this true false nullptr',
  swift: 'actor as associatedtype async await break case catch class continue default defer do else enum extension false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public return self Self static struct subscript super switch throw throws true try typealias var where while',
  rb: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'
}
const KEYWORDS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' '))]))

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', json: 'json', jsonc: 'json',
  py: 'py', go: 'go', rs: 'rs', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', scss: 'css', less: 'css',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', java: 'c', kt: 'c', cs: 'c', swift: 'swift', rb: 'rb',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  md: 'md', markdown: 'md', yml: 'yaml', yaml: 'yaml', toml: 'yaml'
}

/** The family a file's lines are coloured as, by its name; null draws it plain. */
export function langOf(path) {
  const name = String(path ?? '').split('/').pop().toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return 'sh'
  const ext = name.includes('.') ? name.split('.').pop() : ''
  return EXT[ext] ?? null
}

const LINE_COMMENT = { js: '//', go: '//', rs: '//', c: '//', swift: '//', css: null, py: '#', sh: '#', rb: '#', yaml: '#', json: null, html: null, md: null }

/**
 * One line as [{ s, k }]: k is kw (keyword), str, num, com (comment), fn (a name called), ty (a
 * Capitalised name or a tag), pr (a property or key), or '' (plain). The pieces join back to the line.
 */
export function tokenize(line, lang) {
  if (!lang || line.length > 1000) return [{ s: line, k: '' }]
  if (lang === 'md') return mdLine(line)
  const out = []
  const push = (s, k) => {
    if (!s) return
    const last = out.at(-1)
    if (last && last.k === k) last.s += s
    else out.push({ s, k })
  }
  const kw = KEYWORDS[lang === 'json' || lang === 'html' || lang === 'yaml' ? 'js' : lang] ?? KEYWORDS.js
  const lc = LINE_COMMENT[lang]
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    const rest = line.slice(i)
    if (lc && rest.startsWith(lc) && !(lang === 'sh' && i > 0 && /\S/.test(line[i - 1]))) {
      push(rest, 'com')
      break
    }
    if (rest.startsWith('/*') || (lang === 'html' && rest.startsWith('<!--'))) {
      const end = lang === 'html' && rest.startsWith('<!--') ? rest.indexOf('-->', 4) : rest.indexOf('*/', 2)
      const n = end < 0 ? rest.length : end + (rest.startsWith('<!--') ? 3 : 2)
      push(rest.slice(0, n), 'com')
      i += n
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      const n = Math.min(line.length, j + 1) - i
      // A JSON or YAML key is a property, its value a string.
      const key = (lang === 'json' || lang === 'yaml') && /^\s*:/.test(line.slice(i + n))
      push(line.slice(i, i + n), key ? 'pr' : 'str')
      i += n
      continue
    }
    if (/[0-9]/.test(ch) && !/[\w$]/.test(line[i - 1] ?? '')) {
      const m = /^(0x[0-9a-f_]+|[0-9][0-9_]*(\.[0-9_]+)?(e[+-]?[0-9]+)?n?)/i.exec(rest)
      push(m[0], 'num')
      i += m[0].length
      continue
    }
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[@$]?[A-Za-z_$][\w$-]*/.exec(rest)
      let w = m[0]
      if (lang !== 'css' && lang !== 'html' && w.includes('-')) w = w.split('-')[0]
      const after = line.slice(i + w.length)
      const before = line.slice(0, i)
      let k = ''
      if (kw.has(w)) k = 'kw'
      else if (lang === 'html' && /<\/?$/.test(before)) k = 'ty'
      else if (lang === 'html' && /^=/.test(after)) k = 'pr'
      else if (lang === 'css' && /^\s*:/.test(after) && !/[{}]/.test(after.split(':')[1] ?? '')) k = 'pr'
      else if (lang === 'yaml' && /^\s*:/.test(after) && /^\s*-?\s*$/.test(before)) k = 'pr'
      else if (/^\s*\(/.test(after)) k = 'fn'
      else if (/^[A-Z]/.test(w) && lang !== 'css') k = 'ty'
      else if (/\.\s*$/.test(before) && lang !== 'css') k = 'pr'
      push(w, k)
      i += w.length
      continue
    }
    push(ch, '')
    i++
  }
  return out.length ? out : [{ s: '', k: '' }]
}

function mdLine(line) {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ s: line, k: 'kw' }]
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    const m = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line)
    return [{ s: m[1], k: 'pr' }, { s: m[2], k: '' }].filter((t) => t.s)
  }
  return [{ s: line, k: '' }]
}

// ---- which words changed

/** A line in pieces a word diff compares: runs of word characters, runs of spaces, and each other character. */
export function words(s) {
  return s.match(/[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu) ?? []
}

/** Lines longer than this, or pairs whose pieces multiply past CELLS, are not word-diffed. */
const WORD_LINE = 600
const CELLS = 40_000

/**
 * The ranges [from, to) of characters that differ between an old line and its new one, by the
 * longest common run of pieces; null when they share too little for the marks to help (the line
 * was rewritten: marking all of it says nothing).
 */
export function wordDiff(a, b) {
  if (a.length > WORD_LINE || b.length > WORD_LINE) return null
  const x = words(a)
  const y = words(b)
  if (!x.length || !y.length || x.length * y.length > CELLS) return null
  const n = x.length
  const m = y.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const keepA = new Array(n).fill(false)
  const keepB = new Array(m).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      keepA[i++] = true
      keepB[j++] = true
    } else if (L[i + 1][j] >= L[i][j + 1]) i++
    else j++
  }
  const ranges = (parts, keep) => {
    const out = []
    let at = 0
    parts.forEach((p, k) => {
      if (!keep[k]) {
        const last = out.at(-1)
        if (last && last[1] === at) last[1] = at + p.length
        else out.push([at, at + p.length])
      }
      at += p.length
    })
    return out
  }
  const same = keepA.reduce((s, k, idx) => s + (k ? x[idx].trim().length : 0), 0)
  const total = Math.max(a.trim().length, b.trim().length, 1)
  if (same / total < 0.35) return null
  return { a: ranges(x, keepA), b: ranges(y, keepB) }
}

/**
 * A line's text in segments that carry both its colour and whether it changed:
 * [{ s, k, mark }]. `marks` are [from, to) ranges (from wordDiff), or null.
 */
export function segments(text, lang, marks) {
  const toks = tokenize(text, lang)
  if (!marks || !marks.length) return toks.map((t) => ({ ...t, mark: false }))
  const cuts = new Set([0, text.length])
  for (const [f, t] of marks) {
    cuts.add(f)
    cuts.add(t)
  }
  let at = 0
  for (const t of toks) {
    cuts.add(at)
    at += t.s.length
  }
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((p, q) => p - q)
  const kindAt = (pos) => {
    let a = 0
    for (const t of toks) {
      if (pos < a + t.s.length) return t.k
      a += t.s.length
    }
    return ''
  }
  const marked = (pos) => marks.some(([f, t]) => pos >= f && pos < t)
  const out = []
  for (let p = 0; p < points.length - 1; p++) {
    const s = text.slice(points[p], points[p + 1])
    if (!s) continue
    const k = kindAt(points[p])
    const mark = marked(points[p])
    const last = out.at(-1)
    if (last && last.k === k && last.mark === mark) last.s += s
    else out.push({ s, k, mark })
  }
  return out
}

// ---- rows

/**
 * A hunk's lines numbered and paired: each { t, o, n, s, marks } (t is ' ', '+', '-', '\\'), where a
 * run of removed lines followed by a run of added ones is compared line by line for changed words.
 */
export function lines(hunk) {
  let o = hunk.oldStart
  let n = hunk.newStart
  const rows = hunk.lines.map((line) => {
    const t = line[0] ?? ' '
    const s = line.slice(1)
    if (t === '+') return { t, o: null, n: n++, s, marks: null }
    if (t === '-') return { t, o: o++, n: null, s, marks: null }
    if (t === '\\') return { t, o: null, n: null, s: s.trim(), marks: null }
    return { t: ' ', o: o++, n: n++, s, marks: null }
  })
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== '-') {
      i++
      continue
    }
    let d = i
    while (d < rows.length && rows[d].t === '-') d++
    let a = d
    while (a < rows.length && (rows[a].t === '+' || rows[a].t === '\\')) a++
    const dels = rows.slice(i, d)
    const adds = rows.slice(d, a).filter((r) => r.t === '+')
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const w = wordDiff(dels[k].s, adds[k].s)
      if (w) {
        dels[k].marks = w.a
        adds[k].marks = w.b
      }
    }
    i = Math.max(a, i + 1)
  }
  return rows
}

/**
 * Side by side: [{ left, right }] where each side is a row of `lines(hunk)` or null (the other side
 * has a line there). A removed run sits beside the added run that follows it.
 */
export function splitRows(rows) {
  const out = []
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]
    if (r.t === ' ' || r.t === '\\') {
      out.push({ left: r.t === '\\' ? null : r, right: r })
      i++
      continue
    }
    const dels = []
    const adds = []
    while (i < rows.length && rows[i].t === '-') dels.push(rows[i++])
    while (i < rows.length && rows[i].t === '+') adds.push(rows[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return out
}

/** A file's diff in one short string: when it changes, a "viewed" tick on it no longer holds. */
export function fileSig(f) {
  let h = 2166136261
  const add = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  add(`${f.path}\0${f.status}\0${f.binary}`)
  for (const hk of f.hunks ?? []) for (const l of hk.lines) add(l + '\n')
  return (h >>> 0).toString(36)
}

/** How a hunk's header reads, as the backend checks it before staging or discarding that hunk. */
export const hunkHeader = (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
