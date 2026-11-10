// The Wikipedia tile, ported from deck: Wikipedia's picture of the day full bleed, a clock and the
// weather top left, a search box laid over the picture top right. The picture changes every two
// minutes (today's, then two from the archive, then today's again); ‹ › step by hand. A search
// darkens the picture and lists hits; a hit opens its lead section in place. A click on the
// picture opens it large over the whole window (deck's lightbox): the tile asks core for the
// overlay view, and this same page draws the dimmed backdrop and the picture in it. The head's
// expand button still opens the tile as a pane.
//
// Plain JavaScript, no build. The rules are in wiki.js; this file is the page. Everything it
// fetches goes to the hosts tile.json declares, from the page itself. What it keeps in
// `workshop.storage`: the weather places and the unit. Three door ops (show, search, today) let
// a Claude session put an article up beside the conversation.

import {
  CYCLE_MS,
  PLACES_MAX,
  addPlace,
  cleanPlaces,
  cleanUnit,
  deg,
  featuredUrl,
  forecastUrl,
  geocodeQuery,
  hitsFrom,
  leadPlace,
  look,
  otherClock,
  pictureFrom,
  placesExit,
  placesFrom,
  randomPastDay,
  removePlace,
  searchUrl,
  summaryFrom,
  summaryUrl,
  weatherFrom,
  whenFor,
  ymd
} from './wiki.js'

const ws = window.workshop
const $ = (id) => document.getElementById(id)
const bgBox = $('bg')
const main = $('main')
const weatherBox = $('weather')
const form = $('search')
const q = $('q')
const clearBtn = $('clear')
const lightbox = $('lightbox')

const SEARCH_DEBOUNCE_MS = 350
const WEATHER_EVERY_MS = 10 * 60 * 1000
const TODAY_TTL_MS = 60 * 60 * 1000
const TIMEOUT_MS = 12_000
const PAST_TRIES = 4

const DATE_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_FMT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

/** "3 March 2019" for a YYYY-MM-DD, read as a local date. */
function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number)
  return DAY_FMT.format(new Date(y, m - 1, d))
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'value') e.value = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

/** replaceChildren that skips what a condition left behind: the DOM would draw null and false as words. */
const put = (box, ...kids) => box.replaceChildren(...kids.flat().filter((k) => k != null && k !== false))

const plain = (err) => (err instanceof Error ? err.message : String(err))
/** A click handled here goes no further, so it never reaches the picture's own click. */
const only = (fn) => (e) => {
  e.stopPropagation()
  fn(e)
}

async function getJson(url, what) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  return res.json()
}

// ---- fetching (deck did this in main; a tile does it in its page)

/** Pictures by day, for the page's life: past days never change, today's is asked again after an hour. */
const pictures = new Map()

async function pictureOn(date) {
  const today = date === ymd(new Date())
  const hit = pictures.get(date)
  if (hit && (!today || Date.now() - hit.at < TODAY_TTL_MS)) return hit.item
  const item = pictureFrom(await getJson(featuredUrl(date), 'wikipedia feed'), date, today)
  pictures.set(date, { at: Date.now(), item })
  return item
}

/** Today's picture, or with 'past' a random day's: a few days are tried, and the last resort is today's. */
async function fetchPicture(when) {
  if (when === 'past') {
    for (let i = 0; i < PAST_TRIES; i++) {
      try {
        const item = await pictureOn(randomPastDay())
        if (item) return item
      } catch {
        // try another day
      }
    }
  }
  return pictureOn(ymd(new Date()))
}

const fetchHits = async (text) => (text.trim() ? hitsFrom(await getJson(searchUrl(text.trim()), 'wikipedia search')) : [])
const fetchSummary = async (key) => summaryFrom(await getJson(summaryUrl(key), 'wikipedia summary'), key)

// ---- state

let view = ws.view
let pic = null
let picErr = null
/** Every picture shown so far, so ‹ goes back through them; › past the newest loads another. */
const shown = []
let at = -1
let step = 0
let loadingPic = null

