// Install, update and remove: a tile cloned from a git repo at a pinned commit into userData
// `tiles/<id>` (CLAUDE.md §5 "Install, update, develop", §6). Two steps, so the user is asked in
// between: `prepare` fetches and checks the tile into a staging folder and says what it asks for;
// `confirm` moves it into place. Nothing is ever built and nothing in the repo is ever run:
//
// - the clone is a plain fetch of one commit into an empty repo made with no template, with hooks
//   pointed at /dev/null, no submodules, no LFS smudge or other filter, and symlinks checked out
//   as plain files; git is never asked for a password (a public repo or nothing);
// - `.git` is deleted before the folder is checked, so what is installed is files and nothing else;
// - the folder must pass `tile check` as a tile from outside (no backend: the trusted tier is for
//   tiles that ship with workshop), may not take a built-in tile's id, and may not ask for more
//   than the index listed for it.
//
// No electron here, so the unit tests drive it with real git in a temp folder.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { checkTileFolder, TRUSTED_ONLY } from './tile-check'
import { permissionChange, permissionKeys, permissionWords } from '../shared/permissions'
import { ID_RE } from '../shared/manifest'
import { repoAllowed } from '../shared/tile-index'
import type { InstallRecord, InstallRequest, PendingInstall } from '../shared/tile-menu'

/** Kept beside the tile's files: where it came from and what the user agreed to. Not served (the page is served from its entry's folder). */
export const RECORD_FILE = '.workshop-install.json'
const COMMIT_RE = /^[0-9a-f]{40}$/
/** A fetched tile waits this long for the user's answer, then its staging folder goes. */
const PENDING_MS = 30 * 60 * 1000
const GIT_TIMEOUT_MS = 120_000

export interface InstallerOpts {
  /** userData `tiles/`. */
  tilesDir: string
  /** Where clones wait for an answer. Same disk as tilesDir, so confirming is a rename. */
  stagingDir: string
  /** Who already has an id: a built-in tile ('core') can never be replaced; a folder under development must be stopped first. */
  takenBy: (id: string) => 'core' | 'dev' | null
  /** Allow file:// and absolute-path repos (a local index; the tests and smoke). */
  local?: () => boolean
}

interface Waiting {
  pending: PendingInstall
  dir: string
  staging: string
  at: number
}

/** git with every way a repo could run something of its own switched off. */
function git(args: string[], cwd: string, local: boolean): Promise<string> {
  const safe = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.symlinks=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false',
    '-c', 'protocol.ext.allow=never',
    '-c', `protocol.file.allow=${local ? 'always' : 'never'}`,
    '-c', 'advice.detachedHead=false',
    '-c', 'init.templateDir='
  ]
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'C'
  }
  return new Promise((res, rej) => {
    execFile('git', [...safe, ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ')))
      else res(stdout.trim())
    })
  })
}

