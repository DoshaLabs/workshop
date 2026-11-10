// The Git tile's backend, the part that reads git's output: no process, no file system, so every
// rule here is tested as shipped (test/git-parse.test.ts). git.mjs runs git and hands its output
// here; backend.mjs answers the page. The page only ever gets what these functions return, never
// git's text and never HTML.

/** Diff lines kept per file before the rest is cut and counted. */
export const FILE_LINES = 1500
/** Diff lines kept for one worktree in all; files past it are named, with their hunks left out. */
export const TOTAL_LINES = 8000
/** A diff line longer than this is cut (a minified bundle is one line). */
export const LINE_CHARS = 2000

/**
 * A path git wrote C-quoted ("a\tb", "caf\303\251") back to itself. core.quotepath=off keeps
 * non-ASCII as is, but a quote, a backslash or a control character is still escaped in diff headers.
 */
export function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s
  const body = s.slice(1, -1)
  const bytes = []
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b)
      continue
    }
    const n = body[++i]
    if (n in ESC) bytes.push(ESC[n])
    else if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else if (n !== undefined) for (const b of Buffer.from(n, 'utf8')) bytes.push(b)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** What happened to a path, from a porcelain v2 XY pair: the more drastic thing wins. */
export function kindOf(x, y) {
  if (x === 'R') return 'renamed'
  if (x === 'C') return 'copied'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/** Splits `n` space-separated fields off the front; the rest (a path, spaces and all) is last. */
function fields(entry, n) {
  const out = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const sp = entry.indexOf(' ', at)
    if (sp < 0) return null
    out.push(entry.slice(at, sp))
    at = sp + 1
  }
  out.push(entry.slice(at))
  return out
}

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all`: the branch, and one entry per
 * path that differs from HEAD in the index or the working tree, untracked files included and
 * ignored ones left out. `cut` says the output was cut short (a huge untracked tree): the last,
 * partial entry is dropped and `more` set.
 */
export function parseStatus(z, cut = false) {
  const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0 }
  const files = []
  const tok = z.split('\0')
  if (cut || tok.at(-1) !== '') tok.pop()
  for (let i = 0; i < tok.length; i++) {
    const e = tok[i]
    if (!e) continue
    if (e.startsWith('# ')) {
      const [key, ...rest] = e.slice(2).split(' ')
      const v = rest.join(' ')
      if (key === 'branch.oid') branch.oid = v === '(initial)' ? null : v
      else if (key === 'branch.head') branch.head = v === '(detached)' ? null : v
      else if (key === 'branch.upstream') branch.upstream = v
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(v)
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    const t = e[0]
    if (t === '?') files.push({ path: e.slice(2), kind: 'untracked', staged: false, unstaged: true })
    else if (t === '1' || t === '2' || t === 'u') {
      const f = fields(e, t === '1' ? 8 : t === '2' ? 9 : 10)
      if (!f) continue
      const [x, y] = f[1]
      const file = { path: f.at(-1), kind: t === 'u' ? 'conflict' : kindOf(x, y), staged: x !== '.', unstaged: y !== '.' }
      if (f[2].startsWith('S')) file.submodule = true
      // A rename or copy carries where it came from as the next token.
      if (t === '2') file.from = tok[++i] ?? ''
      files.push(file)
    }
    // '!' (ignored) is never asked for.
  }
  return { branch, files, more: cut }
}

/** `git worktree list --porcelain -z`: the folder of every worktree of the repository. */
export function parseWorktrees(z) {
  return z
    .split('\0')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))
}

/**
 * git lists a repository nested in the tree as one untracked folder (`path/`). When that folder
 * is another worktree of the same repository (Claude's `.claude/worktrees/<name>`), it is that
 * worktree's own line, not a change here: it is dropped.
 */
export function dropWorktrees(files, top, worktrees) {
  const set = new Set(worktrees.map((w) => w.replace(/\/+$/, '')))
  return files.filter((f) => !(f.kind === 'untracked' && f.path.endsWith('/') && set.has(`${top.replace(/\/+$/, '')}/${f.path.replace(/\/+$/, '')}`)))
}

/**
 * `git diff <base> --numstat -z -M`: added and deleted lines by path (the new path for a rename).
 * A binary file is `-\t-` and reads as `binary: true` with no counts.
 */
export function parseNumstat(z) {
  const map = new Map()
  const tok = z.split('\0')
  for (let i = 0; i < tok.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok[i])
    if (!m) continue
    let path = m[3]
    // A rename is `a\td\t` then the old path, then the new one.
    if (path === '') {
      i++
      path = tok[++i] ?? ''
    }
    const binary = m[1] === '-' && m[2] === '-'
    map.set(path, { add: binary ? null : Number(m[1]), del: binary ? null : Number(m[2]), binary })
  }
  return map
}

/**
 * How an untracked file is counted: every line is an added line (a last line without a newline
 * counts), as `git diff --no-index /dev/null file` would say. A NUL in its first 8000 bytes makes
 * it binary, git's own test, with no count.
 */
export function countLines(buf) {
  if (buf.subarray(0, 8000).includes(0)) return { add: null, del: null, binary: true }
  let lines = 0
  for (const b of buf) if (b === 10) lines++
  if (buf.length && buf[buf.length - 1] !== 10) lines++
  return { add: lines, del: 0, binary: false }
}

/**
 * One worktree's changes as the page shows them: the status entries with their counts. Untracked
 * files get theirs from `untracked` (path -> countLines result, or nothing when they were not read).
 */
export function summarize(status, numstat, untracked = new Map()) {
  let add = 0
  let del = 0
  const files = status.files.map((f) => {
    const c = f.kind === 'untracked' ? untracked.get(f.path) : numstat.get(f.path)
    const out = { ...f, add: c?.add ?? null, del: c?.del ?? null, binary: c?.binary ?? false }
    add += out.add ?? 0
    del += out.del ?? 0
    return out
  })
  return { branch: status.branch, files, count: files.length, add, del, more: status.more }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** `a/x b/x` from a `diff --git` line when no other line names the file (a binary or mode-only change). */
function namesFromHeader(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest)
    if (m) return [strip(unquote(m[1])), strip(unquote(m[2]))]
  }
  // Unquoted, the two halves are the same path when nothing was renamed: `a/P b/P`.
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = strip(rest.slice(0, half))
    const b = strip(rest.slice(half + 1))
    if (a === b) return [a, b]
  }
  const sp = rest.indexOf(' b/')
  return sp < 0 ? [null, null] : [strip(rest.slice(0, sp)), strip(rest.slice(sp + 1))]
}
function strip(p) {
  if (p === '/dev/null') return null
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p
}

/**
 * A unified diff (`git diff --src-prefix=a/ --dst-prefix=b/`, any number of files) as files of
 * hunks. A line is kept as git wrote it, its first character saying what it is (' ', '+', '-',
 * '\\' for "no newline at end of file"). A hunk is read by its line counts, so a removed line that
 * reads "--- x" stays a line. Past FILE_LINES in a file or TOTAL_LINES in all, the rest is not
 * kept and `cut` says how many lines were left out; `cut` on the input (git's output was cut
 * short) marks the last file truncated too.
 */
export function parseDiff(text, { cut = false, fileLines = FILE_LINES, totalLines = TOTAL_LINES } = {}) {
  const files = []
  let file = null
  let hunk = null
  let oldLeft = 0
  let newLeft = 0
  let total = 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const keep = (line) => {
    if (file.kept >= fileLines || total >= totalLines) {
      file.cut++
      return
    }
    file.kept++
    total++
    hunk.lines.push(line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line)
  }
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith('\\'))) {
      const c = line[0]
      if (c === '\\') {
        keep(line)
        continue
      }
      // Some tools strip the space off an empty context line.
      if (c === ' ' || line === '') (oldLeft--, newLeft--)
      else if (c === '-') oldLeft--
      else if (c === '+') newLeft--
      else hunk = null
      if (hunk) {
        keep(line === '' ? ' ' : line)
        continue
      }
    }
    if (line.startsWith('diff --git ')) {
      const [a, b] = namesFromHeader(line.slice(11))
      file = { path: b ?? a ?? '', from: null, status: 'modified', binary: false, hunks: [], kept: 0, cut: 0 }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    const m = HUNK.exec(line)
    if (m) {
      const [, os, ol, ns, nl, section] = m
      oldLeft = ol === undefined ? 1 : Number(ol)
      newLeft = nl === undefined ? 1 : Number(nl)
      hunk = { oldStart: Number(os), oldLines: oldLeft, newStart: Number(ns), newLines: newLeft, section, lines: [] }
      // Past a cap the hunk is still read (keep counts its lines as cut) but not kept.
      if (file.kept < fileLines && total < totalLines) file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) (file.from = unquote(line.slice(12)), (file.status = 'renamed'))
    else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
    else if (line.startsWith('copy from ')) (file.from = unquote(line.slice(10)), (file.status = 'copied'))
    else if (line.startsWith('copy to ')) file.path = unquote(line.slice(8))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
    else if (line.startsWith('+++ ')) {
      const p = strip(unquote(line.slice(4)))
      if (p) file.path = p
    } else if (line.startsWith('--- ')) {
      const p = strip(unquote(line.slice(4)))
      if (p && file.status !== 'renamed' && file.status !== 'copied' && !file.path) file.path = p
    }
  }
  // A hunk whose lines were cut from the end because git's output was cut short.
  if (cut && files.length) files.at(-1).cut += Math.max(0, oldLeft) + Math.max(0, newLeft) || 1
  return files.map(({ kept, cut: n, ...f }) => ({ ...f, truncated: n > 0, cutLines: n }))
}

/**
 * An untracked file as a diff: one hunk of added lines, read from its bytes (`countLines`'s rules).
 * `cut` says the bytes were cut at a size cap, so the hunk is marked truncated.
 */
export function untrackedDiff(path, buf, { cut = false, fileLines = FILE_LINES } = {}) {
  const c = countLines(buf)
  if (c.binary) return { path, from: null, status: 'untracked', binary: true, hunks: [], truncated: false, cutLines: 0 }
  const text = buf.toString('utf8')
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  const kept = all.slice(0, fileLines).map((l) => `+${l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l}`)
  if (text.length && !text.endsWith('\n') && kept.length === all.length) kept.push('\\ No newline at end of file')
  const left = all.length - Math.min(all.length, fileLines)
  const hunks = all.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: all.length, section: '', lines: kept }] : []
  return { path, from: null, status: 'untracked', binary: false, hunks, truncated: cut || left > 0, cutLines: left }
}

const base = (p) => p.replace(/\/+$/, '').split('/').pop() || p

/**
 * The Changes tab's shape: sessions grouped by project (the root core gives each session: every
 * worktree of one repository shares it), then by worktree, so sessions in one working tree share
 * one line and one set of changes. `places` maps a session id to its worktree's top folder (null:
 * not in a repository); `changes` maps a top folder to its summary or `{ error }`. Sessions keep
 * the order given; projects are by name, and a project's main worktree comes first.
 */
export function group(sessions, places, changes) {
  const projects = new Map()
  for (const s of sessions) {
    let p = projects.get(s.root)
    if (!p) projects.set(s.root, (p = { root: s.root, name: base(s.root), worktrees: [], outside: [] }))
    const top = places.get(s.id) ?? null
    if (!top) {
      p.outside.push({ id: s.id, name: s.name, folder: s.folder })
      continue
    }
    let w = p.worktrees.find((x) => x.top === top)
    if (!w) p.worktrees.push((w = { top, main: top === s.root, name: base(top), sessions: [], ...(changes.get(top) ?? { error: 'not read' }) }))
    w.sessions.push({ id: s.id, name: s.name })
  }
  const list = [...projects.values()]
  for (const p of list) p.worktrees.sort((a, b) => Number(b.main) - Number(a.main) || a.top.localeCompare(b.top))
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
}

// ---- the Worktrees tab

/**
 * `git worktree list --porcelain -z`, whole: one record per worktree (the main one first, as git
 * lists it), records ending in an empty field. `branch` is the short name (refs/heads/ dropped),
 * null when detached; `locked` and `prunable` are git's reason, '' when it gave none, or null.
 */
export function parseWorktreeList(z) {
  const out = []
  let w = null
  for (const f of z.split('\0')) {
    if (f === '') {
      if (w) out.push(w)
      w = null
      continue
    }
    const sp = f.indexOf(' ')
    const key = sp < 0 ? f : f.slice(0, sp)
    const val = sp < 0 ? '' : f.slice(sp + 1)
    if (key === 'worktree') {
      if (w) out.push(w)
      w = { path: val, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null }
      continue
    }
    if (!w) continue
    if (key === 'HEAD') w.head = /^0+$/.test(val) ? null : val
    else if (key === 'branch') w.branch = val.startsWith('refs/heads/') ? val.slice(11) : val
    else if (key === 'detached') w.detached = true
    else if (key === 'bare') w.bare = true
    else if (key === 'locked') w.locked = val
    else if (key === 'prunable') w.prunable = val
  }
  if (w) out.push(w)
  return out
}

/**
 * Which branch "main" is, and how that was decided: origin's HEAD when the repository has one
 * (`refs/remotes/origin/HEAD` → origin/<name>), compared as the local branch of that name when
 * there is one, else as origin/<name>; with no origin HEAD, a local `main`, then a local `master`.
 * `originHead` is what `git symbolic-ref` printed (or null); `locals` the local branch names that
 * exist among the candidates. Null when none of these is there.
 */
export function pickBase(originHead, locals) {
  const have = new Set(locals)
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(originHead ?? '')
  if (m) {
    const name = m[1]
    return have.has(name)
      ? { name, ref: `refs/heads/${name}`, how: `origin/HEAD names ${name}` }
      : { name, ref: `refs/remotes/origin/${name}`, how: `origin/HEAD names ${name}; there is no local ${name}, so origin/${name}`, remote: true }
  }
  for (const name of ['main', 'master']) if (have.has(name)) return { name, ref: `refs/heads/${name}`, how: `no origin/HEAD; the local ${name}` }
  return null
}

/** How long a worktree with no session in it may go untouched before the stale filter shows it. */
export const STALE_DAYS = 14

/**
 * Why a worktree is stale, or null. Never the main worktree, the one main is checked out in, or one
 * a session is in. Otherwise: `gone` (its folder is missing: git lists it as prunable), `merged`
 * (on a branch, clean, and nothing on it main does not have: ahead 0), or `untouched` (its last
 * commit and its index both older than STALE_DAYS).
 */
export function staleness(w, now = Date.now(), days = STALE_DAYS) {
  if (w.main || w.isBase || w.bare || w.sessions?.length) return null
  if (w.prunable !== null && w.prunable !== undefined) return 'gone'
  if (w.branch && w.ahead === 0 && w.dirty === 0) return 'merged'
  if (w.touched && now - w.touched > days * 86_400_000) return 'untouched'
  return null
}

/** Files named per overlap; the count says how many in all. */
export const OVERLAP_FILES = 20

/**
 * Pairs of worktrees that touch the same file: each one's `changed` paths (uncommitted, and its
 * commits since the merge base with main) compared with every other's in the same repository.
 * Returns [{ a, b, files (the first OVERLAP_FILES, sorted), count }].
 */
export function overlaps(worktrees) {
  const out = []
  const sets = worktrees.map((w) => ({ path: w.path, set: new Set(w.changed ?? []) }))
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [small, big] = sets[i].set.size <= sets[j].set.size ? [sets[i].set, sets[j].set] : [sets[j].set, sets[i].set]
      const both = [...small].filter((f) => big.has(f)).sort()
      if (both.length) out.push({ a: sets[i].path, b: sets[j].path, files: both.slice(0, OVERLAP_FILES), count: both.length })
    }
  }
  return out
}

/**
 * A worktree's folder made short enough to read: relative to the project's root when inside it
 * (".claude/worktrees/side"), "~/…" under the home folder, else as it is. The root itself is its name.
 */
export function shortPath(path, root, home) {
  const p = path.replace(/\/+$/, '')
  const r = root.replace(/\/+$/, '')
  if (p === r) return base(r)
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1)
  const h = (home ?? '').replace(/\/+$/, '')
  if (h && p.startsWith(`${h}/`)) return `~/${p.slice(h.length + 1)}`
  return p
}

/** Session statuses a write waits out: a turn running, a question or permission prompt open, or the CLI still starting. */
export const NOT_QUIET = { busy: 'is busy', blocked: 'needs you', starting: 'is still starting' }
