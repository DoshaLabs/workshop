// Install update (src/main/updates.ts), the source fingerprint (scripts/lib/fingerprint.mjs), the
// build-info file (src/shared/update.ts) and where core's own files are (src/main/resources.ts).

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SOURCE_PATHS, fingerprint } from '../scripts/lib/fingerprint.mjs'
import { parseBuildInfo, type AppUpdate } from '@shared/update'
import { SWAP_SCRIPT, Updater, bundleOf, newestBundle, type SpawnLike } from '../src/main/updates'
import { resourcePath, resourceRoot } from '../src/main/resources'

const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'ws-fp-'))
  git(r, 'init', '-q')
  git(r, 'config', 'user.email', 't@t')
  git(r, 'config', 'user.name', 't')
  mkdirSync(join(r, 'src'))
  mkdirSync(join(r, 'docs'))
  writeFileSync(join(r, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(r, 'docs', 'x.md'), 'x\n')
  writeFileSync(join(r, 'package.json'), '{}\n')
  writeFileSync(join(r, 'README.md'), 'r\n')
  writeFileSync(join(r, 'CLAUDE.md'), 'c\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-qm', 'one')
  return r
}

describe('the source fingerprint', () => {
  it('counts what makes the app and nothing that does not', () => {
    for (const p of ['src', 'tiles', 'template', 'bin', 'plugin', 'native', 'assets', 'tmux.conf', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.tile-preload.config.ts', 'vite.check.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json'])
      expect(SOURCE_PATHS).toContain(p)
    for (const p of ['docs', 'site', 'README.md', 'CLAUDE.md', 'test', 'vite.site.config.ts']) expect(SOURCE_PATHS).not.toContain(p)
  })

  it('changes with the source, uncommitted edits and new files included, and not with docs', async () => {
    const r = repo()
    const one = await fingerprint(r)
    expect(one).toMatch(/^[0-9a-f]{16}$/)
    // docs, the README and CLAUDE.md: no update
    writeFileSync(join(r, 'docs', 'x.md'), 'changed\n')
    writeFileSync(join(r, 'README.md'), 'changed\n')
    writeFileSync(join(r, 'CLAUDE.md'), 'changed\n')
    expect(await fingerprint(r)).toBe(one)
    // an uncommitted edit to the source: an update
    writeFileSync(join(r, 'src', 'a.ts'), 'b\n')
    const two = await fingerprint(r)
    expect(two).not.toBe(one)
    // a new, untracked file in a counted folder (one that did not exist before)
    mkdirSync(join(r, 'tiles'))
    writeFileSync(join(r, 'tiles', 'new.json'), '{}\n')
    expect(await fingerprint(r)).not.toBe(two)
    // and the real index is never touched
    expect(git(r, 'status', '--porcelain')).toContain('?? tiles/')
  })

  it('is null outside a git repo', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-fp-none-'))
    mkdirSync(join(d, 'src'))
    expect(await fingerprint(d)).toBeNull()
  })
})

describe('build-info.json', () => {
  it('reads what stamp.mjs writes', () => {
    expect(parseBuildInfo(JSON.stringify({ repo: '/Users/x/workshop', fingerprint: 'abc', builtAt: 5 }))).toEqual({ repo: '/Users/x/workshop', fingerprint: 'abc', builtAt: 5 })
  })
  it('refuses what it cannot update from', () => {
    expect(parseBuildInfo('not json')).toBeNull()
    expect(parseBuildInfo('null')).toBeNull()
    expect(parseBuildInfo(JSON.stringify({ repo: 'relative', fingerprint: 'abc' }))).toBeNull()
    expect(parseBuildInfo(JSON.stringify({ repo: '/r', fingerprint: null }))).toBeNull()
    expect(parseBuildInfo(JSON.stringify({ repo: '/r', fingerprint: 'abc' }))?.builtAt).toBe(0)
  })
})

describe('where core’s own files are', () => {
  const w = { resourcesPath: '/Applications/workshop.app/Contents/Resources', appPath: '/Users/x/workshop' }
  it('is the repo in dev', () => {
    expect(resourceRoot({ ...w, packaged: false })).toBe('/Users/x/workshop')
    expect(resourcePath({ ...w, packaged: false }, 'bin', 'workshop-tile.mjs')).toBe('/Users/x/workshop/bin/workshop-tile.mjs')
  })
  it('is Contents/Resources packaged, never inside the asar', () => {
    const p = { resourcesPath: w.resourcesPath, appPath: `${w.resourcesPath}/app.asar`, packaged: true }
    expect(resourcePath(p, 'tmux.conf')).toBe('/Applications/workshop.app/Contents/Resources/tmux.conf')
    expect(resourcePath(p, 'tiles')).not.toContain('app.asar')
  })
  it('every folder resources.ts names is shipped as an extraResource', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { extraResources: (string | { from: string })[] } }
    const shipped = pkg.build.extraResources.map((e) => (typeof e === 'string' ? e : e.from))
    for (const p of ['tmux.conf', 'bin', 'tiles', 'template', 'assets', 'plugin', 'native']) expect(shipped).toContain(p)
  })
})

// ── The updater, with a fake spawn ──────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  unref = vi.fn()
}

