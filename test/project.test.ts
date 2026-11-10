import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRoots, projectRoot } from '../src/main/project'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' })
}
/** A temporary folder, by its real path (macOS's tmpdir is behind a symlink). */
const temp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'ws-project-')))

/** A repo with one commit, a subfolder, and a worktree of it outside the repo and one inside it (as `claude --worktree` makes). */
function repo(): { root: string; sub: string; outside: string; inside: string } {
  const root = temp()
  git(root, 'init', '-q')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.txt'), 'a')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'one')
  const outside = join(temp(), 'wt')
  git(root, 'worktree', 'add', '-q', outside, '-b', 'side')
  const inside = join(root, '.claude', 'worktrees', 'agent')
  git(root, 'worktree', 'add', '-q', inside, '-b', 'agent')
  return { root, sub: join(root, 'src'), outside, inside }
}

describe('projectRoot', () => {
  it('a repo’s root is its project, from the root or a subfolder', async () => {
    const r = repo()
    expect(await projectRoot(r.root)).toBe(r.root)
    expect(await projectRoot(r.sub)).toBe(r.root)
  })

  it('a worktree belongs to the main repository, wherever it is', async () => {
    const r = repo()
    expect(await projectRoot(r.outside)).toBe(r.root)
    expect(await projectRoot(r.inside)).toBe(r.root)
    expect(await projectRoot(join(r.inside, 'src'))).toBe(r.root)
  })

  it('a folder that is not in a repo is its own project, unchanged', async () => {
    const plain = temp()
    expect(await projectRoot(plain)).toBe(plain)
    const gone = join(plain, 'not-here')
    expect(await projectRoot(gone)).toBe(gone)
  })

  it('a bare repository’s worktrees share the bare folder', async () => {
    const src = repo()
    const bare = join(temp(), 'b.git')
    git(src.root, 'clone', '-q', '--bare', src.root, bare)
    const wt = join(temp(), 'bw')
    git(bare, 'worktree', 'add', '-q', wt, 'main')
    expect(await projectRoot(wt)).toBe(bare)
  })
})

describe('ProjectRoots', () => {
  it('resolves each session once and answers with the start folder until then', async () => {
    const calls: string[] = []
    const roots = new ProjectRoots(async (cwd) => {
      calls.push(cwd)
      return `${cwd}-root`
    })
    expect(roots.get('a', '/x')).toBe('/x')
    await Promise.all([roots.ready([{ id: 'a', cwd: '/x' }]), roots.ready([{ id: 'a', cwd: '/x' }, { id: 'b', cwd: '/y' }])])
    await roots.ready([{ id: 'a', cwd: '/x' }])
    expect(roots.get('a', '/x')).toBe('/x-root')
    expect(roots.get('b', '/y')).toBe('/y-root')
    expect(calls).toEqual(['/x', '/y'])
  })

  it('falls back to the start folder when resolving fails', async () => {
    const roots = new ProjectRoots(() => Promise.reject(new Error('no git')))
    await roots.ready([{ id: 'a', cwd: '/x' }])
    expect(roots.get('a', '/x')).toBe('/x')
  })
})
