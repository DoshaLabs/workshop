#!/usr/bin/env node
// The README's pictures of the Knot (CLAUDE.md §8): animated SVGs that GitHub can show through an
// <img>, where CSS animation runs but JavaScript does not.
//
//   docs/assets/knot.svg     the Knot alone, turning, on a disc of Deep Space
//   docs/assets/banner.svg   a wide Deep Space sky with the Knot and the word "workshop"
//   docs/assets/knot-icon.svg  one still frame on a dark disc: the project page's favicon
//
// The frames are drawn by the app's own code: `drawKnot` from src/shared/knot.ts, with the
// palette `knotPalette` makes from Deep Space's colours in src/shared/themes.ts, into a context
// that records each stroke. So the picture is the real Knot: a cinquefoil, the (2,5) torus knot, its strands
// sorted back to front, the depth bands and the pulse riding the strand.
//
// The loop is seamless because the curve closes after P = 2 loops (knot.ts, `knotPoints`): the
// frames cover exactly P loops and the CSS steps through them forever. Under
// `prefers-reduced-motion` one still frame shows, the phase the app shows when it holds still.
//
// The words are outlines of Nunito (the app's face), made once by scripts/wordmark.py and kept in
// scripts/wordmark.json, because an <img> SVG cannot load a web font.
//
//   node scripts/knot-svg.mjs        (no new dependencies: Vite, already here, loads the .ts)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { module: knot } = await runnerImport(join(root, 'src/shared/knot.ts'))
const { module: themes } = await runnerImport(join(root, 'src/shared/themes.ts'))
const { TAU, P, MODES, drawKnot, knotPalette } = knot
const space = themes.themeById(themes.COSMOS_ID).dark
const words = JSON.parse(readFileSync(join(root, 'scripts/wordmark.json'), 'utf8'))
const out = join(root, 'docs/assets')
mkdirSync(out, { recursive: true })

/** One decimal, no trailing zero: coordinates are the bulk of the file. */
const n = (v) => {
  const r = Math.round(v * 10) / 10
  return Object.is(r, -0) ? '0' : String(r)
}

/** A seeded random, so the same sky comes out every time (mulberry32, as cosmos.ts uses). */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ── The Knot as frames ───────────────────────────────────────────────────────

/**
 * The strokes `drawKnot` makes for one frame, as [colour, width, x1, y1, x2, y2], in the order it
 * makes them (back to front). Widths are rounded to half a pixel so strokes can share a class.
 */
function strokes(S, ph, palette, segs) {
  // The strand's width grows with the box, tuned for the app's 24 to 88 px; drawn larger it is a
  // fat tube, so it is scaled back above that (the same rule as site/main.ts `large`).
  const thin = S <= 120 ? 1 : Math.max(0.5, 120 / S + 0.35)
  const list = []
  let from = null
  const ctx = {
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'round',
    beginPath() {},
    moveTo(x, y) {
      from = [x, y]
    },
    lineTo(x, y) {
      list.push([this.strokeStyle, Math.round(this.lineWidth * thin * 2) / 2, from[0], from[1], x, y])
    },
    stroke() {}
  }
  drawKnot(ctx, { S, ph, palette, size: MODES.work.size, segs })
  return list
}

/**
 * The knot's frames as SVG, with every colour and width a class, and runs of strokes in the same
 * class merged into one path (`M x y x y`, round caps drawn per subpath, so it looks the same).
 * Returns the style rules and the frames' markup.
 */
