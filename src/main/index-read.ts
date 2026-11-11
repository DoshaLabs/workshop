// Reading the tile index (tiles.json) for the + menu's Marketplace tab: over https from main, or
// from a file on this Mac. No tile and no sandbox is involved: this is core's own request. It has a
// timeout, reads at most INDEX_MAX_BYTES however the server describes the body, and keeps an https
// answer for a minute, so the tab opening and every tile turned on or off do not each go to GitHub.
// No electron here, so the unit tests drive it with a stand-in fetch.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { INDEX_MAX_BYTES, checkIndex } from '../shared/tile-index'
import type { IndexState } from '../shared/tile-menu'

const TIMEOUT_MS = 10_000
const KEEP_MS = 60_000

export const isLocalIndex = (src: string | null): boolean => !!src && (src.startsWith('/') || src.startsWith('file:'))

type Fetch = (url: string, init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }) => Promise<Response>

/** The body as text, refused past `max` bytes (whatever content-length says, or does not say). */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('larger than an index may be')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('larger than an index may be')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Why a fetch failed, in words: node's own is "fetch failed" with the reason one level down. */
function why(err: unknown, url: string): string {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `${new URL(url).host} did not answer in ${TIMEOUT_MS / 1000} s`
  const code = e?.cause?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ENETUNREACH') return `could not reach ${new URL(url).host} (offline?)`
  return e?.cause?.message ?? e?.message ?? String(err)
}

export class IndexReader {
  private kept: { source: string; at: number; state: IndexState } | null = null

  constructor(private readonly fetcher: Fetch = fetch as unknown as Fetch, private readonly now: () => number = Date.now) {}

  /** Reads and checks the index. Never throws: a problem is part of the answer, for the tab to show. `fresh` skips the minute's cache. */
  async read(source: string | null, fromEnv = false, fresh = false): Promise<IndexState> {
    const state: IndexState = { source, fromEnv, entries: [], errors: [], problem: null }
    if (!source) return state
    const https = source.startsWith('https://')
    if (https && !fresh && this.kept?.source === source && this.now() - this.kept.at < KEEP_MS) return { ...this.kept.state, fromEnv }
    let text: string
    try {
      if (https) {
        let res: Response
        try {
          res = await this.fetcher(source, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: 'application/json, text/plain' } })
        } catch (err) {
          throw new Error(why(err, source))
        }
        if (!res.ok) throw new Error(`${new URL(source).host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
        text = await readCapped(res, INDEX_MAX_BYTES)
      } else if (isLocalIndex(source)) {
        text = await readFile(source.startsWith('file:') ? fileURLToPath(source) : source, 'utf8')
        if (Buffer.byteLength(text) > INDEX_MAX_BYTES) throw new Error('larger than an index may be')
      } else throw new Error('an index is an https URL or a file on this Mac')
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new Error('it is not JSON')
      }
      const checked = checkIndex(raw, { local: isLocalIndex(source) })
      state.entries = checked.entries
      state.errors = checked.errors
    } catch (err) {
      state.problem = `could not read the index: ${(err as Error).message}`
      return state
    }
    if (https) this.kept = { source, at: this.now(), state }
    return state
  }
}
