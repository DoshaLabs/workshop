import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TileGrants } from '../src/main/files'

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-files-')))
  const games = join(base, 'games')
  mkdirSync(join(games, 'gb'), { recursive: true })
  writeFileSync(join(games, 'gb', 'a.gb'), 'rom')
  writeFileSync(join(base, 'secret.txt'), 'no')
  symlinkSync(join(base, 'secret.txt'), join(games, 'escape.txt'))
  symlinkSync(join(games, 'gb', 'a.gb'), join(games, 'alias.gb'))
  return { base, games, grants: TileGrants.forTile(join(base, 'data'), 't') }
}

describe('TileGrants', () => {
  it('grants a picked folder, by handle, without the path', async () => {
    const { games, grants } = setup()
    const g = await grants.add(games)
    expect(TileGrants.public(g)).toEqual({ handle: g.handle, name: 'games', kind: 'folder' })
    expect((await grants.add(games)).handle).toBe(g.handle)
  })

  it('resolves inside the grant only', async () => {
    const { games, grants } = setup()
    const { handle } = await grants.add(games)
    expect((await grants.resolve(handle, 'gb/a.gb'))?.path).toBe(join(games, 'gb', 'a.gb'))
    expect(await grants.resolve(handle, '../secret.txt')).toBeNull()
    expect(await grants.resolve(handle, '/etc/hosts')).not.toMatchObject({ path: '/etc/hosts' })
    expect(await grants.resolve(handle, 'escape.txt')).toBeNull()
    expect((await grants.resolve(handle, 'alias.gb'))?.path).toBe(join(games, 'gb', 'a.gb'))
    expect(await grants.resolve('nope', 'gb/a.gb')).toBeNull()
  })

  it('lists a folder, leaving out what points outside', async () => {
    const { games, grants } = setup()
    const { handle } = await grants.add(games)
    expect(await grants.entries(handle, '')).toEqual([
      { name: 'gb', kind: 'folder', size: 0 },
      { name: 'alias.gb', kind: 'file', size: 3 }
    ])
    await expect(grants.entries(handle, '..')).rejects.toThrow()
  })

  it('a file grant answers only for that file', async () => {
    const { games, grants } = setup()
    const { handle } = await grants.add(join(games, 'gb', 'a.gb'))
    expect(await grants.resolve(handle, '')).not.toBeNull()
    expect(await grants.resolve(handle, 'x')).toBeNull()
  })

  it('remembers grants across restarts, and forgets on request', async () => {
    const { base, games, grants } = setup()
    const { handle } = await grants.add(games)
    const again = TileGrants.forTile(join(base, 'data'), 't')
    expect((await again.list()).map((g) => g.handle)).toEqual([handle])
    expect(await again.forget(handle)).toBe(true)
    expect(await again.resolve(handle, 'gb/a.gb')).toBeNull()
  })
})
