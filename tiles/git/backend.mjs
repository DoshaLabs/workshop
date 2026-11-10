// The Git tile's backend (the trusted tier: a program of its own, beside the page, with full
// access to this Mac; only tiles that ship with workshop may have one).
//
// The page names sessions by id and nothing else: the folder each one works in comes from the
// list core hands this program (`sessions()`), so a page can never point git at a path of its
// choosing. The Worktrees tab's ops name a project by the root core gave a session, and a
// worktree by the path git lists for that root; anything else is refused (lib/worktrees.mjs).
// The History tab's names a project the same way, and a commit by its full sha.

import { homedir } from 'node:os'
import { changes, diff, worktreeTop } from './lib/git.mjs'
import { group } from './lib/parse.mjs'
import { diffAgainstBase, listWorktrees, merge, readProject, rebase, remove } from './lib/worktrees.mjs'
import { projectHistory, showCommit } from './lib/history.mjs'
import { isSha, logLimit } from './lib/log.mjs'

/** A folder's worktree top is asked of git once a minute at most (it changes only if the worktree is removed). */
const TOP_MS = 60_000

export default function ({ handle, sessions, commits, onCommits, emit }) {
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

  // { sessions: [id…] } → { projects: [{ root, name, base, worktrees: [...] }], at }: every worktree
  // of each of those sessions' projects, the sessions open in each, and where two touch one file.
  handle('worktrees', async (body) => {
    const list = known(body?.sessions)
    const places = new Map()
    await Promise.all(list.map(async (s) => places.set(s.id, await topOf(s.folder))))
    const roots = [...new Set(list.map((s) => s.root))]
    const home = homedir()
    const projects = await Promise.all(
      roots.map(async (root) => {
        const sessionsAt = (path) => list.filter((s) => places.get(s.id) === path).map((s) => ({ id: s.id, name: s.name, status: s.status }))
        try {
          return { name: root.replace(/\/+$/, '').split('/').pop() || root, ...(await once(`worktrees ${root}`, () => readProject(root, { sessionsAt, home }))) }
        } catch (e) {
          return { root, name: root.split('/').pop() || root, base: null, worktrees: [], error: e.message }
        }
      })
    )
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
    return { projects, at: Date.now() }
  })

  /** A worktree the page names: { root, path }, where root is a session's project and path one of git's worktrees of it. */
  async function named(body) {
    const root = body?.root
    const path = body?.path
    if (typeof root !== 'string' || typeof path !== 'string') throw new Error('which worktree: { root, path }')
    if (!sessions().some((s) => s.root === root)) throw new Error('no session works in that project')
    if (!(await listWorktrees(root)).some((w) => w.path === path)) throw new Error('that worktree is gone')
    return { root, path }
  }

  // { root, path } → { base, files, cut }: what the worktree would bring to main (read-only).
  handle('diffmain', async (body) => {
    const { root, path } = await named(body)
    return diffAgainstBase(root, path)
  })

  // The writes, one at a time: a second asked while one runs is refused, never queued behind it
  // (it would act on what the first left, which the page has not seen).
  let writing = false
  const write = (fn) => async (body) => {
    if (writing) throw new Error('another git action is still running')
    writing = true
    try {
      const all = sessions()
      return await fn({ root: body?.root, path: body?.path, expect: body?.expect }, { sessions: all, topOf })
    } finally {
      writing = false
      // What git is now is read again on the next poll, not from the minute-long cache of tops.
      tops.clear()
    }
  }
  // Which session made which commit, as core recorded it: sha → { session, name }. Rebuilt when
  // core sends a new list, which also tells the page to look again (a commit just landed).
  let records = new Map()
  const setRecords = (list) => {
    records = new Map(list.map((c) => [c.sha, { session: c.session, name: c.name }]))
  }
  setRecords(commits())
  onCommits((list) => {
    setRecords(list)
    emit('commits', { count: list.length })
  })

  // { sessions: [id…], limit? } → { projects: [{ root, name, commits: [{ sha, parents, author, at, ct, refs, subject, by }], more, error? }], at }
  // `by` is { kind: 'exact' | 'probable', ids, names } or null (lib/log.mjs). Every session core
  // knows in a project counts for the guesses, parked ones included; the page names the projects
  // by naming open sessions.
  handle('history', async (body) => {
    const list = known(body?.sessions)
    const limit = logLimit(body?.limit)
    const roots = [...new Set(list.map((s) => s.root))]
    const all = sessions()
    const now = Date.now()
    const projects = await Promise.all(
      roots.map(async (root) => {
        const name = root.replace(/\/+$/, '').split('/').pop() || root
        try {
          const h = await once(`history ${root} ${limit}`, () => projectHistory(root, { limit, sessions: all.filter((s) => s.root === root), topOf, records, now }))
          return { root, name, ...h }
        } catch (e) {
          return { root, name, commits: [], more: false, error: e.message }
        }
      })
    )
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
    return { projects, at: now }
  })

  // { root, sha } → { files, cut }: one commit's diff against its first parent (read-only).
  handle('commit', async (body) => {
    const root = body?.root
    if (typeof root !== 'string' || !sessions().some((s) => s.root === root)) throw new Error('no session works in that project')
    if (!isSha(body?.sha)) throw new Error('which commit: its full sha')
    return once(`commit ${root} ${body.sha}`, () => showCommit(root, body.sha))
  })

  // { root, path, expect: { head, base } } → { done, nothing?, conflict?, stuck?, files?, said }
  handle('rebase', write(rebase))
  handle('merge', write(merge))
  handle('remove', write(remove))
}