function rig(opts: { now?: string | null; built?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-upd-'))
  const repoDir = join(dir, 'repo')
  if (opts.built !== false) mkdirSync(join(repoDir, 'dist', 'mac-arm64', 'workshop.app'), { recursive: true })
  else mkdirSync(repoDir)
  const states: AppUpdate[] = []
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown>; child: FakeChild }[] = []
  const spawn: SpawnLike = (cmd, args, o) => {
    const child = new FakeChild()
    calls.push({ cmd, args, opts: o, child })
    return child as never
  }
  let fp: string | null = opts.now === undefined ? 'new' : opts.now
  const quit = vi.fn()
  const u = new Updater({
    info: { repo: repoDir, fingerprint: 'old', builtAt: 1 },
    env: () => ({ PATH: '/usr/bin' }),
    logPath: join(dir, 'update.log'),
    onChange: (s) => states.push(s),
    bundle: '/Applications/workshop.app',
    bundleName: 'workshop.app',
    quit,
    pid: 4242,
    spawn,
    fingerprint: async () => fp
  })
  return { u, states, calls, quit, dir, repoDir, setFp: (v: string | null) => (fp = v) }
}

describe('the updater', () => {
  it('offers nothing without build info (dev, smoke)', async () => {
    const onChange = vi.fn()
    const u = new Updater({ info: null, env: () => ({}), logPath: '/dev/null', onChange, bundle: '', bundleName: 'workshop.app', quit: () => {} })
    await u.check()
    expect(u.get()).toEqual({ state: 'none' })
    expect(onChange).not.toHaveBeenCalled()
    await expect(u.install()).rejects.toThrow(/npm run dist/)
  })

  it('is quiet while the repo matches, and offers the update when it differs', async () => {
    const r = rig({ now: 'old' })
    await r.u.check()
    expect(r.u.get().state).toBe('none')
    expect(r.states).toEqual([])
    r.setFp('new')
    await r.u.check()
    expect(r.u.get()).toMatchObject({ state: 'available', fingerprint: 'new', builtAt: 1, repo: r.repoDir })
    // the same again is not news
    await r.u.check()
    expect(r.states).toHaveLength(1)
  })

  it('builds, then swaps the new app in once this one has quit', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      await r.u.install()
      expect(r.u.get()).toMatchObject({ state: 'building', fingerprint: 'new' })
      const build = r.calls[0]
      expect(build.cmd).toBe('npm')
      expect(build.args).toEqual(['run', 'dist'])
      expect(build.opts.cwd).toBe(r.repoDir)
      expect((build.opts.env as Record<string, string>).WORKSHOP_FINGERPRINT).toBe('new')
      // a check while it builds changes nothing
      await r.u.check()
      expect(r.u.get().state).toBe('building')
      build.child.stdout.emit('data', Buffer.from('building…\n'))
      build.child.emit('close', 0)
      expect(r.u.get().state).toBe('installing')
      const swap = r.calls[1]
      expect(swap.cmd).toBe('/bin/sh')
      expect(swap.args).toEqual(['-c', SWAP_SCRIPT])
      expect(swap.opts.detached).toBe(true)
      expect(swap.opts.env).toMatchObject({ PID: '4242', SRC: join(r.repoDir, 'dist', 'mac-arm64', 'workshop.app'), DEST: '/Applications/workshop.app' })
      expect(swap.child.unref).toHaveBeenCalled()
      expect(r.quit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(400)
      expect(r.quit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed build with its last lines, and keeps it until the source changes', async () => {
    const r = rig()
    await r.u.install()
    r.calls[0].child.stderr.emit('data', Buffer.from('error TS2304: Cannot find name\n'))
    r.calls[0].child.emit('close', 2)
    const e = r.u.get()
    expect(e.state).toBe('error')
    expect(e.error).toContain('exited 2')
    expect(e.error).toContain('TS2304')
    expect(e.error).toContain('update.log')
    // the whole build's output is in the profile's log
    await new Promise((res) => setTimeout(res, 50))
    const log = readFileSync(join(r.dir, 'update.log'), 'utf8')
    expect(log).toContain('npm run dist in')
    expect(log).toContain('TS2304')
    await r.u.check()
    expect(r.u.get().state).toBe('error')
    r.setFp('newer')
    await r.u.check()
    expect(r.u.get()).toMatchObject({ state: 'available', fingerprint: 'newer' })
  })

  it('reports a build that leaves no app, and npm that cannot start', async () => {
    const r = rig({ built: false })
    await r.u.install()
    r.calls[0].child.emit('close', 0)
    expect(r.u.get().state).toBe('error')
    expect(r.u.get().error).toMatch(/no workshop.app was found/)
    expect(r.quit).not.toHaveBeenCalled()
    const r2 = rig()
    await r2.u.install()
    r2.calls[0].child.emit('error', new Error('spawn npm ENOENT'))
    expect(r2.u.get()).toMatchObject({ state: 'error', error: 'spawn npm ENOENT' })
  })

  it('does not start a second build while one runs', async () => {
    const r = rig()
    await r.u.install()
    await r.u.install()
    expect(r.calls).toHaveLength(1)
  })
})

describe('the bundle', () => {
  it('is found from the running executable', () => {
    expect(bundleOf('/Applications/workshop.app/Contents/MacOS/workshop')).toBe('/Applications/workshop.app')
    expect(bundleOf('/Users/x/workshop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toMatch(/Electron\.app$/)
    expect(bundleOf('/usr/local/bin/node')).toBeNull()
  })
  it('the newest build under dist/ is the one installed', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-dist-'))
    mkdirSync(join(d, 'mac', 'workshop.app'), { recursive: true })
    await new Promise((r) => setTimeout(r, 20))
    mkdirSync(join(d, 'mac-arm64', 'workshop.app'), { recursive: true })
    expect(newestBundle(d, 'workshop.app')).toBe(join(d, 'mac-arm64', 'workshop.app'))
    expect(newestBundle(join(d, 'nope'), 'workshop.app')).toBeNull()
  })
})
