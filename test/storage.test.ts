import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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
