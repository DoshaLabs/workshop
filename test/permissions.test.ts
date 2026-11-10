import { describe, expect, it } from 'vitest'
import { needsAsking, permissionChange, permissionKeys, permissionWords } from '@shared/permissions'

describe('permissions in words', () => {
  it('says what a tile can do, what can leave the machine first', () => {
    const w = permissionWords({ storage: true, net: ['api.example.com'], transcripts: true, door: { ops: ['add', 'list'], timeoutMs: 1000 } })
    expect(w[0]).toMatch(/conversations/)
    expect(w[1]).toBe('reach api.example.com')
    expect(w).toContain('answer Claude sessions (add, list)')
    expect(w.at(-1)).toBe('keep its own data')
    expect(permissionWords({})).toEqual([])
  })

  it('puts full access to the Mac before everything else', () => {
    expect(permissionWords({ backend: true, transcripts: true })).toEqual(['run its own program with full access to this Mac', 'read your conversations with Claude'])
    expect(needsAsking({ storage: true }, { storage: true, backend: true })).toBe(true)
  })

  it('a door timeout is not a permission; its ops are', () => {
    expect(permissionKeys({ door: { ops: ['b', 'a'], timeoutMs: 1 } })).toEqual(permissionKeys({ door: { ops: ['a', 'b'], timeoutMs: 99 } }))
    expect(needsAsking({ door: { ops: ['a'], timeoutMs: 1 } }, { door: { ops: ['a'], timeoutMs: 5000 } })).toBe(false)
    expect(needsAsking({ door: { ops: ['a'], timeoutMs: 1 } }, { door: { ops: ['a', 'rm'], timeoutMs: 1 } })).toBe(true)
  })

  it('an update asks again only when it asks for more', () => {
    expect(needsAsking({ storage: true, notify: true }, { storage: true })).toBe(false)
    expect(needsAsking({ storage: true }, { storage: true, net: ['x.com'] })).toBe(true)
    expect(needsAsking({ sessions: 'read' }, { sessions: 'write' })).toBe(true)
    expect(needsAsking({ net: ['a.com'] }, { net: ['a.com', 'b.com'] })).toBe(true)
  })

  it('names what was added and what was dropped', () => {
    expect(permissionChange({ storage: true, notify: true, net: ['a.com'] }, { storage: true, net: ['a.com', 'b.com'], camera: true })).toEqual({
      added: ['reach b.com', 'use the camera'],
      removed: ['send you notifications']
    })
  })
})
