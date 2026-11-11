// The project page's two live pieces, both the app's own code: Deep Space's sky (cosmos.ts, the
// wall behind core's window) and the Knot (shared/knot.ts, the mark on every session), drawn here
// large as the hero and small in the five states a session can be in.

import './style.css'
import { FLARE_MS, MODES, P, TAU, drawKnot, fineLine, knotPalette, segsFor, wrapClock, type KnotMode, type KnotPalette } from '@shared/knot'
import { COSMOS_ID, themeById } from '@shared/themes'
import { syncCosmos } from '../src/renderer/src/cosmos'
import { checkEntry, type IndexEntry } from '@shared/tile-index'
import { permissionWords } from '@shared/permissions'
import type { Permissions } from '@shared/manifest'
import gitTile from '../tiles/git/tile.json'
import remindersTile from '../tiles/reminders/tile.json'
import todayTile from '../tiles/wikipedia/tile.json'
import gitIcon from '../tiles/git/icon.svg?url'
import remindersIcon from '../tiles/reminders/icon.svg?url'
import todayIcon from '../tiles/wikipedia/icon.svg?url'

syncCosmos(COSMOS_ID)

const space = themeById(COSMOS_ID).dark
const palettes = new Map<KnotMode, KnotPalette>()
const paletteFor = (m: KnotMode): KnotPalette => {
  let p = palettes.get(m)
  if (!p) palettes.set(m, (p = knotPalette(space, m)))
  return p
}

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

interface Live {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  mode: KnotMode
  /** In loops, wrapped at P loops, where the knot closes. */
  clock: number
  flareAt: number
  visible: boolean
  last: number
  S: number
  /** Overrides the mode's speed and frame rate (the hero). */
  look?: { size: number; loop: number; fps: number }
}

const knots: Live[] = []

function add(canvas: HTMLCanvasElement, mode: KnotMode, start: number, look?: Live['look']): Live | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const k: Live = { canvas, ctx, mode, clock: wrapClock(start), flareAt: -1e9, visible: true, last: 0, S: 0, look }
  knots.push(k)
  return k
}

function draw(k: Live, now: number): void {
  const look = k.look ?? MODES[k.mode]
  const S = k.canvas.clientWidth
  if (!S) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.round(S * dpr)
  if (k.canvas.width !== px) k.canvas.width = k.canvas.height = px
  k.S = S
  const flare = reduced.matches ? 0 : Math.max(0, 1 - (now - k.flareAt) / FLARE_MS)
  // The app's still phase (Knot.tsx): where the strands read clearly.
  const ph = (reduced.matches || look.loop === 0 ? 1.1 : k.clock) * TAU
  k.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  k.ctx.clearRect(0, 0, S, S)
  drawKnot(fineLine(k.ctx, S), { S, ph, palette: paletteFor(k.mode), size: look.size, flare, segs: Math.max(segsFor(S), Math.round(S * 0.6)) })
}

let raf = 0
function tick(now: number): void {
  raf = 0
  for (const k of knots) {
    if (!k.visible) {
      k.last = 0
      continue
    }
    const look = k.look ?? MODES[k.mode]
    const flaring = now - k.flareAt < FLARE_MS
    // Each knot at its own frame rate, as in the app (30 a second while it moves).
    const fps = flaring ? 30 : look.fps
    if (k.last && fps && now - k.last < 1000 / fps - 2) continue
    if (!fps && k.last && !flaring) continue
    const dt = k.last ? Math.min(0.25, (now - k.last) / 1000) : 0
    k.last = now
    if (look.loop > 0) k.clock = wrapClock(k.clock + dt / look.loop)
    draw(k, now)
  }
  if (!reduced.matches && !document.hidden) raf = requestAnimationFrame(tick)
}
function start(): void {
  if (raf) return
  if (reduced.matches) {
    for (const k of knots) draw(k, performance.now())
    return
  }
  raf = requestAnimationFrame(tick)
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const k = knots.find((x) => x.canvas === e.target)
    if (k) k.visible = e.isIntersecting
  }
})

// The hero: the app's mark, full size, but slower than a working session (2.4 s a loop is too busy
// for a page people read; Colin, 10 Nov 2026; slower again, 10 s, on 11 Nov) and at every frame
// the display can show.
const hero = document.querySelector<HTMLCanvasElement>('#hero-knot')
if (hero) add(hero, 'work', 0, { size: MODES.work.size, loop: 10, fps: 120 })

// The five states, each a button: pressing one flares it, as a call for attention does in the app.
for (const el of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  const canvas = el.querySelector('canvas')
  const mode = el.dataset.mode as KnotMode
  if (!canvas || !(mode in MODES)) continue
  const k = add(canvas, mode, Math.random() * P)
  if (!k) continue
  el.addEventListener('click', () => {
    k.flareAt = performance.now()
    k.last = 0
    start()
  })
}

for (const k of knots) io.observe(k.canvas)
document.addEventListener('visibilitychange', () => {
  for (const k of knots) k.last = 0
  start()
})
reduced.addEventListener('change', start)
window.addEventListener('resize', () => {
  for (const k of knots) draw(k, performance.now())
})
start()

