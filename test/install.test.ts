import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, symlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Installer, RECORD_FILE } from '../src/main/install'
import { tileRepo } from '../src/main/tile-repo-fixture'

function setup(taken: Record<string, 'core' | 'dev'> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-install-')))
  const installer = new Installer({ tilesDir: join(root, 'tiles'), stagingDir: join(root, 'staging'), takenBy: (id) => taken[id] ?? null, local: () => true })
  const repo = tileRepo(join(root, 'repo'), { id: 'focus', name: 'Focus' })
  return { root, installer, repo }
}

describe('install, update, remove', () => {
  it('installs exactly the pinned commit, with no .git, only after confirm', async () => {
    const { root, installer, repo } = setup()
    const first = repo.commit({ permissions: { storage: true } })
    repo.commit({ version: '0.2.0', permissions: { storage: true } }) // later work, not what the index pins
    const p = await installer.prepare({ repo: repo.dir, commit: first })
    expect(p).toMatchObject({ id: 'focus', version: '0.1.0', update: null, ask: true, words: ['keep its own data'] })
    expect(existsSync(join(root, 'tiles', 'focus'))).toBe(false)
    const done = await installer.confirm(p.token)
    expect(done).toMatchObject({ id: 'focus', update: false })
    expect(readdirSync(done.folder).sort()).toEqual([RECORD_FILE, 'dist', 'icon.svg', 'tile.json'])
    expect(JSON.parse(readFileSync(join(done.folder, 'tile.json'), 'utf8')).version).toBe('0.1.0')
    expect(await installer.record('focus')).toMatchObject({ repo: repo.dir, commit: first, version: '0.1.0', permissions: { storage: true } })
    // Nothing is left waiting in staging.
    expect(readdirSync(join(root, 'staging'))).toEqual([])
  })

  it('an update that asks for nothing new goes in without asking; one that asks for more asks', async () => {
    const { installer, repo } = setup()
    await installer.confirm((await installer.prepare({ repo: repo.dir, commit: repo.commit({ permissions: { storage: true, notify: true } }) })).token)
    const quiet = await installer.prepare({ repo: repo.dir, commit: repo.commit({ version: '0.2.0', permissions: { storage: true } }) })
    expect(quiet).toMatchObject({ ask: false, update: { version: '0.1.0', change: { added: [], removed: ['send you notifications'] } } })
    expect(await installer.confirm(quiet.token)).toMatchObject({ update: true })
    const loud = await installer.prepare({ repo: repo.dir, commit: repo.commit({ version: '0.3.0', permissions: { storage: true, net: ['api.example.com'] } }) })
    expect(loud).toMatchObject({ ask: true, update: { version: '0.2.0', change: { added: ['reach api.example.com'] } } })
    await installer.cancel(loud.token)
    expect(await installer.record('focus')).toMatchObject({ version: '0.2.0' })
  })

  it('never takes the id of a tile that ships with workshop, nor of a folder under development', async () => {
    const core = setup({ focus: 'core' })
    await expect(core.installer.prepare({ repo: core.repo.dir, commit: core.repo.commit() })).rejects.toThrow(/ships with workshop/)
    const dev = setup({ focus: 'dev' })
    await expect(dev.installer.prepare({ repo: dev.repo.dir, commit: dev.repo.commit() })).rejects.toThrow(/developing/)
  })

  it('refuses a backend, and says why', async () => {
    const { installer, repo, root } = setup()
    await expect(installer.prepare({ repo: repo.dir, commit: repo.commit({}, { 'backend.mjs': 'process.exit(1)' }) })).rejects.toThrow(/trusted tier .* only for tiles that ship with workshop/)
    await expect(installer.prepare({ repo: repo.dir, commit: repo.commit({ backend: { entry: 'b.mjs', ops: ['x'] } }) })).rejects.toThrow(/trusted tier/)
    expect(readdirSync(join(root, 'staging'))).toEqual([])
  })

  it('holds the clone to what the index listed', async () => {
    const { installer, repo } = setup()
    const c = repo.commit({ permissions: { storage: true, net: ['evil.example.com'] } })
    await expect(installer.prepare({ repo: repo.dir, commit: c, expect: { id: 'focus', permissions: { storage: true } } })).rejects.toThrow(/more than the index lists \(net:evil\.example\.com\)/)
    await expect(installer.prepare({ repo: repo.dir, commit: c, expect: { id: 'other', permissions: {} } })).rejects.toThrow(/index lists "other"/)
  })

  it('refuses a commit that is not in the repo, a short commit, and an http repo', async () => {
    const { installer, repo } = setup()
    repo.commit()
    await expect(installer.prepare({ repo: repo.dir, commit: 'b'.repeat(40) })).rejects.toThrow(/could not fetch/)
    await expect(installer.prepare({ repo: repo.dir, commit: 'abc1234' })).rejects.toThrow(/40 hex/)
    const remote = new Installer({ tilesDir: '/x', stagingDir: '/y', takenBy: () => null })
    await expect(remote.prepare({ repo: 'http://example.com/x', commit: 'a'.repeat(40) })).rejects.toThrow(/https/)
    await expect(remote.prepare({ repo: repo.dir, commit: 'a'.repeat(40) })).rejects.toThrow(/https/)
  })

  it('runs nothing from the repo: its hooks are never installed and symlinks come out as plain files', async () => {
    const { installer, repo } = setup()
    symlinkSync('/etc/hosts', join(repo.dir, 'hosts'))
    const c = repo.commit({}, { '.githooks/post-checkout': '#!/bin/sh\ntouch /tmp/ws-hook-ran\n' })
    const done = await installer.confirm((await installer.prepare({ repo: repo.dir, commit: c })).token)
    expect(existsSync(join(done.folder, '.git'))).toBe(false)
    expect(existsSync('/tmp/ws-hook-ran')).toBe(false)
    expect(lstatSync(join(done.folder, 'hosts')).isFile()).toBe(true)
    expect(readFileSync(join(done.folder, 'hosts'), 'utf8')).toBe('/etc/hosts')
  })

  it('removes only a folder it installed', async () => {
    const { root, installer, repo } = setup()
    await installer.confirm((await installer.prepare({ repo: repo.dir, commit: repo.commit() })).token)
    await installer.remove('focus')
    expect(existsSync(join(root, 'tiles', 'focus'))).toBe(false)
    await expect(installer.remove('focus')).rejects.toThrow(/not an installed tile/)
    await expect(installer.remove('../etc')).rejects.toThrow(/not an installed tile/)
  })

  it('a second repo cannot take an installed tile\'s id', async () => {
    const { root, installer, repo } = setup()
    await installer.confirm((await installer.prepare({ repo: repo.dir, commit: repo.commit() })).token)
    const other = tileRepo(join(root, 'other'), { id: 'focus', name: 'Not focus' })
    await expect(installer.prepare({ repo: other.dir, commit: other.commit() })).rejects.toThrow(/already installed from/)
  })
})
