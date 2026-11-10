// `workshop.storage`: one JSON store per tile, kept and written by main (a tile never touches the
// file system). A store is a flat map of keys to JSON values. Writes are atomic (a temp file
// renamed over the old one) and serialized per tile, so a crash mid-write leaves the last good
// store, never half of one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The most a tile may keep, serialized. A store is settings and lists, not a database. */
export const STORE_MAX_BYTES = 5 * 1024 * 1024
export const KEY_MAX = 200

export class TileStore {
  private data: Record<string, unknown> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  static forTile(dataDir: string, id: string): TileStore {
    return new TileStore(join(dataDir, id, 'store.json'))
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.data) return this.data
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      this.data = {}
    }
    return this.data
  }

  async get(key: string): Promise<unknown> {
    checkKey(key)
    const v = (await this.load())[key]
    return v === undefined ? null : JSON.parse(JSON.stringify(v))
  }

  /** `null` (or undefined) removes the key. Rejects a value that is not plain JSON or would overfill the store. */
  async set(key: string, value: unknown): Promise<void> {
    checkKey(key)
    const json = value === undefined ? undefined : JSON.stringify(value)
    if (json !== undefined && json.length > STORE_MAX_BYTES) throw new Error('storage: value too large')
    const run = async (): Promise<void> => {
      const data = await this.load()
      const next = { ...data }
      if (json === undefined || value === null) delete next[key]
      else next[key] = JSON.parse(json)
      const out = JSON.stringify(next)
      if (Buffer.byteLength(out) > STORE_MAX_BYTES) throw new Error(`storage: the store would pass ${STORE_MAX_BYTES / 1024 / 1024} MB`)
      await mkdir(join(this.file, '..'), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, out, { mode: 0o600 })
      await rename(tmp, this.file)
      this.data = next
    }
    const p = this.chain.then(run)
    this.chain = p.catch(() => {})
    return p
  }
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX) throw new Error(`storage: a key is a string of 1 to ${KEY_MAX} characters`)
}
