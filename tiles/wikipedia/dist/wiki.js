// The Wikipedia tile's rules, kept apart from the page so vitest can run them as shipped: URLs,
// what the feeds' answers become, the picture cycle's order, the weather words, and the places
// list. Nothing here touches the DOM, the network or `window.workshop`.

export const WIKI = 'https://en.wikipedia.org'
export const FORECAST = 'https://api.open-meteo.com/v1/forecast'
export const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'

/** A new picture every so often: today's, then two from the archive, then today's again. */
export const CYCLE_MS = 2 * 60 * 1000
export const TODAY_EVERY = 3
export const PLACES_MAX = 6

/** The featured feed's `image` is there for days from about here on; earlier days come back empty. */
const ARCHIVE_FROM = Date.UTC(2016, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000

export const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/**
 * Wikimedia encodes a thumbnail's width in its path and serves only some widths (250, 330, 500,
 * 960, 1280, 1920; 640, 800, 1024 and 1200 are HTTP 400), so never pick one off that list. The
 * search endpoint hands out protocol-relative 60px ones with a tracking query; both are dropped.
 */
export const thumb = (url, width) =>
  String(url).replace(/^\/\//, 'https://').replace(/\?.*$/, '').replace(/\/\d+px-/, `/${width}px-`)

/** Local YYYY-MM-DD. */
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A random local day between ARCHIVE_FROM and yesterday. `rand` is Math.random, or a test's. */
export function randomPastDay(now = new Date(), rand = Math.random) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const span = Math.max(1, Math.floor((yesterday.getTime() - ARCHIVE_FROM) / DAY_MS))
  const back = Math.floor(rand() * span)
  return ymd(new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() - back))
}

/** Which picture the cycle's n-th step asks for (counting from 0): today's every third time. */
export const whenFor = (step) => (step % TODAY_EVERY === 0 ? 'today' : 'past')

export const featuredUrl = (date) => `${WIKI}/api/rest_v1/feed/featured/${date.replace(/-/g, '/')}`

/** The featured feed's answer for `date` as the tile's picture, or null when that day has none. */
export function pictureFrom(feed, date, today) {
  const img = feed?.image
  if (!img?.thumbnail?.source || !img.file_page) return null
  const name = String(img.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
  return {
    date,
    today,
    title: strip(img.description?.text) || name,
    credit: strip(img.artist?.text),
    imageUrl: thumb(img.thumbnail.source, 960),
    largeUrl: thumb(img.thumbnail.source, 1920),
    url: img.file_page
  }
}

export const searchUrl = (q) => `${WIKI}/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=12`

export function hitsFrom(data) {
  return (data?.pages ?? []).map((p) => ({
    key: p.key,
    title: p.title,
    description: strip(p.description),
    excerpt: strip(p.excerpt),
    imageUrl: p.thumbnail?.url ? thumb(p.thumbnail.url, 250) : null,
    url: `${WIKI}/wiki/${encodeURIComponent(p.key)}`
  }))
}

/** An article's key from what a person or a session typed: "Red fox" and "Red_fox" are one page. */
export const articleKey = (text) => String(text ?? '').trim().replace(/\s+/g, '_')

export const summaryUrl = (key) => `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(articleKey(key))}`

export function summaryFrom(s, key) {
  return {
    key: s?.titles?.canonical || articleKey(key),
    title: strip(s?.displaytitle) || s?.title || String(key).replace(/_/g, ' '),
    description: strip(s?.description),
    extract: String(s?.extract ?? '').trim(),
    imageUrl: s?.thumbnail?.source ? thumb(s.thumbnail.source, 960) : null,
    url: s?.content_urls?.desktop?.page ?? `${WIKI}/wiki/${encodeURIComponent(articleKey(key))}`
  }
}

// ---- weather (Open-Meteo, which needs no key)

/** A WMO weather code as a glyph (text presentation, so it takes the text's colour) and a word. */
export function look(code, day) {
  const g = (glyph, label) => ({ glyph: `${glyph}︎`, label })
  if (code === 0) return g(day ? '☀' : '☾', 'Clear')
  if (code === 1) return g(day ? '☀' : '☾', 'Mostly clear')
  if (code === 2) return g('⛅', 'Partly cloudy')
  if (code === 3) return g('☁', 'Overcast')
  if (code === 45 || code === 48) return g('≋', 'Fog')
  if (code >= 51 && code <= 55) return g('☂', 'Drizzle')
  if (code === 56 || code === 57) return g('☂', 'Freezing drizzle')
  if (code === 61) return g('☂', 'Light rain')
  if (code === 63) return g('☂', 'Rain')
  if (code === 65) return g('☂', 'Heavy rain')
  if (code === 66 || code === 67) return g('☂', 'Freezing rain')
  if (code === 71) return g('❄', 'Light snow')
  if (code === 73) return g('❄', 'Snow')
  if (code === 75) return g('❄', 'Heavy snow')
  if (code === 77) return g('❄', 'Snow grains')
  if (code >= 80 && code <= 82) return g('☂', 'Showers')
  if (code === 85 || code === 86) return g('❄', 'Snow showers')
  if (code >= 95) return g('⚡', 'Thunderstorm')
  return g('·', '')
}

export const deg = (n) => (n === null || n === undefined ? '–' : `${n}°`)

/** Fahrenheit where the locale's country uses it, Celsius everywhere else. */
export function defaultUnit(locale) {
  const region = String(locale ?? '').split(/[-_]/)[1]?.toUpperCase()
  return ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'].includes(region) ? 'F' : 'C'
}

export const cleanUnit = (u, locale) => (u === 'F' || u === 'C' ? u : defaultUnit(locale))

export const samePlace = (a, b) => a.lat === b.lat && a.lon === b.lon

/**
 * The saved places, from whatever storage held. `null` means none was ever saved (first run,
 * when the tile asks for a city); an empty list means the user chose none and is not asked again.
 */
export function cleanPlaces(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const p of raw) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) continue
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue
    const place = { name: p.name.trim().slice(0, 80), region: typeof p.region === 'string' ? p.region.slice(0, 80) : '', lat: p.lat, lon: p.lon }
    if (!out.some((x) => samePlace(x, place))) out.push(place)
  }
  return out.slice(0, PLACES_MAX)
}

