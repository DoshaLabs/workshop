import { describe, expect, it } from 'vitest'
import { checkEntry, checkIndex, repoAllowed } from '@shared/tile-index'

const C = 'a'.repeat(40)
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'focus-timer',
  name: 'Focus timer',
  author: 'someone',
  hint: '25 minutes on',
  repo: 'https://github.com/someone/workshop-focus-timer',
  commit: C,
  version: '0.2.0',
  permissions: { storage: true, notify: true },
  category: 'tools',
  ...over
})

describe('the tile index', () => {
  it('reads a good entry, with its permissions checked by the manifest validator', () => {
    const r = checkEntry(entry({ permissions: { net: ['api.example.com'], door: { ops: ['start'] } } }))
    expect(r).toMatchObject({ ok: true, entry: { id: 'focus-timer', permissions: { net: ['api.example.com'], door: { ops: ['start'], timeoutMs: 10000 } } } })
  })

  it('fills in what may be left out: hint and category', () => {
    const { hint: _h, category: _c, ...rest } = entry()
    expect(checkEntry(rest)).toMatchObject({ ok: true, entry: { hint: '', category: 'other' } })
  })

  it('refuses a short or uppercase commit, a bad version, an unknown category or field', () => {
    for (const bad of [{ commit: 'abc1234' }, { commit: C.toUpperCase() }, { version: 'one' }, { category: 'crypto' }, { stars: 5 }]) {
      expect(checkEntry(entry(bad)).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('refuses a permission the manifest does not know, and the trusted tier', () => {
    expect(checkEntry(entry({ permissions: { root: true } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('permissions.root')] })
    const r = checkEntry(entry({ permissions: { backend: true } }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.join()).toMatch(/trusted tier/)
  })

  it('takes only https repos, unless the index itself is a local file', () => {
    expect(repoAllowed('https://github.com/a/b')).toBe(true)
    expect(repoAllowed('http://github.com/a/b')).toBe(false)
    expect(repoAllowed('git@github.com:a/b.git')).toBe(false)
    expect(repoAllowed('file:///tmp/x')).toBe(false)
    expect(repoAllowed('file:///tmp/x', { local: true })).toBe(true)
    expect(repoAllowed('/tmp/x', { local: true })).toBe(true)
    expect(checkEntry(entry({ repo: '/tmp/x' })).ok).toBe(false)
    expect(checkEntry(entry({ repo: '/tmp/x' }), { local: true }).ok).toBe(true)
  })

  it('drops a bad entry and a second one with the same id, keeping the rest', () => {
    const r = checkIndex([entry(), entry({ id: 'Bad Id' }), entry({ name: 'again' }), entry({ id: 'other' })])
    expect(r.entries.map((e) => e.id)).toEqual(['focus-timer', 'other'])
    expect(r.errors).toHaveLength(2)
    expect(r.errors[1]).toMatch(/listed twice/)
  })

  it('wants an array', () => {
    expect(checkIndex({ tiles: [] })).toEqual({ entries: [], errors: ['tiles.json must be a JSON array of entries'] })
  })
})
