import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_MAX_BYTES, TileStore } from '../src/main/storage'

const fresh = (): { dir: string; store: TileStore } => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-store-'))
  return { dir, store: TileStore.forTile(dir, 't') }
}

describe('TileStore', () => {
  it('round-trips JSON and returns copies', async () => {
    const { store } = fresh()
    await store.set('a', { x: [1, 2] })
    const v = (await store.get('a')) as { x: number[] }
    v.x.push(3)
    expect(await store.get('a')).toEqual({ x: [1, 2] })
    expect(await store.get('missing')).toBeNull()
  })

  it('writes atomically to disk and leaves no temp file', async () => {
    const { dir, store } = fresh()
    await Promise.all([store.set('a', 1), store.set('b', 2), store.set('c', 3)])
    expect(JSON.parse(readFileSync(join(dir, 't', 'store.json'), 'utf8'))).toEqual({ a: 1, b: 2, c: 3 })
    expect(readdirSync(join(dir, 't'))).toEqual(['store.json'])
    const again = TileStore.forTile(dir, 't')
    expect(await again.get('b')).toBe(2)
  })

  it('removes a key set to null', async () => {
    const { store } = fresh()
    await store.set('a', 1)
    await store.set('a', null)
    expect(await store.get('a')).toBeNull()
  })

  it('refuses bad keys and an overfull store, and keeps going after', async () => {
    const { store } = fresh()
    await expect(store.set('', 1)).rejects.toThrow()
    await expect(store.set('big', 'x'.repeat(STORE_MAX_BYTES))).rejects.toThrow()
    await store.set('ok', true)
    expect(await store.get('ok')).toBe(true)
    expect(await store.get('big')).toBeNull()
  })
})

describe('TileStore over a store it cannot read', () => {
  const broken = (contents: string): { dir: string; store: TileStore } => {
    const { dir, store } = fresh()
    mkdirSync(join(dir, 't'))
    writeFileSync(join(dir, 't', 'store.json'), contents)
    return { dir, store }
  }
  const asideIn = (dir: string): string[] => readdirSync(join(dir, 't')).filter((f) => f.startsWith('store.json.broken-'))

  it('moves a file that is not JSON aside, keeps its bytes, and starts empty', async () => {
    const { dir, store } = broken('{"a": 1, "b": [tru')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await store.get('a')).toBeNull()
    await store.set('c', 3)
    const aside = asideIn(dir)
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, 't', aside[0]), 'utf8')).toBe('{"a": 1, "b": [tru')
    expect(JSON.parse(readFileSync(join(dir, 't', 'store.json'), 'utf8'))).toEqual({ c: 3 })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('broken-')
    warn.mockRestore()
  })

  it('moves valid JSON that is not an object aside too', async () => {
    for (const contents of ['[1, 2, 3]', '"text"', 'null', '42']) {
      const { dir, store } = broken(contents)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await store.set('k', 'v')
      expect(asideIn(dir).map((f) => readFileSync(join(dir, 't', f), 'utf8'))).toEqual([contents])
      expect(await store.get('k')).toBe('v')
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    }
  })

  it('moves it once, however many calls arrive together', async () => {
    const { dir, store } = broken('not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await Promise.all([store.get('a'), store.get('b'), store.set('c', 1), store.set('d', 2)])
    expect(asideIn(dir)).toHaveLength(1)
    expect(await store.get('d')).toBe(2)
    warn.mockRestore()
  })

  it('leaves a missing store alone: empty, nothing moved', async () => {
    const { dir, store } = fresh()
    expect(await store.get('a')).toBeNull()
    await store.set('a', 1)
    expect(readdirSync(join(dir, 't'))).toEqual(['store.json'])
  })
})