function knotFrames({ S, frames, segs, prefix, x = 0, y = 0, seconds }) {
  const palette = knotPalette(space, 'work')
  const classes = new Map()
  const cls = (colour, width) => {
    const key = `${colour}/${width}`
    if (!classes.has(key)) classes.set(key, { name: `${prefix}${classes.size.toString(36)}`, colour, width })
    return classes.get(key).name
  }
  // The phase the app shows when it holds still (Knot.tsx: clock 1.1 loops).
  const stillAt = Math.round((1.1 / P) * frames) % frames
  const body = []
  for (let f = 0; f < frames; f++) {
    const ph = (f / frames) * P * TAU
    const runs = []
    for (const [colour, width, x1, y1, x2, y2] of strokes(S, ph, palette, segs)) {
      const c = cls(colour, width)
      // Relative to the segment's start; a run that carries on from where the last stroke ended is
      // one polyline (round joins look the same as round caps there).
      const start = `M${n(x1 + x)} ${n(y1 + y)}`
      const dx = n(x2 - x1)
      const dy = n(y2 - y1)
      // SVG needs no space before a minus sign.
      const pair = `${dx}${dy.startsWith('-') ? '' : ' '}${dy}`
      const last = runs[runs.length - 1]
      if (last && last.c === c && last.end === start) last.d += `${dx.startsWith('-') ? '' : ' '}${pair}`
      else if (last && last.c === c) last.d += `${start}l${pair}`
      else runs.push({ c, d: `${start}l${pair}` })
      runs[runs.length - 1].end = `M${n(x2 + x)} ${n(y2 + y)}`
    }
    // Each frame is shown for 1/frames of the cycle, offset by its place in it (a negative delay, so
    // the loop is already running when the picture appears).
    const delay = n(-((frames - f) / frames) * seconds * 100) / 100
    body.push(`<g class="${prefix}f${f === stillAt ? ` ${prefix}still` : ''}" style="animation-delay:${delay}s">${runs.map((r) => `<path class="${r.c}" d="${r.d}"/>`).join('')}</g>`)
  }
  const pct = Math.round((100 / frames) * 10000) / 10000
  const style = [
    `.${prefix}f{visibility:hidden;animation:${prefix}k ${seconds}s step-end infinite}`,
    `@keyframes ${prefix}k{0%{visibility:visible}${pct}%{visibility:hidden}}`,
    `@media (prefers-reduced-motion:reduce){.${prefix}f{animation:none}.${prefix}still{visibility:visible}}`,
    `path[class^="${prefix}"]{fill:none;stroke-linecap:round;stroke-linejoin:round}`,
    ...[...classes.values()].map((k) => `.${k.name}{stroke:${k.colour};stroke-width:${k.width}}`)
  ]
  return { style: style.join(''), body: body.join('') }
}

// ── The sky ──────────────────────────────────────────────────────────────────

const STAR_COLORS = ['#ffffff', '#ffffff', '#e4ecff', '#cbdcff', '#aac4ff', '#fff3dc', '#ffdcb4', '#ffb9a0']

/** Stars: many faint dots, a few bright ones with a glow, and some of those twinkling. */
function stars(W, H, count, seed, keepOut = () => false) {
  const rand = rng(seed)
  const dots = []
  const twinkles = []
  for (let i = 0; i < count; i++) {
    const x = rand() * W
    const y = rand() * H
    const a = 0.18 + Math.pow(rand(), 3) * 0.75
    const colour = STAR_COLORS[Math.floor(rand() * STAR_COLORS.length)]
    const big = rand() < 0.05
    if (keepOut(x, y)) continue
    const r = big ? 1.3 : 0.55 + rand() * 0.35
    const dot = `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${colour}" opacity="${n(a)}"/>`
    if (big && twinkles.length < 14) {
      const dur = n(2.6 + rand() * 3.4)
      const delay = n(-rand() * 6)
      twinkles.push(`<g class="tw" style="animation-duration:${dur}s;animation-delay:${delay}s"><circle cx="${n(x)}" cy="${n(y)}" r="5" fill="url(#glow)"/>${dot}</g>`)
    } else dots.push(dot)
  }
  return dots.join('') + twinkles.join('')
}

const SKY_DEFS = `<radialGradient id="deep" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#0b0d22"/><stop offset=".6" stop-color="#060714"/><stop offset="1" stop-color="#020309"/></radialGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".12" stop-color="#dce6ff" stop-opacity=".45"/><stop offset=".4" stop-color="#a0b4ff" stop-opacity=".08"/><stop offset="1" stop-color="#a0b4ff" stop-opacity="0"/></radialGradient>`

/** A soft nebula: two of cosmos.ts's palettes as blurred clouds of fractal noise, clipped to a soft blob. */
function nebula(id, W, H, cx, cy, rx, ry, [body, edge], seed, opacity) {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${Math.round((5 / W) * 10000) / 10000} ${Math.round((4 / H) * 10000) / 10000}" numOctaves="4" seed="${seed}"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 3 -1.1" result="cloud"/><feComposite in="SourceGraphic" in2="cloud" operator="in"/></filter>
<radialGradient id="${id}g" cx="${n(cx / W * 100)}%" cy="${n(cy / H * 100)}%" r="${n(Math.max(rx / W, ry / H) * 100)}%" gradientTransform="translate(${n(cx / W)} ${n(cy / H)}) scale(1 ${n((ry / H) / (rx / W) * 100) / 100}) translate(${n(-cx / W)} ${n(-cy / H)})"><stop offset="0" stop-color="${body}" stop-opacity="${opacity}"/><stop offset=".55" stop-color="${edge}" stop-opacity="${n(opacity * 0.5 * 100) / 100}"/><stop offset="1" stop-color="${edge}" stop-opacity="0"/></radialGradient>`
}

const TWINKLE = `.tw{animation:tw 4s ease-in-out infinite alternate}@keyframes tw{from{opacity:1}to{opacity:.25}}@media (prefers-reduced-motion:reduce){.tw{animation:none}}`

// ── knot.svg ─────────────────────────────────────────────────────────────────

// One cycle is P loops. The app's working knot takes 2.4 s a loop, which is too busy for a page
// people read (Colin, 10 Nov 2026), so the pictures turn at 8 s a loop, at 15 frames a second:
// smooth enough to read as motion. Every frame is stored in the file, so the frame rate is paid in
// size (about 1 MB each); the strand is drawn with fewer segments to keep it there.
const LOOP = 8
const PER_LOOP = 15 * LOOP

function knotSvg() {
  const S = 240
  const pad = 20
  const W = S + pad * 2
  const k = knotFrames({ S, frames: PER_LOOP * P, segs: 84, prefix: 'k', x: pad, y: pad, seconds: LOOP * P })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}" role="img" aria-label="The Knot, workshop's mark: a cinquefoil, the (2,5) torus knot, turning, a pulse riding its strand">
<title>The Knot</title>
<defs>${SKY_DEFS}<clipPath id="disc"><circle cx="${W / 2}" cy="${W / 2}" r="${W / 2}"/></clipPath></defs>
<style>${k.style}${TWINKLE}</style>
<g clip-path="url(#disc)"><rect width="${W}" height="${W}" fill="url(#deep)"/>${stars(W, W, 70, 7)}</g>
${k.body}
</svg>
`
}

