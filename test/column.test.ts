import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanColumn, DEFAULT_ORDER, firstColumn, legacyColumn, LEGACY_KEYS } from '@shared/column'
import { ordered } from '@shared/order'
import { SettingsStore, cleanSettings } from '../src/main/settings'

describe('cleanColumn', () => {
  it('keeps well-formed entries only, once each', () => {
    expect(
      cleanColumn({
        off: ['wikipedia', 'wikipedia', 'Bad Id', 7, 'probe.2'],
        extra: ['probe.2', 'probe.5', 'probe', '../x.2', 'probe.2'],
        spans: { wikipedia: 3, 'probe.2': 4, probe: 9, other: 1.5, 'x y': 2 }
      })
    ).toEqual({ off: ['wikipedia'], extra: ['probe.2'], spans: { wikipedia: 2, 'probe.2': 2, probe: 2 } })
  })
  it('null for what is not a column', () => {
    expect(cleanColumn(null)).toBeNull()
    expect(cleanColumn([])).toBeNull()
    expect(cleanColumn('x')).toBeNull()
    expect(cleanColumn({})).toEqual({ off: [], extra: [], spans: {} })
  })
})

describe('legacyColumn', () => {
  it('reads what the window kept in localStorage', () => {
    const store: Record<string, string> = { [LEGACY_KEYS.off]: '["reminders"]', [LEGACY_KEYS.extra]: '["probe.3"]', [LEGACY_KEYS.spans]: '{"wikipedia":2}' }
    expect(legacyColumn((k) => store[k] ?? null)).toEqual({ off: ['reminders'], extra: ['probe.3'], spans: { wikipedia: 2 } })
  })
  it('bad JSON or nothing at all is an empty column', () => {
    expect(legacyColumn((k) => (k === LEGACY_KEYS.off ? '{nope' : null))).toEqual({ off: [], extra: [], spans: {} })
  })
})

describe('settings: column', () => {
  it('absent until saved, then kept, and a bad one does not replace a good one', async () => {
    expect('column' in cleanSettings({})).toBe(false)
    const file = join(mkdtempSync(join(tmpdir(), 'ws-settings-')), 'settings.json')
    const s = new SettingsStore(file)
    expect(s.get().column).toBeUndefined()
    await s.patch({ column: { off: ['wikipedia'], extra: [], spans: { reminders: 2 } } })
    expect(JSON.parse(readFileSync(file, 'utf8')).column).toEqual({ off: ['wikipedia'], extra: [], spans: { reminders: 2 } })
    await s.patch({ column: 'junk' as never, theme: 'nord' })
    expect(new SettingsStore(file).get()).toMatchObject({ theme: 'nord', column: { off: ['wikipedia'] } })
  })
})

describe('firstColumn', () => {
  const catalog = ['git', 'reminders', 'wikipedia']
  it('puts Wikipedia at the top of a new profile', () => {
    const c = firstColumn({ off: [], extra: [], spans: {} })
    expect(c.order).toEqual([...DEFAULT_ORDER])
    expect(ordered(catalog, c.order ?? [])).toEqual(['wikipedia', 'git', 'reminders'])
  })
  it('leaves a profile that already had a column as it was', () => {
    const old = { off: ['git'], extra: [], spans: {} }
    expect(firstColumn(old)).toBe(old)
    expect(firstColumn({ off: [], extra: [], spans: {}, order: ['reminders'] }).order).toEqual(['reminders'])
  })
})
