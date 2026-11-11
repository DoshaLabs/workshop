import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexReader, readCapped } from '../src/main/index-read'
import { DEFAULT_INDEX, INDEX_MAX_BYTES, indexSource } from '../src/shared/tile-index'

const entry = { id: 'pomodoro', name: 'Pomodoro', author: 'DoshaLabs', hint: 'A timer', repo: 'https://github.com/DoshaLabs/workshop-pomodoro', commit: 'c9e06e7ddb599cf0c40ee287757f13b3c9b1ec3b', version: '0.1.1', permissions: { storage: true, notify: true }, category: 'tools' }
const URL = 'https://raw.githubusercontent.com/DoshaLabs/workshop-index/main/tiles.json'

/** A Response whose body arrives in chunks and says nothing about its length. */
function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close() } }), init)
}

describe('the index address', () => {
  it('is WORKSHOP_INDEX, else settings, else DoshaLabs\' own; never the network in a smoke run', () => {
    expect(indexSource({})).toEqual({ source: DEFAULT_INDEX, fromEnv: false })
    expect(DEFAULT_INDEX).toBe(URL)
    expect(indexSource({ setting: 'https://a.example/tiles.json' })).toEqual({ source: 'https://a.example/tiles.json', fromEnv: false })
    expect(indexSource({ env: '/tmp/tiles.json', setting: 'https://a.example/tiles.json' })).toEqual({ source: '/tmp/tiles.json', fromEnv: true })
    expect(indexSource({ smoke: true })).toEqual({ source: null, fromEnv: false })
    expect(indexSource({ smoke: true, env: '/tmp/x.json' }).source).toBe('/tmp/x.json')
  })
})

describe('reading the index', () => {
  it('reads and checks an https index, and keeps it a minute', async () => {
    let calls = 0
    let t = 0
    const r = new IndexReader(async () => (calls++, streamed([JSON.stringify([entry]).slice(0, 50), JSON.stringify([entry]).slice(50)])), () => t)
    const s = await r.read(URL)
    expect(s.problem).toBeNull()
    expect(s.entries.map((e) => e.id)).toEqual(['pomodoro'])
    await r.read(URL)
    expect(calls).toBe(1)
    t += 61_000
    await r.read(URL)
    expect(calls).toBe(2)
    await r.read(URL, false, true)
    expect(calls).toBe(3)
  })

  it('refuses a body past the cap, said up front or not', async () => {
    const big = 'x'.repeat(INDEX_MAX_BYTES / 4)
    await expect(readCapped(streamed([big, big, big, big, 'xx']), INDEX_MAX_BYTES)).rejects.toThrow(/larger/)
    await expect(readCapped(new Response('[]', { headers: { 'content-length': String(INDEX_MAX_BYTES + 1) } }), INDEX_MAX_BYTES)).rejects.toThrow(/larger/)
    const s = await new IndexReader(async () => streamed([big, big, big, big, 'xx'])).read(URL)
    expect(s.problem).toMatch(/larger than an index may be/)
  })

  it('says why it could not read: a status, no network, a timeout, not JSON; and never keeps a failure', async () => {
    expect((await new IndexReader(async () => new Response('nope', { status: 404, statusText: 'Not Found' })).read(URL)).problem).toBe('could not read the index: raw.githubusercontent.com answered 404 Not Found')
    const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    expect((await new IndexReader(async () => Promise.reject(offline)).read(URL)).problem).toMatch(/could not reach raw\.githubusercontent\.com/)
    const slow = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    expect((await new IndexReader(async () => Promise.reject(slow)).read(URL)).problem).toMatch(/did not answer in 10 s/)
    let n = 0
    const flaky = new IndexReader(async () => (n++ === 0 ? new Response('<html>', { status: 200 }) : streamed([JSON.stringify([entry])])))
    expect((await flaky.read(URL)).problem).toMatch(/not JSON/)
    expect((await flaky.read(URL)).entries).toHaveLength(1)
  })

  it('reads a local file every time, and refuses anything but https or a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'index-'))
    const file = join(dir, 'tiles.json')
    await writeFile(file, JSON.stringify([]))
    const r = new IndexReader(async () => {
      throw new Error('no network for a file')
    })
    expect((await r.read(file, true)).entries).toEqual([])
    await writeFile(file, JSON.stringify([{ ...entry, repo: '/some/repo' }]))
    expect((await r.read(`file://${file}`, true)).entries.map((e) => e.repo)).toEqual(['/some/repo'])
    expect((await r.read('http://example.com/tiles.json')).problem).toMatch(/https URL or a file/)
    expect(await r.read(null)).toEqual({ source: null, fromEnv: false, entries: [], errors: [], problem: null })
  })
})
