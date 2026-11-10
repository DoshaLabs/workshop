// A session's project: the repository it works in, not the folder it happened to start in. Two
// sessions in two worktrees of one repo are one project, so a tile that files things by project
// (Reminders) or shows them by project (Git) puts them together. A folder that is not in a repo is
// its own project.
//
// Resolved once per session with git itself (`rev-parse --git-common-dir`, which names the main
// repository's .git even from inside a worktree), and with GIT_OPTIONAL_LOCKS=0, so it never
// takes a lock a session's own git commands are waiting for.

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

function git(cwd: string, args: string[]): Promise<string | null> {
  // GIT_DIR and friends (set when core itself was started from a git hook) would answer for that repo instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/.test(k)))
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => done(err ? null : out.trim()))
  })
}

const real = (p: string): Promise<string> => realpath(p).catch(() => p)

/**
 * The project folder for a session started in `cwd`: the main repository's root (also from a
 * worktree or a subfolder), a submodule's own root, a bare repository's folder for its worktrees,
 * or `cwd` itself, unchanged, when it is not in a repo (or git is missing, or the folder is gone).
 */
export async function projectRoot(cwd: string): Promise<string> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return cwd
  // An ordinary repo or any of its worktrees: <root>/.git.
  if (basename(common) === '.git') return real(dirname(common))
  // A submodule keeps its git dir inside the superproject's (.git/modules/<name>): its own top is the project.
  if (common.includes('/.git/modules/')) return real((await git(cwd, ['rev-parse', '--show-toplevel'])) ?? cwd)
  // A bare repository's worktrees share the bare folder.
  return real(common)
}

/**
 * Each session's project, resolved once and kept. `ready` resolves every session in a list that
 * has not been resolved yet; `get` answers from what is known (the start folder until then).
 */
export class ProjectRoots {
  private known = new Map<string, string>()
  private pending = new Map<string, Promise<void>>()

  constructor(private readonly resolve: (cwd: string) => Promise<string> = projectRoot) {}

  get(id: string, cwd: string): string {
    return this.known.get(id) ?? cwd
  }

  ready(sessions: { id: string; cwd: string }[]): Promise<void> {
    const waits: Promise<void>[] = []
    for (const s of sessions) {
      if (this.known.has(s.id)) continue
      let p = this.pending.get(s.id)
      if (!p) {
        p = this.resolve(s.cwd).then(
          (root) => void this.known.set(s.id, root),
          () => void this.known.set(s.id, s.cwd)
        )
        this.pending.set(s.id, p)
        void p.finally(() => this.pending.delete(s.id))
      }
      waits.push(p)
    }
    return Promise.all(waits).then(() => {})
  }
}