// ── banner.svg ───────────────────────────────────────────────────────────────

function bannerSvg() {
  const W = 1280
  const H = 400
  const S = 300
  const kx = 104
  const ky = (H - S) / 2
  const k = knotFrames({ S, frames: PER_LOOP * P, segs: 80, prefix: 'b', x: kx, y: ky, seconds: LOOP * P })
  // "workshop" and the tagline, set from their outlines beside the knot.
  const word = words.word
  const wordSize = 150
  const ws = wordSize / word.unitsPerEm
  const wx = kx + S + 36
  const baseline = H / 2 + 22
  const tag = words.tagline
  const tagSize = 25
  const ts = tagSize / tag.unitsPerEm
  const tagBase = baseline + 58
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="workshop: Claude Code sessions in one window, and tiles anyone can build">
<title>workshop</title>
<defs>${SKY_DEFS}
${nebula('n1', W, H, 1010, 120, 380, 190, ['#8b5cff', '#2a8cff'], 11, 0.5)}
${nebula('n2', W, H, 300, 330, 420, 150, ['#ff3d9a', '#5b3cff'], 4, 0.32)}
<linearGradient id="dust" x1="0" y1="1" x2="1" y2="0"><stop offset=".2" stop-color="#786eaa" stop-opacity="0"/><stop offset=".5" stop-color="#786eaa" stop-opacity=".14"/><stop offset=".8" stop-color="#786eaa" stop-opacity="0"/></linearGradient>
<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${space.ink}"/></linearGradient>
</defs>
<style>${k.style}${TWINKLE}</style>
<rect width="${W}" height="${H}" fill="url(#deep)"/>
<rect width="${W}" height="${H}" fill="url(#dust)"/>
<rect width="${W}" height="${H}" fill="url(#n1g)" filter="url(#n1)"/>
<rect width="${W}" height="${H}" fill="url(#n2g)" filter="url(#n2)"/>
${stars(W, H, 320, 3, (x, y) => x > kx + 20 && x < kx + S - 20 && y > ky + 20 && y < ky + S - 20)}
${k.body}
<path transform="translate(${wx} ${baseline}) scale(${n(ws * 10000) / 10000})" fill="url(#ink)" d="${word.d}"/>
<path transform="translate(${wx + 6} ${tagBase}) scale(${n(ts * 10000) / 10000})" fill="${space.muted}" d="${tag.d}"/>
</svg>
`
}

// ── knot-icon.svg ────────────────────────────────────────────────────────────

/** The still Knot on a dark disc: the project page's favicon. One frame, the phase the app holds still at. */
function iconSvg() {
  const S = 64
  const paths = strokes(S - 8, 1.1 * TAU, knotPalette(space, 'work'), 72)
    .map(([colour, width, x1, y1, x2, y2]) => `<path d="M${n(x1 + 4)} ${n(y1 + 4)}L${n(x2 + 4)} ${n(y2 + 4)}" stroke="${colour}" stroke-width="${width}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}" fill="${space.bg}"/><g fill="none" stroke-linecap="round">${paths}</g></svg>
`
}

for (const [name, svg] of [
  ['knot.svg', knotSvg()],
  ['knot-icon.svg', iconSvg()],
  ['banner.svg', bannerSvg()]
]) {
  writeFileSync(join(out, name), svg)
  console.log(`docs/assets/${name}  ${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB`)
}
