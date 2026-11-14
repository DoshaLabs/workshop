// The History tab's search, read the way Sublime Merge reads one: words, and tokens that narrow it.
//
//   session:<name>   commits that session made, or probably made
//   author:<name>    by author name
//   path:<path>      commits touching that path (asked of git: it is the backend's)
//   since:<n>d|h|w   in the last n days, hours or weeks
//   anything else    in the subject or the sha
//
// A value with spaces is quoted: session:"fix auth". No DOM; tested as shipped.

const KEYS = ['session', 'author', 'path', 'since']

/** → { text: [words], session, author, path, since (ms) } with null for what was not given. */
export function parseQuery(q) {
  const out = { text: [], session: null, author: null, path: null, since: null }
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(String(q ?? '')))) {
    const key = (m[1] ?? m[3])?.toLowerCase()
    const val = m[2] ?? m[4]
    if (key && KEYS.includes(key)) {
      if (key === 'since') {
        const s = /^(\d+)\s*([hdw])$/i.exec(val)
        if (s) out.since = Number(s[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[s[2].toLowerCase()]
      } else out[key] = val
    } else {
      const word = m[5] ?? m[6] ?? `${m[1] ?? m[3]}:${val}`
      if (word) out.text.push(word.toLowerCase())
    }
  }
  return out
}

/** Whether a query asks for anything. */
export const isEmpty = (q) => !q.text.length && !q.session && !q.author && !q.path && !q.since

/** Whether one commit matches (path is applied by the backend, not here). */
export function matches(c, q, now = Date.now()) {
  if (q.since && c.ct < now - q.since) return false
  if (q.author && !c.author.toLowerCase().includes(q.author.toLowerCase())) return false
  if (q.session && !(c.by?.names ?? []).some((n) => n.toLowerCase().includes(q.session.toLowerCase()))) return false
  for (const w of q.text) if (!c.subject.toLowerCase().includes(w) && !c.sha.startsWith(w)) return false
  return true
}

/** The tokens a query was read as, for chips under the box: [{ key, value }]. */
export function chips(q) {
  const out = []
  for (const k of ['session', 'author', 'path']) if (q[k]) out.push({ key: k, value: q[k] })
  if (q.since) {
    const d = q.since / 86_400_000
    out.push({ key: 'since', value: d >= 1 ? `${Math.round(d)}d` : `${Math.round(q.since / 3_600_000)}h` })
  }
  for (const w of q.text) out.push({ key: '', value: w })
  return out
}