/** Fetches exactly `commit` of `repo` into `dir` and checks it out, without its history and without .git afterwards. */
export async function fetchCommit(repo: string, commit: string, dir: string, local = false): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet', '--template=', dir], dir, local)
  try {
    // One commit, by id: GitHub and any protocol-v2 server answer this.
    await git(['fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', repo, commit], dir, local)
  } catch {
    // A server that will not hand out a commit by id: take its branches, then look for it.
    await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', repo, '+refs/heads/*:refs/remotes/src/*'], dir, local)
  }
  try {
    await git(['cat-file', '-e', `${commit}^{commit}`], dir, local)
  } catch {
    throw new Error(`commit ${commit.slice(0, 12)} is not in ${repo}`)
  }
  await git(['checkout', '--quiet', '--detach', commit], dir, local)
  const head = await git(['rev-parse', 'HEAD'], dir, local)
  if (head !== commit) throw new Error(`checked out ${head}, not ${commit}`)
  await rm(join(dir, '.git'), { recursive: true, force: true })
}

export class Installer {
  private waiting = new Map<string, Waiting>()

  constructor(private readonly o: InstallerOpts) {}

  /** Every tile install put in place, read from its record. */
  async list(): Promise<InstallRecord[]> {
    const out: InstallRecord[] = []
    for (const e of await readdir(this.o.tilesDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const r = await this.record(e.name)
      if (r) out.push(r)
    }
    return out
  }

  async record(id: string): Promise<InstallRecord | null> {
    if (!ID_RE.test(id)) return null
    try {
      const r = JSON.parse(await readFile(join(this.o.tilesDir, id, RECORD_FILE), 'utf8')) as InstallRecord
      return r && r.id === id && typeof r.repo === 'string' && typeof r.commit === 'string' ? r : null
    } catch {
      return null
    }
  }

  /** Fetches and checks the tile; nothing is installed until `confirm`. Throws a sentence a person can read. */
  async prepare(req: InstallRequest): Promise<PendingInstall> {
    await this.sweep()
    const local = !!this.o.local?.()
    const repo = String(req?.repo ?? '').trim()
    const commit = String(req?.commit ?? '').trim().toLowerCase()
    if (!repoAllowed(repo, { local })) throw new Error(local ? 'the repo must be an https URL, a file:// URL or an absolute path' : 'the repo must be an https URL')
    if (!COMMIT_RE.test(commit)) throw new Error('the commit must be its full id, 40 hex characters')

    await mkdir(this.o.stagingDir, { recursive: true })
    const staging = await mkdtemp(join(this.o.stagingDir, 's-'))
    const dir = join(staging, 'tile')
    try {
      try {
        await fetchCommit(repo, commit, dir, local)
      } catch (err) {
        throw new Error(`could not fetch ${repo} at ${commit.slice(0, 7)}: ${(err as Error).message}`)
      }
      const checked = await checkTileFolder(dir)
      if (!checked.ok || !checked.manifest) {
        const backend = checked.errors.find((e) => e.startsWith('backend:'))
        throw new Error(backend ? `refused: ${TRUSTED_ONLY}. This tile declares one, so it cannot be installed (yet).` : `refused: ${checked.errors.join('; ')}`)
      }
      const m = checked.manifest
      const taken = this.o.takenBy(m.id)
      if (taken === 'core') throw new Error(`refused: "${m.id}" is the id of a tile that ships with workshop, and an installed tile can never take it`)
      if (taken === 'dev') throw new Error(`a tile you are developing is loaded as "${m.id}"; stop loading it (Yours tab) before installing this one`)
      if (req.expect) {
        if (req.expect.id !== m.id) throw new Error(`refused: the index lists "${req.expect.id}", but the repo's tile.json says "${m.id}"`)
        const listed = new Set(permissionKeys(req.expect.permissions))
        const extra = permissionKeys(m.permissions).filter((k) => !listed.has(k))
        if (extra.length) throw new Error(`refused: the tile asks for more than the index lists (${extra.join(', ')})`)
      }
      const before = await this.record(m.id)
      if (before && before.repo !== repo) throw new Error(`"${m.id}" is already installed from ${before.repo}; remove it first`)
      const change = before ? permissionChange(before.permissions, m.permissions) : null
      const pending: PendingInstall = {
        token: randomBytes(16).toString('hex'),
        id: m.id,
        name: m.name,
        author: m.author,
        version: m.version,
        hint: m.hint ?? '',
        repo,
        commit,
        permissions: m.permissions,
        words: permissionWords(m.permissions),
        update: before && change ? { version: before.version, commit: before.commit, change } : null,
        ask: !change || change.added.length > 0,
        warnings: checked.warnings
      }
      this.waiting.set(pending.token, { pending, dir, staging, at: Date.now() })
      return pending
    } catch (err) {
      await rm(staging, { recursive: true, force: true })
      throw err
    }
  }

  /** Puts a prepared tile in place (replacing the version before it). Returns its folder. */
  async confirm(token: string): Promise<{ id: string; folder: string; update: boolean }> {
    const w = this.waiting.get(String(token))
    if (!w) throw new Error('that install is no longer waiting; fetch it again')
    this.waiting.delete(w.pending.token)
    const { pending: p, dir, staging } = w
    try {
      const record: InstallRecord = { id: p.id, repo: p.repo, commit: p.commit, version: p.version, permissions: p.permissions, installedAt: new Date().toISOString() }
      await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2))
      await mkdir(this.o.tilesDir, { recursive: true })
      const dest = join(this.o.tilesDir, p.id)
      const before = await this.record(p.id)
      if (before && before.repo !== p.repo) throw new Error(`"${p.id}" is already installed from ${before.repo}; remove it first`)
      const old = join(staging, 'old')
      const had = await rename(dest, old).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false
        throw err
      })
      try {
        await rename(dir, dest)
      } catch (err) {
        if (had) await rename(old, dest)
        throw err
      }
      return { id: p.id, folder: dest, update: had }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async cancel(token: string): Promise<void> {
    const w = this.waiting.get(String(token))
    if (!w) return
    this.waiting.delete(w.pending.token)
    await rm(w.staging, { recursive: true, force: true })
  }

  /** Deletes an installed tile's folder. Only one install put there: a folder without a record is not ours to delete. */
  async remove(id: string): Promise<void> {
    if (!(await this.record(id))) throw new Error(`"${id}" is not an installed tile`)
    await rm(join(this.o.tilesDir, id), { recursive: true, force: true })
  }

  /** Clones nobody answered for. */
  private async sweep(): Promise<void> {
    for (const [token, w] of this.waiting) {
      if (Date.now() - w.at < PENDING_MS) continue
      this.waiting.delete(token)
      await rm(w.staging, { recursive: true, force: true })
    }
  }
}