// ── The marketplace: what the index lists now, read in the visitor's browser ─────────────────────
// The index is DoshaLabs/workshop-index's tiles.json, the file workshop's + menu installs from.
// Each entry is checked by core's own rules (shared/tile-index.ts) and its permissions are put in
// the words the install prompt uses (shared/permissions.ts). Nothing from the index is ever HTML:
// every string goes in as text.

const INDEX = 'https://raw.githubusercontent.com/DoshaLabs/workshop-index/main/tiles.json'
const CATEGORY: Record<string, string> = { tools: 'Tools', notes: 'Notes', sessions: 'Sessions', media: 'Media', games: 'Games', emulators: 'Emulators', fun: 'Fun', other: 'Other' }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

interface Card {
  name: string
  hint: string
  author: string
  version?: string
  category?: string
  permissions: Permissions
  repo?: string
  icon?: string | Promise<string | null>
}

function card(c: Card): HTMLElement {
  const art = el('article', 'tile-card')
  const head = el('div', 'tile-card-head')
  const icon = el('span', 'tile-card-icon')
  icon.textContent = c.name[0] ?? '?'
  const setIcon = (src: string | null) => {
    if (!src) return
    const img = el('img')
    img.src = src
    img.alt = ''
    img.width = img.height = 22
    icon.replaceChildren(img)
  }
  if (typeof c.icon === 'string') setIcon(c.icon)
  else c.icon?.then(setIcon, () => undefined)
  const title = el('div', 'tile-card-title')
  title.append(el('h4', undefined, c.name), el('span', 'tile-card-by', [c.author, c.version && `v${c.version}`].filter(Boolean).join(' · ')))
  head.append(icon, title)
  if (c.category) head.append(el('span', 'tile-card-cat', CATEGORY[c.category] ?? c.category))
  art.append(head, el('p', 'tile-card-hint', c.hint))
  const words = permissionWords(c.permissions)
  const asks = el('ul', 'tile-card-asks')
  for (const w of words.length ? words : ['nothing beyond its own page']) asks.append(el('li', undefined, w))
  art.append(el('span', 'tile-card-label', 'It can'), asks)
  if (c.repo) {
    const a = el('a', 'tile-card-repo', c.repo.replace(/^https:\/\/(www\.)?github\.com\//, ''))
    a.href = c.repo
    art.append(a)
  }
  return art
}

/** A listed tile's icon, from its repository at the pinned commit. raw.githubusercontent.com sends SVG as text/plain, which <img> refuses: the bytes are read and given their type. */
async function iconOf(e: IndexEntry): Promise<string | null> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(e.repo)
  if (!m) return null
  const raw = (path: string) => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${e.commit}/${path}`
  const manifest = (await (await fetch(raw('tile.json'))).json()) as { icon?: unknown }
  const path = typeof manifest.icon === 'string' && /^[\w./-]+\.(svg|png)$/.test(manifest.icon) && !manifest.icon.includes('..') ? manifest.icon : null
  if (!path) return null
  const res = await fetch(raw(path))
  if (!res.ok) return null
  const bytes = await res.arrayBuffer()
  return URL.createObjectURL(new Blob([bytes], { type: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }))
}

const builtin = document.getElementById('market-builtin')
if (builtin) {
  const core = (m: { name: string; hint: string; permissions: unknown; backend?: unknown }, icon: string): Card => ({
    name: m.name,
    hint: m.hint,
    author: 'DoshaLabs',
    // The trusted tier is a top-level key; core shows it as a permission, first.
    permissions: { ...(m.permissions as Permissions), ...(m.backend ? { backend: true } : {}) } as Permissions,
    icon
  })
  builtin.replaceChildren(card(core(todayTile, todayIcon)), card(core(gitTile, gitIcon)), card(core(remindersTile, remindersIcon)))
}

const listed = document.getElementById('market-listed')
const count = document.getElementById('market-count')
if (listed) {
  fetch(INDEX, { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<unknown>
    })
    .then((raw) => {
      const entries = (Array.isArray(raw) ? raw : []).map((x) => checkEntry(x)).flatMap((r) => (r.ok ? [r.entry] : []))
      if (count) count.textContent = `${entries.length} listed`
      listed.replaceChildren(...entries.map((e) => card({ name: e.name, hint: e.hint, author: e.author, version: e.version, category: e.category, permissions: e.permissions, repo: e.repo, icon: iconOf(e).catch(() => null) })))
      if (!entries.length) listed.replaceChildren(el('p', 'market-wait', 'Nothing is listed yet. Yours could be first.'))
    })
    .catch(() => {
      const p = el('p', 'market-wait', 'The index could not be read just now. ')
      const a = el('a', undefined, 'See tiles.json on GitHub')
      a.href = 'https://github.com/DoshaLabs/workshop-index/blob/main/tiles.json'
      p.append(a)
      listed.replaceChildren(p)
    })
}