export const addPlace = (list, p) => (list.some((x) => samePlace(x, p)) || list.length >= PLACES_MAX ? list : [...list, p])
export const removePlace = (list, p) => list.filter((x) => !samePlace(x, p))
export const leadPlace = (list, p) => [p, ...list.filter((x) => !samePlace(x, p))]

export function forecastUrl(places, unit) {
  const q = new URLSearchParams({
    latitude: places.map((p) => p.lat).join(','),
    longitude: places.map((p) => p.lon).join(','),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    forecast_days: '1',
    timezone: 'auto',
    temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
    wind_speed_unit: unit === 'F' ? 'mph' : 'kmh'
  })
  return `${FORECAST}?${q}`
}

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null)

/** Now, and today's high and low, for each place in order. One place comes back as an object, several as a list. */
export function weatherFrom(body, places, unit) {
  const list = Array.isArray(body) ? body : [body]
  return places.map((place, i) => {
    const f = list[i] ?? {}
    return {
      place,
      unit,
      temp: round(f.current?.temperature_2m),
      feels: round(f.current?.apparent_temperature),
      high: round(f.daily?.temperature_2m_max?.[0]),
      low: round(f.daily?.temperature_2m_min?.[0]),
      wind: round(f.current?.wind_speed_10m),
      code: f.current?.weather_code ?? -1,
      day: f.current?.is_day !== 0,
      timezone: f.timezone ?? '',
      utcOffset: f.utc_offset_seconds ?? 0
    }
  })
}

/**
 * The geocoder matches the name alone, so "Lisbon, Portugal" searches "Lisbon"; what comes after
 * the comma puts the hits whose region or country match it first. Null when there is too little to ask.
 */
export function geocodeQuery(query) {
  const [name, ...rest] = String(query).split(',').map((s) => s.trim()).filter(Boolean)
  if (!name || name.length < 2) return null
  return { url: `${GEOCODE}?${new URLSearchParams({ name, count: '10', language: 'en', format: 'json' })}`, want: rest.join(' ').toLowerCase() }
}

export function placesFrom(data, want) {
  const hits = data?.results ?? []
  const score = (h) => {
    if (!want) return 0
    const words = [h.admin1, h.country, h.country_code].map((s) => String(s ?? '').toLowerCase())
    return words.some((w) => w === want) ? 0 : words.some((w) => w && (w.startsWith(want) || want.startsWith(w))) ? 1 : 2
  }
  return hits
    .filter((h) => h.name && typeof h.latitude === 'number' && typeof h.longitude === 'number')
    .map((h, i) => ({ h, i, s: score(h) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, PLACES_MAX + 2)
    .map(({ h }) => ({
      name: h.name,
      region: [h.admin1, h.country_code ?? h.country].filter(Boolean).join(', '),
      lat: Math.round(h.latitude * 1e4) / 1e4,
      lon: Math.round(h.longitude * 1e4) / 1e4
    }))
}

/** True when a place keeps a different clock from this machine (`offsetMin` is getTimezoneOffset()). */
export const otherClock = (row, offsetMin) => !!row.timezone && row.utcOffset !== -offsetMin * 60