let query = ''
let hits = null
let searching = false
let searchErr = null
let searchSeq = 0
let article = null

let places = null
let unit = cleanUnit(null, navigator.language)
let weather = []
let weatherErr = null
let weatherSeq = 0
/** The places editor: closed, open by a click, or open because no place was ever saved. */
let placesOpen = false
let placeHits = null
let placeErr = null
let placeSeq = 0

const overlay = () => (article ? 'article' : hits || searching ? 'results' : placesOpen ? 'places' : 'picture')

// ---- the picture cycle

function showAt(i) {
  at = i
  pic = shown[i]
  picErr = null
  render()
}

/** The next picture: forward through what was shown, else a new one (today's every third time). */
function next() {
  if (at < shown.length - 1) return Promise.resolve(showAt(at + 1))
  if (loadingPic) return loadingPic
  const when = whenFor(step++)
  loadingPic = fetchPicture(when)
    .then((p) => {
      if (!p) {
        if (!shown.length) picErr = 'No picture today'
        return render()
      }
      // Today's comes round every third time: point at the one already kept.
      const had = shown.findIndex((x) => x.date === p.date)
      if (had < 0) shown.push(p)
      showAt(had < 0 ? shown.length - 1 : had)
    })
    .catch((e) => {
      picErr = `Could not reach Wikipedia: ${plain(e)}`
      render()
    })
    .finally(() => (loadingPic = null))
  return loadingPic
}

const prev = () => at > 0 && showAt(at - 1)

let cycle = 0
/** A manual step starts the cycle's clock over. */
function restartCycle() {
  clearInterval(cycle)
  // The picture someone is looking at over the window stays put; ‹ › there still step.
  cycle = setInterval(() => view !== 'overlay' && void next(), CYCLE_MS)
}

/** Today's picture, found among those shown or fetched. */
async function showToday() {
  const p = await fetchPicture('today')
  if (!p) return null
  const had = shown.findIndex((x) => x.date === p.date)
  if (had < 0) shown.push(p)
  showAt(had < 0 ? shown.length - 1 : had)
  restartCycle()
  return p
}

// ---- search and articles

async function runSearch(text) {
  const id = ++searchSeq
  query = text
  searchErr = null
  if (!text.trim()) {
    hits = null
    searching = false
    render()
    return []
  }
  searching = true
  render()
  try {
    const xs = await fetchHits(text)
    if (id === searchSeq) {
      hits = xs
      searching = false
      render()
    }
    return xs
  } catch (e) {
    if (id === searchSeq) {
      searchErr = `Search failed: ${plain(e)}`
      hits = []
      searching = false
      render()
    }
    throw e
  }
}

let debounce = 0
q.addEventListener('input', () => {
  article = null
  query = q.value
  clearTimeout(debounce)
  if (!query.trim()) void runSearch('').catch(() => {})
  else debounce = setTimeout(() => void runSearch(query).catch(() => {}), SEARCH_DEBOUNCE_MS)
  render()
})
form.addEventListener('submit', (e) => {
  e.preventDefault()
  clearTimeout(debounce)
  void runSearch(q.value).catch(() => {})
})
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    reset()
  }
})
form.addEventListener('click', (e) => e.stopPropagation())
clearBtn.addEventListener('click', only(() => reset()))

/** Back to the picture: no search, no article, no places editor. */
function reset() {
  searchSeq++
  clearTimeout(debounce)
  query = ''
  q.value = ''
  hits = null
  searching = false
  searchErr = null
  article = null
  placesOpen = false
  q.blur()
  render()
}

