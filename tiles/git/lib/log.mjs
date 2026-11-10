// The Git tile's History tab, the part with no process and no file system: reading `git log`'s
// output and deciding which session made each commit. Tested as shipped (test/git-history.test.ts).
//
// Which session made a commit, three ways, never mixed up:
//
// - exact: core saw it. A session's PostToolUse hook told core a Bash call made commits, and core
//   recorded their shas against that session (src/main/commits.ts). The backend gets the records.
// - probable: a guess, shown as one ("probably wt-feat"). The commit is on the branch checked out
//   in a worktree a session works in (reachable from that worktree's HEAD), and it was committed
//   while that session existed (from its start to now, or to its last activity if it died). When
//   several sessions fit, those away from main win (their branch is more particular than main's);
//   if more than one still fits, each is named ("probably a or b").
// - none: anything else.

/** Commits read per project at first; "show more" asks for this many more. */
export const LOG_PAGE = 300
/** The most a page may ask for at once. */
export const LOG_MAX = 3000
export const SUBJECT_CHARS = 300
const NAME_CHARS = 120

/** The format each commit is read with: fields split by US (0x1f), commits by NUL (-z). */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%at%x1f%ct%x1f%D%x1f%s'

/**
 * A ref as `%D` writes it with --decorate=full: "HEAD -> refs/heads/main", "tag: refs/tags/v1",
 * "refs/remotes/origin/main", "HEAD" (detached). → { name, kind } with kind head (the branch
 * checked out here, or a detached HEAD), branch, remote or tag; null for one not worth showing
 * (origin/HEAD, the stash, anything outside heads, remotes and tags).
 */
export function parseRef(r) {
  let s = r.trim()
  if (!s) return null
  let head = false
  if (s.startsWith('HEAD -> ')) {
    head = true
    s = s.slice(8)
  } else if (s === 'HEAD') return { name: 'HEAD', kind: 'head' }
  if (s.startsWith('tag: ')) s = s.slice(5)
  let m
  if ((m = /^refs\/heads\/(.+)$/.exec(s))) return { name: m[1], kind: head ? 'head' : 'branch' }
  if ((m = /^refs\/remotes\/(.+)$/.exec(s))) return m[1].endsWith('/HEAD') ? null : { name: m[1], kind: 'remote' }
  if ((m = /^refs\/tags\/(.+)$/.exec(s))) return { name: m[1], kind: 'tag' }
  return null
}

/**
 * `git log -z --decorate=full --format=LOG_FORMAT` → commits, newest first: { sha, parents,
 * author, at (author time, ms), ct (commit time, ms), refs, subject }. `cut` says the output was
 * cut short: the last, partial commit is dropped.
 */
export function parseLog(z, cut = false) {
  const recs = z.split('\0')
  if (cut || recs.at(-1) !== '') recs.pop()
  const out = []
  for (const raw of recs) {
    const rec = raw.replace(/^\n/, '')
    if (!rec) continue
    const f = rec.split('\x1f')
    if (f.length < 7 || !/^[0-9a-f]{40,64}$/.test(f[0])) continue
    const subject = f.slice(6).join('\x1f')
    out.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
      author: f[2].slice(0, NAME_CHARS),
      at: Number(f[3]) * 1000 || 0,
      ct: Number(f[4]) * 1000 || 0,
      refs: f[5] ? f[5].split(', ').map(parseRef).filter(Boolean) : [],
      subject: subject.length > SUBJECT_CHARS ? `${subject.slice(0, SUBJECT_CHARS)}…` : subject
    })
  }
  return out
}

/** The shas reachable from `head` among `commits` (walking parents, only through commits read). */
export function reachable(commits, head) {
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const seen = new Set()
  const todo = head && bySha.has(head) ? [head] : []
  while (todo.length) {
    const sha = todo.pop()
    if (seen.has(sha)) continue
    seen.add(sha)
    for (const p of bySha.get(sha)?.parents ?? []) if (bySha.has(p) && !seen.has(p)) todo.push(p)
  }
  return seen
}

/**
 * Tags each commit with the session that made it: `by` is { kind: 'exact' | 'probable', ids,
 * names } or null (the rules are at the top of this file).
 *
 * - `records`: Map sha → { session, name } (core's records).
 * - `sessions`: [{ id, name, started, ended (null while it lives), head (its worktree's HEAD, or
 *   null), onBase (its worktree has main checked out) }].
 */
export function attribute(commits, { records, sessions, now = Date.now() }) {
  const heads = new Map()
  for (const s of sessions) if (s.head && !heads.has(s.head)) heads.set(s.head, reachable(commits, s.head))
  return commits.map((c) => {
    const rec = records.get(c.sha)
    if (rec) return { ...c, by: { kind: 'exact', ids: [rec.session], names: [rec.name] } }
    const fits = sessions.filter((s) => s.head && heads.get(s.head).has(c.sha) && c.ct >= s.started && c.ct <= (s.ended ?? now))
    const off = fits.filter((s) => !s.onBase)
    const pick = off.length ? off : fits
    if (!pick.length) return { ...c, by: null }
    return { ...c, by: { kind: 'probable', ids: pick.map((s) => s.id), names: pick.map((s) => s.name) } }
  })
}

/** How many commits a page may ask for: a whole number of pages, at least one, at most LOG_MAX. */
export function logLimit(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : LOG_PAGE
  return Math.min(LOG_MAX, Math.max(LOG_PAGE, v))
}

/** A commit's sha as a page may name one: 40 hex (sha-1) or 64 (sha-256). */
export const isSha = (s) => typeof s === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)
