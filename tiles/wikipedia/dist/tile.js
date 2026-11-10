// The Wikipedia tile: the reference tile for the contract. Plain JavaScript, no build, every
// call through `window.workshop`. It reaches only the two hosts its tile.json declares, keeps
// the last article in storage, and answers three door ops (show, search, today) so a Claude
// session can put an article up beside the conversation.

const API = 'https://en.wikipedia.org'
const body = document.getElementById('body')
const q = document.getElementById('q')

/** Wikimedia serves only some thumbnail widths (250, 330, 500, 960, 1280, 1920). */
const thumb = (url, width) => url.replace(/^\/\//, 'https://').replace(/\?.*$/, '').replace(/\/\d+px-/, `/${width}px-`)
const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v)
  }
  for (const k of kids) if (k != null) e.append(k)
  return e
}

const show = (...nodes) => body.replaceChildren(...nodes)
const note = (text) => show(el('p', { class: 'muted' }, text))

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Wikipedia answered HTTP ${res.status}`)
  return res.json()
}

async function today() {
  const d = new Date()
  const ymd = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  const img = (await getJson(`${API}/api/rest_v1/feed/featured/${ymd}`)).image
  if (!img?.thumbnail?.source) return null
  return {
    title: strip(img.description?.text) || (img.title || '').replace(/^File:/, ''),
    credit: strip(img.artist?.text),
    imageUrl: thumb(img.thumbnail.source, 960),
    url: img.file_page
  }
}

async function search(text) {
  const query = String(text || '').trim()
  if (!query) return []
  const data = await getJson(`${API}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=10`)
  return (data.pages || []).map((p) => ({
    key: p.key,
    title: p.title,
    description: strip(p.description),
    imageUrl: p.thumbnail?.url ? thumb(p.thumbnail.url, 250) : null
  }))
}

async function summary(key) {
  const s = await getJson(`${API}/api/rest_v1/page/summary/${encodeURIComponent(String(key).trim().replace(/ /g, '_'))}`)
  return {
    key: s.titles?.canonical || key,
    title: strip(s.displaytitle) || s.title || key,
    description: strip(s.description),
    extract: (s.extract || '').trim(),
    imageUrl: s.thumbnail?.source ? thumb(s.thumbnail.source, 960) : null,
    url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`
  }
}

// ---- views

async function renderToday() {
  note('Loading today’s picture…')
  try {
    const pic = await today()
    if (!pic) return note('No picture of the day today.')
    workshop.head.set({ title: 'Wikipedia' })
    show(
      el(
        'div',
        { class: 'picture', title: 'Open on Wikimedia Commons', onclick: () => workshop.openExternal(pic.url) },
        el('img', { src: pic.imageUrl, alt: pic.title }),
        el('div', { class: 'caption' }, pic.title, pic.credit ? el('div', { class: 'muted' }, pic.credit) : null)
      )
    )
  } catch (err) {
    note(`Could not reach Wikipedia: ${err.message}`)
  }
}

function renderHits(hits, text) {
  if (!hits.length) return note(`Nothing found for “${text}”.`)
  show(
    ...hits.map((h) =>
      el(
        'div',
        { class: 'hit', onclick: () => void openArticle(h.key) },
        h.imageUrl ? el('img', { src: h.imageUrl, alt: '' }) : null,
        el('div', {}, el('b', {}, h.title), el('span', { class: 'muted' }, h.description))
      )
    )
  )
}

function renderArticle(a) {
  workshop.head.set({ title: a.title })
  show(
    el(
      'div',
      { class: 'article' },
      el('span', { class: 'link back', onclick: () => void home() }, '← Today'),
      a.imageUrl ? el('img', { src: a.imageUrl, alt: '' }) : null,
      el('h2', {}, a.title),
      a.description ? el('div', { class: 'muted' }, a.description) : null,
      el('p', {}, a.extract),
      el('span', { class: 'link', onclick: () => workshop.openExternal(a.url) }, 'Read it on Wikipedia ↗')
    )
  )
}

async function openArticle(key) {
  note('Loading…')
  try {
    const a = await summary(key)
    renderArticle(a)
    await workshop.storage.set('last', a.key)
    return a
  } catch (err) {
    note(`Could not load “${key}”: ${err.message}`)
    throw err
  }
}

async function home() {
  await workshop.storage.set('last', null)
  q.value = ''
  await renderToday()
}

document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = q.value
  note('Searching…')
  try {
    renderHits(await search(text), text)
  } catch (err) {
    note(`Search failed: ${err.message}`)
  }
})

const setView = (v) => document.body.classList.toggle('pane', v === 'pane')
setView(workshop.view)
workshop.onViewChange(setView)

// ---- the door: what a Claude session can ask of this tile

workshop.door.handle('show', async (args) => {
  const a = await openArticle(args.join(' '))
  return { title: a.title, description: a.description, url: a.url }
})
workshop.door.handle('search', async (args) => {
  const text = args.join(' ')
  const hits = await search(text)
  renderHits(hits, text)
  return hits.map((h) => ({ title: h.title, description: h.description }))
})
workshop.door.handle('today', async () => {
  await home()
  return today()
})

// ---- start where we left off

workshop.storage.get('last').then((last) => (last ? openArticle(last).catch(() => renderToday()) : renderToday()))