/** An article in place: the hit's own title and picture at once, the lead section when it lands. */
async function openArticle(key, from = null) {
  article = from ? { key, title: from.title, description: from.description, extract: '', imageUrl: from.imageUrl, url: from.url } : { key, title: key.replace(/_/g, ' '), description: '', extract: '', imageUrl: null, url: '' }
  render()
  try {
    const a = await fetchSummary(key)
    if (article?.key === key) {
      article = a
      render()
    }
    return a
  } catch (e) {
    if (article?.key === key) {
      article = { ...article, extract: `Could not load it: ${plain(e)}` }
      render()
    }
    throw e
  }
}

// ---- weather

async function loadWeather() {
  const id = ++weatherSeq
  if (!places?.length) {
    weather = []
    weatherErr = null
    return render()
  }
  try {
    const rows = weatherFrom(await getJson(forecastUrl(places, unit), 'weather'), places, unit)
    if (id !== weatherSeq) return
    weather = rows
    weatherErr = null
  } catch (e) {
    if (id !== weatherSeq) return
    weatherErr = plain(e)
  }
  render()
}

function savePlaces(list) {
  places = list
  void ws.storage.set('places', list)
  void loadWeather()
  render()
}

function saveUnit(u) {
  if (u === unit) return
  unit = u
  void ws.storage.set('unit', u)
  void loadWeather()
  render()
}

function openPlaces() {
  placesOpen = true
  render()
  main.querySelector('.wiki-place-input')?.focus()
}

/** Closing the editor with nothing saved still saves the empty list, so the tile does not ask again. */
function closePlaces() {
  placesOpen = false
  placeHits = null
  if (places === null) savePlaces([])
  else render()
}

let placeDebounce = 0
function searchPlaces(text) {
  const id = ++placeSeq
  clearTimeout(placeDebounce)
  const ask = geocodeQuery(text)
  if (!ask) {
    placeHits = null
    placeErr = null
    return renderPlaceHits()
  }
  placeDebounce = setTimeout(async () => {
    try {
      const xs = placesFrom(await getJson(ask.url, 'place search'), ask.want)
      if (id !== placeSeq) return
      placeHits = xs
      placeErr = null
    } catch (e) {
      if (id !== placeSeq) return
      placeErr = plain(e)
    }
    renderPlaceHits()
  }, SEARCH_DEBOUNCE_MS)
}

/** Choosing a place is the whole job: it is saved and the editor closes, back to the picture. */
function pickPlace(p) {
  placeHits = null
  placesOpen = false
  savePlaces(addPlace(places ?? [], p))
}

// ---- drawing

function tick() {
  const now = new Date()
  $('time').textContent = TIME_FMT.format(now)
  $('date').textContent = DATE_FMT.format(now)
}

/** The background image, swapped only when its address changes, so it fades in once. */
function renderBg() {
  const src = article?.imageUrl ?? pic?.imageUrl ?? null
  const large = view === 'pane' && overlay() === 'picture' && pic?.largeUrl
  const want = large || src
  const img = bgBox.firstElementChild
  if (img?.getAttribute('src') === want) return
  put(bgBox, want ? el('img', { class: 'wiki-img', src: want, alt: '', draggable: 'false' }) : '')
}

function timeThere(row) {
  if (!otherClock(row, new Date().getTimezoneOffset())) return null
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: row.timezone }).format(new Date())
  } catch {
    return null
  }
}

