// The Wikipedia tile's rules, kept apart from the page so vitest can run them as shipped: URLs,
// what the feeds' answers become, the picture cycle's order, the weather words, and the places
// list. Nothing here touches the DOM, the network or `window.workshop`.

export const WIKI = 'https://en.wikipedia.org'
export const FORECAST = 'https://api.open-meteo.com/v1/forecast'
export const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'

/** A new picture every so often: today's first, then one from the archive each time. */
export const CYCLE_MS = 2 * 60 * 1000
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

/** The widths Wikimedia serves a thumbnail at, narrowest first (2560 is HTTP 400). */
export const WIDTHS = [250, 330, 500, 960, 1280, 1920]

/**
 * The narrowest served width that fills a box of `w` × `h` CSS pixels at `dpr` device pixels each:
 * `cover` crops to fill it (the tile), `contain` fits it whole (the pane, the lightbox). The
 * picture's own shape is its original's, 3:2 when unknown. Never more than 1920.
 */
export function widthFor(pic, w, h, dpr, fit) {
  const aspect = pic?.width > 0 && pic?.height > 0 ? pic.width / pic.height : 1.5
  const across = fit === 'cover' ? Math.max(w, h * aspect) : Math.min(w, h * aspect)
  const need = Math.ceil(across * (dpr > 0 ? dpr : 1))
  return WIDTHS.find((x) => x >= need) ?? WIDTHS[WIDTHS.length - 1]
}

/** Every width Wikimedia serves a thumbnail at: WIDTHS and 3840 (2560 is HTTP 400). */
export const SERVED = [...WIDTHS, 3840]

/** The fewest pixels a large picture may have on its short side: 1080p. */
export const SHARP_MIN = 1080

/**
 * The lightbox's picture (and what "crop & save" hands the viewer): one served width down from the
 * original, unless that copy is under 1080 on its short side, when the original itself. A picture
 * whose size the feed did not give comes at 1920.
 */
export function sharpUrl(pic) {
  if (!(pic.width > 0 && pic.height > 0)) return thumb(pic.thumbSource, 1920)
  const step = [...SERVED].reverse().find((x) => x < pic.width)
  const short = step ? Math.min(step, (step * pic.height) / pic.width) : 0
  if (short >= SHARP_MIN) return thumb(pic.thumbSource, step)
  return pic.fullUrl || thumb(pic.thumbSource, step ?? 1920)
}

/**
 * The picture's address at `width`. A thumbnail as wide as the original or wider is not served,
 * so a picture smaller than that comes as its original, which is then the smaller file anyway.
 */
export const imageAt = (pic, width) => (pic.width > 0 && width >= pic.width && pic.fullUrl ? pic.fullUrl : thumb(pic.thumbSource, width))

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

export const featuredUrl = (date) => `${WIKI}/api/rest_v1/feed/featured/${date.replace(/-/g, '/')}`

