import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkManifest } from '@shared/manifest'
import { scaffoldTile, slug } from '../src/main/scaffold'

const TEMPLATE = resolve('template')

describe('scaffold', () => {
  it('makes a tile id out of any name', () => {
    expect(slug('Focus timer!')).toBe('focus-timer')
    expect(slug('  Café — Ünïcode  ')).toBe('cafe-unicode')
    expect(slug('!!!')).toBe('tile')
    expect(slug('x'.repeat(80))).toHaveLength(32)
  })

  it('the starter is a tile core accepts, named as asked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-scaffold-'))
    const made = await scaffoldTile(TEMPLATE, root, 'Focus "timer" <b>', 'Counts down 25 minutes', () => false)
    expect(made.id).toBe('focus-timer-b')
    const checked = checkManifest(JSON.parse(await readFile(join(made.folder, 'tile.json'), 'utf8')))
    expect(checked).toMatchObject({ ok: true, manifest: { id: 'focus-timer-b', name: 'Focus timer b', hint: 'Counts down 25 minutes', permissions: { storage: true } } })
    const page = await readFile(join(made.folder, 'dist/index.html'), 'utf8')
    expect(page).toContain('<title>Focus timer b</title>')
    expect(await readFile(join(made.folder, 'dist/tile.js'), 'utf8')).not.toContain('__')
    expect(await readFile(join(made.folder, 'CLAUDE.md'), 'utf8')).toContain('window.workshop')
  })

  it('never takes an id or a folder that is in use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-scaffold-'))
    const a = await scaffoldTile(TEMPLATE, root, 'Reminders', '', (id) => id === 'reminders')
    expect(a.id).toBe('reminders-2')
    const b = await scaffoldTile(TEMPLATE, root, 'Reminders', '', (id) => id === 'reminders')
    expect(b.id).toBe('reminders-3')
  })
})