/** The first place large (glyph, temperature, the word for it, then its name with today's high and low), the others a line each. */
function renderWeather() {
  if (overlay() !== 'picture') return put(weatherBox)
  const edit = only(openPlaces)
  if (!places?.length) return put(weatherBox, el('button', { class: 'wiki-weather wiki-weather-none', title: 'Show the weather somewhere', onclick: edit }, '+ weather'))
  const rows = weather.filter((r) => places.some((p) => p.lat === r.place.lat && p.lon === r.place.lon))
  const [first, ...others] = rows
  if (!first) return put(weatherBox, el('button', { class: 'wiki-weather wiki-weather-none', title: weatherErr ?? 'Weather places', onclick: edit }, weatherErr ? 'no weather' : 'weather…'))
  const now = look(first.code, first.day)
  put(weatherBox, 
    el(
      'button',
      { class: 'wiki-weather', onclick: edit, title: `${first.place.name}: feels like ${deg(first.feels)}, wind ${first.wind ?? '–'} ${first.unit === 'F' ? 'mph' : 'km/h'} · click to change places` },
      el('span', { class: 'wiki-weather-now' }, el('span', { class: 'wiki-weather-glyph' }, now.glyph), el('span', { class: 'wiki-weather-temp' }, deg(first.temp)), el('span', { class: 'wiki-weather-label' }, now.label)),
      el('span', { class: 'wiki-weather-place' }, `${first.place.name} · H ${deg(first.high)} L ${deg(first.low)}`),
      others.map((r) => {
        const l = look(r.code, r.day)
        const t = timeThere(r)
        return el('span', { class: 'wiki-weather-other', title: l.label }, el('span', { class: 'wiki-weather-glyph' }, l.glyph), el('span', { class: 'wiki-weather-temp' }, deg(r.temp)), el('span', {}, r.place.name), t && el('span', { class: 'wiki-weather-time' }, t))
      })
    )
  )
}

function renderPicture() {
  if (!pic) return put(main, el('div', { class: 'wiki-empty' }, picErr ?? 'wikipedia…'))
  const steps = el(
    'span',
    { class: 'wiki-steps' },
    el('button', { title: 'The picture before', disabled: at <= 0, onclick: only(() => (prev(), restartCycle())) }, '‹'),
    el('button', { title: 'Another picture', onclick: only(() => (next(), restartCycle())) }, '›')
  )
  const tag = pic.today ? 'picture of the day' : `picture of the day · ${dayLabel(pic.date)}`
  put(main, 
    el(
      'div',
      { class: 'wiki-text' },
      el('span', { class: 'wiki-tagline' }, el('span', { class: 'wiki-tag' }, tag), steps),
      el('h3', { class: 'wiki-title' }, pic.title),
      pic.credit && el('p', { class: 'wiki-summary' }, pic.credit),
      view === 'pane' && el('button', { class: 'wiki-commons', title: pic.url, onclick: only(() => ws.openExternal(pic.url)) }, 'on Wikimedia Commons ↗')
    )
  )
}

/**
 * The lightbox, drawn only in the overlay view: the picture whole and uncropped at 70% of the
 * window's width with everything the feed handed us under it (which day, what it is, who took it),
 * ‹ › through the pictures, and the file page on Commons. A click outside the frame or the ×
 * closes it; Esc is core's and always closes it. Rebuilt only when the picture changes, so the
 * large image is not fetched again on every redraw.
 */
let boxFor = ''
function renderLightbox() {
  const want = view === 'overlay' && pic ? `${pic.date}|${at}|${shown.length}` : ''
  if (want === boxFor) return
  boxFor = want
  if (!want) return put(lightbox)
  const close = only(() => void ws.closeOverlay())
  const steps = el(
    'span',
    { class: 'wikibox-steps' },
    el('button', { title: 'The picture before', disabled: at <= 0, onclick: only(() => (prev(), restartCycle())) }, '‹'),
    el('button', { title: 'Another picture', onclick: only(() => (next(), restartCycle())) }, '›')
  )
  put(lightbox, 
    el(
      'div',
      { class: 'wikibox-scrim', onclick: close },
      el(
        'figure',
        { class: 'wikibox', role: 'dialog', 'aria-label': pic.title, onclick: (e) => e.stopPropagation() },
        el('img', { class: 'wikibox-img', src: pic.largeUrl || pic.imageUrl, alt: pic.title, draggable: 'false' }),
        el(
          'figcaption',
          { class: 'wikibox-text' },
          el('span', { class: 'wikibox-tagline' }, el('span', { class: 'wikibox-tag' }, `picture of the day · ${pic.today ? 'today' : dayLabel(pic.date)}`), steps),
          el('h3', { class: 'wikibox-title' }, pic.title),
          pic.credit && el('p', { class: 'wikibox-credit' }, pic.credit),
          el('button', { class: 'wikibox-link', title: pic.url, onclick: only(() => ws.openExternal(pic.url)) }, 'on Wikimedia Commons ↗')
        ),
        el('button', { class: 'wikibox-close', title: 'Close (Esc)', onclick: close }, '×')
      )
    )
  )
}