/** The featured feed's answer for `date` as the tile's picture, or null when that day has none. */
export function pictureFrom(feed, date, today) {
  const img = feed?.image
  if (!img?.thumbnail?.source || !img.file_page) return null
  const name = String(img.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
  const pic = {
    date,
    today,
    title: strip(img.description?.text) || name,
    credit: strip(img.artist?.text),
    thumbSource: thumb(img.thumbnail.source, 960),
    // The original, drawn only when someone asks for it (or when it is smaller than a thumbnail).
    fullUrl: img.image?.source ? String(img.image.source).replace(/\?.*$/, '') : null,
    width: Number(img.image?.width) || 0,
    height: Number(img.image?.height) || 0,
    url: img.file_page
  }
  return { ...pic, imageUrl: imageAt(pic, 960) }
}

export const COMMONS = 'https://commons.wikimedia.org'

/**
 * A day's picture straight from Commons' Picture of the Day template (Template:Potd/<date>, the
 * picture the featured feed's `image` is): about 2 KB in a fifth of a second, where the feed for a
 * day out of Wikipedia's cache is 300 KB and up to 3 s (measured 12 Nov 2026; the feed also carries
 * the news, the most read and on this day). Not en.wikipedia's Template:POTD, which picks its own
 * picture (Colin, 12 Nov 2026: keep Commons'). `origin=*` is the API's CORS for another origin.
 */
export const potdUrl = (date) =>
  `${COMMONS}/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=images` +
  `&titles=${encodeURIComponent(`Template:Potd/${date}`)}` +
  `&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiextmetadatafilter=ImageDescription%7CArtist&iiextmetadatalanguage=en&iiurlwidth=960`

/** The day's caption in English (Template:Potd/<date> (en)), as wikitext: about 500 bytes. */
export const potdCaptionUrl = (date) =>
  `${COMMONS}/w/api.php?action=query&format=json&formatversion=2&origin=*&prop=revisions&rvprop=content&rvslots=main` +
  `&titles=${encodeURIComponent(`Template:Potd/${date} (en)`)}`

/**
 * The caption out of that page: the first parameter of `{{Potd description|1=…|2=en|…}}` as plain
 * text, its links as their labels, its own templates dropped, its markup gone. '' if there is none.
 */
export function captionFromWikitext(src) {
  const s = String(src ?? '')
  const open = s.indexOf('{{')
  if (open < 0) return ''
  // The first top-level parameter of the outer template, counting [[ ]] and {{ }} so a link's or an
  // inner template's | does not end it.
  let depth = 0
  let start = -1
  let end = s.length
  for (let i = open + 2; i < s.length; i++) {
    const two = s.slice(i, i + 2)
    if (two === '{{' || two === '[[') {
      depth++
      i++
    } else if (two === '}}' || two === ']]') {
      if (depth === 0) {
        end = i
        break
      }
      depth--
      i++
    } else if (s[i] === '|' && depth === 0) {
      if (start >= 0) {
        end = i
        break
      }
      start = i + 1
    }
  }
  if (start < 0) return ''
  let text = s.slice(start, end).replace(/^\s*1\s*=/, '')
  for (let k = 0; k < 5 && /\{\{[^{}]*\}\}/.test(text); k++) text = text.replace(/\{\{[^{}]*\}\}/g, '')
  text = text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[:?([^\]]*)\]\]/g, (_, t) => t.replace(/^(?:[a-z-]+:|Category:)+/i, ''))
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/'{2,}/g, '')
  return strip(text)
}

/**
 * The template query's answer as the tile's picture (the same shape as pictureFrom), or null when
 * that day has none. A template may use more than one file; the largest is the picture. `caption`
 * (captionFromWikitext) is the title, as the feed's is; else the file's own description.
 */
export function pictureFromQuery(data, date, today, caption = '') {
  let best = null
  for (const page of data?.query?.pages ?? []) {
    const ii = page?.imageinfo?.[0]
    if (!ii?.thumburl || !ii.descriptionurl) continue
    const area = (Number(ii.width) || 0) * (Number(ii.height) || 0)
    if (!best || area > best.area) best = { page, ii, area }
  }
  if (!best) return null
  const { page, ii } = best
  const name = String(page.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
  const meta = ii.extmetadata ?? {}
  const pic = {
    date,
    today,
    title: caption || strip(meta.ImageDescription?.value) || name,
    credit: strip(meta.Artist?.value),
    thumbSource: thumb(ii.thumburl, 960),
    fullUrl: ii.url ? String(ii.url).replace(/\?.*$/, '') : null,
    width: Number(ii.width) || 0,
    height: Number(ii.height) || 0,
    url: ii.descriptionurl
  }
  return { ...pic, imageUrl: imageAt(pic, 960) }
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
/**
 * The places editor's own way out, or null for none. Choosing a place closes the editor, and Esc
 * or the × in the search line close it too, so a button is only worth drawing on first run, where
 * "not now" does something of its own: it saves the empty list, so the tile does not ask again.
 */
export const placesExit = (places) => (places === null ? 'not now' : null)

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

/**
 * The caption the viewer offers under a 9:16 crop (workshop.viewer.show): the picture's title with
 * who made it (most pictures are CC BY-SA, which asks for the credit), and the day as mm/dd/yy.
 */
export function cropCaption(pic) {
  const [y, m, d] = String(pic.date).split('-')
  const text = pic.credit ? `${pic.title}. ${pic.credit}` : pic.title
  return { text, source: `Wikipedia Photo of the Day, ${m}/${d}/${String(y).slice(-2)}` }
}
