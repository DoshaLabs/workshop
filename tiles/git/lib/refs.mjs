// The whole-window view's sidebar: a repository's branches (with their upstream and how far they
// are ahead and behind it), its remotes' branch count, its newest tags and its stashes. Read-only.

import { failure, git } from './git.mjs'

const TAGS = 20
const STASHES = 30

/** `for-each-ref` lines split on US (0x1f). */
const rows = (r) =>
  r.out
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))

/** "ahead 2, behind 1" (%(upstream:track,nobracket)) → { ahead, behind, gone }. */
export function parseTrack(s) {
  const out = { ahead: 0, behind: 0, gone: false }
  if (!s) return out
  if (/gone/.test(s)) out.gone = true
  const a = /ahead (\d+)/.exec(s)
  const b = /behind (\d+)/.exec(s)
  if (a) out.ahead = Number(a[1])
  if (b) out.behind = Number(b[1])
  return out
}

export async function readRefs(root) {
  const [heads, remotes, tags, stashes] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)', 'refs/heads'], { cap: 1 << 20 }),
    git(root, ['for-each-ref', '--format=%(refname:short)%1f%(symref)', 'refs/remotes'], { cap: 1 << 20 }),
    git(root, ['for-each-ref', '--sort=-creatordate', `--count=${TAGS}`, '--format=%(refname:short)%1f%(objectname)', 'refs/tags'], { cap: 1 << 20 }),
    git(root, ['stash', 'list', `--max-count=${STASHES}`, '--format=%H%x1f%ct%x1f%gs'], { cap: 1 << 20 })
  ])
  if (heads.code !== 0) throw new Error(failure(heads, 'git for-each-ref'))
  return {
    branches: rows(heads).map(([name, oid, upstream, track, at]) => ({ name, oid, upstream: upstream || null, ...parseTrack(track), at: Number(at) * 1000 || 0 })),
    remotes: remotes.code === 0 ? rows(remotes).filter(([, sym]) => !sym).map(([name]) => name) : [],
    tags: tags.code === 0 ? rows(tags).map(([name, oid]) => ({ name, oid })) : [],
    stashes: stashes.code === 0 ? rows(stashes).map(([sha, at, said]) => ({ sha, at: Number(at) * 1000 || 0, said: said ?? '' })) : []
  }
}