function renderResults() {
  const list = el('div', { class: 'wiki-panel' })
  if (searchErr) list.append(el('div', { class: 'wiki-none' }, searchErr))
  else if (hits && hits.length === 0 && !searching) list.append(el('div', { class: 'wiki-none' }, `Nothing for “${query.trim()}”`))
  for (const h of hits ?? [])
    list.append(
      el(
        'button',
        { class: 'wiki-hit', title: h.url, onclick: only(() => void openArticle(h.key, h).catch(() => {})) },
        h.imageUrl ? el('img', { src: h.imageUrl, alt: '', draggable: 'false' }) : el('span', { class: 'wiki-hit-noimg' }),
        el(
          'span',
          { class: 'wiki-hit-text' },
          el('span', { class: 'wiki-hit-title' }, h.title),
          h.description && el('span', { class: 'wiki-hit-desc' }, h.description),
          h.excerpt && el('span', { class: 'wiki-hit-excerpt' }, h.excerpt)
        )
      )
    )
  put(main, list)
}

function renderArticle() {
  const a = article
  const back = hits ? el('button', { class: 'wiki-back', title: 'Back to results', onclick: only(() => ((article = null), render())) }, '‹ results') : el('button', { class: 'wiki-back', title: 'Back to the picture (Esc)', onclick: only(reset) }, '‹ picture')
  put(main, 
    el(
      'div',
      { class: 'wiki-panel wiki-article' },
      back,
      el('h3', { class: 'wiki-title' }, a.url ? el('button', { class: 'wiki-link', title: 'Open on Wikipedia', onclick: only(() => ws.openExternal(a.url)) }, `${a.title} ↗`) : a.title),
      a.description && el('div', { class: 'wiki-hit-desc' }, a.description),
      el('p', { class: 'wiki-extract' }, a.extract || '…')
    )
  )
}

/**
 * The places editor, a panel over the darkened picture like a search's results: the places in
 * order (↑ makes one the first, × removes it), °F / °C, and a line that finds a place by name.
 * Built once while it is open, so the line keeps its focus and its text as the rest redraws.
 */
function renderPlaces() {
  let panel = main.querySelector('.wiki-places')
  if (!panel) {
    const input = el('input', { class: 'wiki-place-input', spellcheck: 'false' })
    input.addEventListener('input', () => searchPlaces(input.value))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePlaces()
      } else if (e.key === 'Enter' && placeHits?.[0]) pickPlace(placeHits[0])
    })
    panel = el('div', { class: 'wiki-panel wiki-places', onclick: (e) => e.stopPropagation() }, el('div', { class: 'wiki-places-head' }), el('div', { class: 'wiki-places-list' }), input, el('div', { class: 'wiki-places-hits' }))
    put(main, panel)
  }
  const first = places === null
  const [head, list, input] = panel.children
  put(head, 
    el('span', { class: 'wiki-tag' }, first ? 'weather: where are you?' : 'weather'),
    el(
      'span',
      { class: 'wiki-places-units' },
      ['F', 'C'].map((u) => el('button', { class: u === unit ? 'on' : '', onclick: only(() => saveUnit(u)) }, `°${u}`))
    ),
    placesExit(places) && el('button', { class: 'wiki-back', title: 'Close (Esc)', onclick: only(closePlaces) }, placesExit(places))
  )
  put(list, 
    ...(places ?? []).map((p, i) =>
      el(
        'div',
        { class: 'wiki-place' },
        el('span', { class: 'wiki-place-name' }, p.name, p.region && el('span', { class: 'wiki-hit-desc' }, ` ${p.region}`)),
        i > 0 && el('button', { title: 'Make it the first', onclick: only(() => savePlaces(leadPlace(places, p))) }, '↑'),
        el('button', { title: 'Remove', onclick: only(() => savePlaces(removePlace(places, p))) }, '×')
      )
    )
  )
  const full = (places ?? []).length >= PLACES_MAX
  input.disabled = full
  input.placeholder = full ? `${PLACES_MAX} places is the most` : first ? 'your city, e.g. Lisbon, Portugal' : 'add a place: Lisbon, Portugal'
  renderPlaceHits()
}

