// The smoke run's stand-in for the internet. The Wikipedia tile's whole job is fetching from
// Wikipedia and Open-Meteo, and smoke used to let it: two outside services had to be up, quick and
// willing (several smoke runs at once is a lot of requests), or the run failed for reasons that
// had nothing to do with workshop. Now a smoke run answers those hosts itself, inside the tile's
// own session, from the canned answers below. The tile's request filter still runs first
// (tiles.ts), so "a declared host gets through" is still what the checks see; a host the tile did
// not declare is answered with nothing here too.
//
// WORKSHOP_LIVE_NET=1 turns this off: the same run against the real services.

import type { Session } from 'electron'
import { deflateSync } from 'node:zlib'
import type { Tile } from './tiles'

/** The tiles whose requests are answered here. Every other tile's go where its filter lets them. */
const STAND_IN_FOR = new Set(['wikipedia'])

// ---- a picture ------------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A plain test pattern (bands of colour), w × h, as a PNG: a real picture the page can decode. */
export function testPattern(w: number, h: number): Buffer {
  const bands = [
    [0x2b, 0x4c, 0x7e],
    [0x56, 0x7e, 0xbb],
    [0xe8, 0xa8, 0x38],
    [0xd2, 0x5c, 0x3c],
    [0x3c, 0x8d, 0x6e]
  ]
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = bands[Math.floor((x / w) * bands.length)]
      row.set([r, g, b], 1 + x * 3)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

const PICTURE = testPattern(320, 200)

// ---- the canned answers -----------------------------------------------------------------------

const UPLOAD = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00'
const thumbOf = (name: string, width = 640): string => `${UPLOAD}/${name}.png/${width}px-${name}.png`
const title = (key: string): string => decodeURIComponent(key).replace(/_/g, ' ')

/** The featured feed for a day: every day has a picture, named for its date. */
const featured = (y: string, m: string, d: string): unknown => ({
  image: {
    title: `File:Smoke test pattern ${y}-${m}-${d}.png`,
    thumbnail: { source: thumbOf(`Smoke_${y}${m}${d}`) },
    file_page: `https://commons.wikimedia.org/wiki/File:Smoke_${y}${m}${d}.png`,
    description: { text: `A test pattern, the picture for <b>${y}-${m}-${d}</b>` },
    artist: { text: 'workshop smoke' }
  }
})

const summary = (key: string): unknown => ({
  title: title(key),
  displaytitle: title(key),
  titles: { canonical: decodeURIComponent(key) },
  description: `${title(key)}, as the smoke run tells it`,
  extract: `${title(key)} is an article the smoke run made up, so no test depends on Wikipedia being there.`,
  thumbnail: { source: thumbOf(`Smoke_${decodeURIComponent(key)}`, 320) },
  content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${key}` } }
})

const search = (q: string): unknown => {
  const words = q.trim().split(/\s+/).filter(Boolean)
  const name = words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ') || 'Nothing'
  return {
    pages: [name, `${name} (disambiguation)`].map((t) => ({
      key: t.replace(/ /g, '_'),
      title: t,
      description: `${t}, a made-up hit`,
      excerpt: `<span class="searchmatch">${t}</span> from the smoke run`,
      thumbnail: { url: `//upload.wikimedia.org/wikipedia/commons/thumb/0/00/Smoke.png/60px-Smoke.png` }
    }))
  }
}

const PLACES = [
  { name: 'Lisbon', latitude: 38.7167, longitude: -9.1333, admin1: 'Lisbon', country: 'Portugal', country_code: 'PT', timezone: 'Europe/Lisbon' },
  { name: 'Lisbon', latitude: 44.0306, longitude: -70.1048, admin1: 'Maine', country: 'United States', country_code: 'US', timezone: 'America/New_York' },
  { name: 'Portland', latitude: 43.6615, longitude: -70.2553, admin1: 'Maine', country: 'United States', country_code: 'US', timezone: 'America/New_York' }
]

const geocode = (name: string, count: number): unknown => {
  const hits = PLACES.filter((p) => p.name.toLowerCase().startsWith(name.trim().toLowerCase()))
  return hits.length ? { results: hits.slice(0, Math.max(1, count)) } : {}
}

const forecast = (lats: string[]): unknown => {
  const one = (i: number) => ({
    latitude: Number(lats[i]),
    timezone: 'Europe/Lisbon',
    utc_offset_seconds: 0,
    current: { temperature_2m: 18.4 + i, apparent_temperature: 17.6 + i, wind_speed_10m: 12, weather_code: 2, is_day: 1 },
    daily: { temperature_2m_max: [21.2 + i], temperature_2m_min: [12.8 + i] }
  })
  return lats.length === 1 ? one(0) : lats.map((_, i) => one(i))
}

/** What a stand-in host answers for this URL, or null (a 404). */
export function cannedAnswer(url: URL): { type: string; body: Buffer | string } | null {
  const json = (v: unknown) => ({ type: 'application/json', body: JSON.stringify(v) })
  if (url.hostname === 'en.wikipedia.org') {
    let m = /^\/api\/rest_v1\/feed\/featured\/(\d{4})\/(\d{2})\/(\d{2})$/.exec(url.pathname)
    if (m) return json(featured(m[1], m[2], m[3]))
    m = /^\/api\/rest_v1\/page\/summary\/([^/]+)$/.exec(url.pathname)
    if (m) return json(summary(m[1]))
    if (url.pathname === '/w/rest.php/v1/search/page') return json(search(url.searchParams.get('q') ?? ''))
    return null
  }
  if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') return /\.png$/i.test(url.pathname) ? { type: 'image/png', body: PICTURE } : null
  if (url.hostname === 'geocoding-api.open-meteo.com' && url.pathname === '/v1/search') return json(geocode(url.searchParams.get('name') ?? '', Number(url.searchParams.get('count') ?? 10)))
  if (url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast') return json(forecast((url.searchParams.get('latitude') ?? '0').split(',')))
  return null
}

/** Arms one tile session (tiles.ts calls this after the request filter): its https answered from above. */
export function smokeNet(tile: Pick<Tile, 'manifest'>, ses: Session): void {
  if (!STAND_IN_FOR.has(tile.manifest.id)) return
  const declared = new Set(tile.manifest.permissions.net ?? [])
  if (ses.protocol.isProtocolHandled('https')) ses.protocol.unhandle('https')
  ses.protocol.handle('https', (req) => {
    const url = new URL(req.url)
    // The filter has already refused anything undeclared; this never answers one either.
    const a = declared.has(url.hostname) ? cannedAnswer(url) : null
    if (!a) return new Response('not in the smoke run', { status: 404 })
    return new Response(typeof a.body === 'string' ? a.body : new Uint8Array(a.body), {
      headers: { 'Content-Type': a.type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    })
  })
}
