// The source fingerprint (carried from deck): one hash of everything that goes into the packaged
// app, as the working tree has it right now (uncommitted edits and new files included,
// .gitignore respected). Taken by scripts/stamp.mjs when `npm run dist` builds, and again by the
// installed app every minute (src/main/updates.ts): different = the repo has changes the app does
// not, and the top bar offers "Install update".
// Read-only for the repo: it stages into a COPY of the index, never the real one.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * The top-level paths whose contents make the app. Docs, the project page (site/), the README and
 * CLAUDE.md never count: editing them is not an update. Nor do test/ and the scripts that only
 * draw pictures; scripts/lib is bundled into main, and stamp.mjs writes what the app reads.
 */
export const SOURCE_PATHS = [
  'src', 'tiles', 'template', 'bin', 'plugin', 'native', 'assets', 'build',
  'scripts/lib', 'scripts/stamp.mjs',
  'tmux.conf', 'package.json', 'package-lock.json',
  'electron.vite.config.ts', 'vite.tile-preload.config.ts', 'vite.check.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json'
]

function git(repo, args, env) {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out.trim())
    )
  )
}

/** The fingerprint of `repo`'s working tree, or null when it is not a git repo (or git fails). */
export async function fingerprint(repo, baseEnv = process.env, paths = SOURCE_PATHS) {
  const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' }
  // git refuses a pathspec that matches nothing, so a path the repo does not have is left out.
  const present = paths.filter((p) => existsSync(join(repo, p)))
  if (!present.length) return null
  let dir = null
  try {
    let real = await git(repo, ['rev-parse', '--git-path', 'index'], env)
    if (!isAbsolute(real)) real = join(repo, real)
    dir = await mkdtemp(join(tmpdir(), 'workshop-fp-'))
    const index = join(dir, 'index')
    // Starting from the real index keeps git's stat cache, so only files that changed are hashed.
    await copyFile(real, index).catch(() => {})
    const tmpEnv = { ...env, GIT_INDEX_FILE: index }
    await git(repo, ['add', '-A', '--', ...present], tmpEnv)
    const tree = await git(repo, ['write-tree'], tmpEnv)
    const entries = await git(repo, ['ls-tree', tree, '--', ...present], env)
    return createHash('sha256').update(entries).digest('hex').slice(0, 16)
  } catch {
    return null
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