function renderPlaceHits() {
  const box = main.querySelector('.wiki-places-hits')
  if (!box) return
  const input = main.querySelector('.wiki-place-input')
  put(box, 
    placeErr && el('div', { class: 'wiki-none' }, placeErr),
    placeHits && placeHits.length === 0 && el('div', { class: 'wiki-none' }, `Nowhere called “${input?.value.trim() ?? ''}”`),
    ...(placeHits ?? []).map((p) => el('button', { class: 'wiki-hit wiki-place-hit', onclick: only(() => pickPlace(p)) }, el('span', { class: 'wiki-hit-title' }, p.name), el('span', { class: 'wiki-hit-desc' }, p.region)))
  )
}

function render() {
  const o = overlay()
  document.body.className = `wiki wiki-${o}${view === 'tile' ? '' : ` ${view}`}`
  document.body.title = o === 'picture' && pic && view !== 'overlay' ? 'See it large' : ''
  renderLightbox()
  clearBtn.hidden = !(query || o !== 'picture')
  renderBg()
  renderWeather()
  if (o === 'picture') renderPicture()
  else if (o === 'results') renderResults()
  else if (o === 'article') renderArticle()
  else renderPlaces()
  void ws.head.set({ title: o === 'article' ? article.title : 'Wikipedia' })
}

// A click on the picture opens it over the whole window. Core lets a tile do that only in answer
// to a click in it, which this is; Esc or the strip core draws above it brings the tile back.
document.body.addEventListener('click', () => {
  if (overlay() === 'picture' && pic && view !== 'overlay') ws.openOverlay().catch((e) => console.warn('[wikipedia]', plain(e)))
})
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (overlay() !== 'picture') reset()
  else if (view === 'pane') void ws.closePane()
})

ws.onViewChange((v) => {
  view = v
  render()
})

// ---- the door: what a Claude session can ask of this tile

ws.door.handle('show', async (args) => {
  const key = args.join(' ').trim()
  if (!key) throw new Error('show which article?')
  placesOpen = false
  const a = await openArticle(key)
  return { title: a.title, description: a.description, url: a.url }
})
ws.door.handle('search', async (args) => {
  const text = args.join(' ')
  article = null
  placesOpen = false
  q.value = text
  const xs = await runSearch(text)
  return xs.map((h) => ({ title: h.title, description: h.description, url: h.url }))
})
ws.door.handle('today', async () => {
  reset()
  const p = await showToday()
  return p && { title: p.title, credit: p.credit, imageUrl: p.imageUrl, url: p.url }
})

// ---- start

tick()
setInterval(tick, 1000)
render()
void next()
restartCycle()
setInterval(() => void loadWeather(), WEATHER_EVERY_MS)

Promise.all([ws.storage.get('places'), ws.storage.get('unit')]).then(([p, u]) => {
  places = cleanPlaces(p)
  unit = cleanUnit(u, navigator.language)
  // First run: no place was ever saved, so ask for one (deck defaulted to its author's city).
  if (places === null) placesOpen = true
  render()
  void loadWeather()
})
// Places written from elsewhere (another instance of the page, a test) are picked up here.
ws.storage.watch('places', (v) => {
  const kept = cleanPlaces(v)
  if (JSON.stringify(kept) === JSON.stringify(places)) return
  places = kept
  void loadWeather()
  render()
})
