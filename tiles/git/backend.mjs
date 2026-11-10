// The Git tile's backend (the trusted tier: a program of its own, beside the page, with full
// access to this Mac; only tiles that ship with workshop may have one). Read-only for now.
//
// The page names sessions by id and nothing else: the folder each one works in comes from the
// list core hands this program (`sessions()`), so a page can never point git at a path of its
// choosing.

import { changes, diff, worktreeTop } from './lib/git.mjs'
import { group } from './lib/parse.mjs'

/** A folder's worktree top is asked of git once a minute at most (it changes only if the worktree is removed). */
const TOP_MS = 60_000

export default function ({ handle, sessions }) {
  const tops = new Map()
  async function topOf(folder) {
    const hit = tops.get(folder)
    if (hit && Date.now() - hit.at < TOP_MS) return hit.top
    const top = await worktreeTop(folder)
    tops.set(folder, { top, at: Date.now() })
    return top
  }

  /** The sessions the page asked for, as core knows them; ids core does not know are dropped. */
  function known(ids) {
    if (!Array.isArray(ids)) throw new Error('sessions: a list of session ids')
    const all = new Map(sessions().map((s) => [s.id, s]))
    return [...new Set(ids.filter((x) => typeof x === 'string'))].map((id) => all.get(id)).filter(Boolean)
  }

  // A poll that arrives while the same worktree is still being read waits for that answer.
  const reading = new Map()
  function once(key, fn) {
    let p = reading.get(key)
    if (!p) {
      p = fn().finally(() => reading.delete(key))
      reading.set(key, p)
    }
    return p
  }

  // { sessions: [id…] } → { projects: [{ root, name, worktrees: [{ top, main, branch, sessions, files, count, add, del }], outside }] }
  handle('changes', async (body) => {
    const list = known(body?.sessions)
    const places = new Map()
    await Promise.all(list.map(async (s) => places.set(s.id, await topOf(s.folder))))
    const found = new Map()
    await Promise.all(
      [...new Set([...places.values()].filter(Boolean))].map(async (top) => {
        try {
          found.set(top, await once(`changes ${top}`, () => changes(top)))
        } catch (e) {
          tops.delete(top)
          found.set(top, { error: e.message })
        }
      })
    )
    return { projects: group(list, places, found), at: Date.now() }
  })

  // { session: id } → { top, files: [{ path, from, status, binary, hunks, truncated, cutLines }], cut, unread }
  handle('diff', async (body) => {
    const [s] = known([body?.session])
    if (!s) throw new Error('no such session')
    const top = await topOf(s.folder)
    if (!top) throw new Error(`${s.name} is not working in a git repository`)
    return { top, ...(await once(`diff ${top}`, () => diff(top))) }
  })
}
