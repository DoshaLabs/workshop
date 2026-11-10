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
  private loading: Promise<Record<string, unknown>> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  static forTile(dataDir: string, id: string): TileStore {
    return new TileStore(join(dataDir, id, 'store.json'))
  }

  private load(): Promise<Record<string, unknown>> {
    if (this.data) return Promise.resolve(this.data)
    // One read per store, however many calls arrive before it finishes (two reads of a bad file
    // would both try to move it aside).
    this.loading ??= this.read().then((d) => (this.data = d))
    return this.loading
  }

  /**
   * A missing file is an empty store. A file that cannot be read, or is not a JSON object, is
   * moved aside to `store.json.broken-<time>` and the store starts empty: starting empty over it
   * would let the next write destroy whatever it held. If it cannot even be moved, the store
   * refuses to work rather than write over it.
   */
  private async read(): Promise<Record<string, unknown>> {
    let why: string
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      why = `it holds ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}, not an object`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      why = err instanceof SyntaxError ? `it is not JSON: ${err.message}` : (err as Error).message
    }
    const aside = `${this.file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.file, aside)
    } catch (err) {
      this.loading = null
      throw new Error(`storage: ${this.file} could not be read (${why}) nor moved aside (${(err as Error).message})`)
    }
    console.warn(`[workshop] storage: ${this.file} could not be read (${why}); moved to ${aside}, starting empty`)
    return {}
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
