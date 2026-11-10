// The app's icon: the Knot (CLAUDE.md §8), full size, turning on a tile of Deep Space.
//
//   npm run icon     (runs this under Electron: `electron scripts/icon.mjs`)
//
// Writes build/icon.iconset/ (every size macOS asks for, 16 to 1024, each drawn at its own size,
// not scaled down), build/icon.icns from it (`iconutil`), and build/icon.png (1024), which the dev
// build shows in the Dock (main/index.ts). electron-builder takes build/icon.icns for the app.
//
// The knot is the app's own drawing: `drawKnot` from src/shared/knot.ts with Deep Space's working
// palette (`knotPalette`), recorded stroke by stroke as scripts/knot-svg.mjs does, then painted on
// a canvas in a hidden window. The tile is the macOS icon grid: an 824 px rounded square in a
// 1024 px canvas (100 px margin), a soft shadow under it.
//
// The strand's width: the app tunes it for 24 to 88 px boxes, so above that it is scaled back
// (site/main.ts `large`). At 32 and 64 px it is thickened, or it breaks up into grey dots. At
// 16 px nothing keeps all five lobes apart; a finer strand keeps more of the holes, so the
// silhouette (a violet and gold flower on the dark tile) is what reads there.

import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { module: knot } = await runnerImport(join(root, 'src/shared/knot.ts'))
const { module: themes } = await runnerImport(join(root, 'src/shared/themes.ts'))
const { TAU, MODES, drawKnot, knotPalette } = knot
const space = themes.themeById(themes.COSMOS_ID).dark
const palette = knotPalette(space, 'work')

/** The pose: 1.5 loops in, the cinquefoil faces the viewer with its five petals even and the pulse riding over the top (chosen from an ICON_SHEET survey of 24 phases). */
let PHASE = 1.5 * TAU

/** A seeded random, so the same sky comes out every time (mulberry32, as cosmos.ts uses). */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** How much wider than the app draws it the strand is, for a knot box of S device pixels. */
function widthFactor(S) {
  if (S > 120) return Math.max(0.5, 120 / S + 0.35)
  if (S < 14) return 0.8
  if (S < 30) return 1.35
  if (S < 60) return 1.15
  return 1
}

/** Everything to paint one size, as plain data for the page. */
function plan(N) {
  const u = N / 1024
  const side = 824 * u
  const off = 100 * u
  // The knot's reach is about 2.1 units of the 2.2 drawKnot leaves; this box puts it about 0.8 of
  // the tile across. Small icons have no room to spare, so the knot takes more of the tile.
  const S = side * 0.88
  const k0 = 0
  const f = widthFactor(S)
  const strokes = []
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
      strokes.push([this.strokeStyle, this.lineWidth * f, from[0] + k0, from[1] + k0, x + k0, y + k0])
    },
    stroke() {}
  }
  drawKnot(ctx, { S, ph: PHASE, palette, size: MODES.work.size, segs: Math.max(96, Math.round(S * 0.9)) })
  // The tilt throws the knot off the box's centre: centre it on what is drawn, and grow it until
  // its wider side spans `fill` of the tile.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [, w, ax, ay, bx, by] of strokes) {
    x0 = Math.min(x0, ax - w / 2, bx - w / 2)
    y0 = Math.min(y0, ay - w / 2, by - w / 2)
    x1 = Math.max(x1, ax + w / 2, bx + w / 2)
    y1 = Math.max(y1, ay + w / 2, by + w / 2)
  }
  const fill = N <= 32 ? 0.9 : 0.78
  const sc = (side * fill) / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  for (const s of strokes) {
    s[1] *= sc
    for (const i of [2, 4]) s[i] = N / 2 + (s[i] - cx) * sc
    for (const i of [3, 5]) s[i] = N / 2 + (s[i] - cy) * sc
  }
  // Stars where they can be seen: none on the smallest icons, where they would read as dirt.
  const stars = []
  if (N >= 64) {
    const rand = rng(11)
    const count = N >= 256 ? 90 : 30
    for (let i = 0; i < count; i++) {
      const x = off + rand() * side
      const y = off + rand() * side
      const a = 0.25 + Math.pow(rand(), 3) * 0.7
      const big = rand() < 0.06
      stars.push([x, y, Math.max(0.5, (big ? 2.4 : 1 + rand() * 0.8) * u * 1.6), a])
    }
  }
  return { N, u, side, off, radius: side * 0.225, strokes, stars, bg: space.bg }
}

/** Runs in the page: paints one plan on a canvas and returns it as a PNG data URL. */
function paint(p) {
  const c = document.createElement('canvas')
  c.width = c.height = p.N
  const g = c.getContext('2d')
  const { u, side, off, radius } = p
  const tile = () => {
    g.beginPath()
    g.roundRect(off, off, side, side, radius)
  }
  // The shadow the macOS grid draws under every app icon.
  if (p.N >= 32) {
    g.save()
    g.shadowColor = 'rgba(0,0,0,0.45)'
    g.shadowBlur = 28 * u
    g.shadowOffsetY = 12 * u
    tile()
    g.fillStyle = '#020309'
    g.fill()
    g.restore()
  }
  g.save()
  tile()
  g.clip()
  // Deep Space: a dark indigo well, a violet haze up and to the right, a blue one down and left.
  const deep = g.createRadialGradient(off + side * 0.5, off + side * 0.45, 0, off + side * 0.5, off + side * 0.45, side * 0.75)
  deep.addColorStop(0, '#0e1130')
  deep.addColorStop(0.6, '#070818')
  deep.addColorStop(1, '#020309')
  g.fillStyle = deep
  g.fillRect(off, off, side, side)
  const haze = (x, y, r, colour, a) => {
    const h = g.createRadialGradient(x, y, 0, x, y, r)
    h.addColorStop(0, colour.replace('A', String(a)))
    h.addColorStop(1, colour.replace('A', '0'))
    g.fillStyle = h
    g.fillRect(off, off, side, side)
  }
  haze(off + side * 0.78, off + side * 0.2, side * 0.6, 'rgba(139,92,255,A)', 0.22)
  haze(off + side * 0.18, off + side * 0.85, side * 0.55, 'rgba(42,140,255,A)', 0.14)
  for (const [x, y, r, a] of p.stars) {
    g.globalAlpha = a
    g.fillStyle = '#e4ecff'
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  g.lineCap = 'round'
  for (const [colour, width, x1, y1, x2, y2] of p.strokes) {
    g.strokeStyle = colour
    g.lineWidth = width
    g.beginPath()
    g.moveTo(x1, y1)
    g.lineTo(x2, y2)
    g.stroke()
  }
  g.restore()
  // A hairline of starlight round the edge, so the tile holds its shape on a dark Dock.
  if (p.N >= 32) {
    tile()
    g.strokeStyle = 'rgba(185,156,255,0.22)'
    g.lineWidth = Math.max(1, 3 * u)
    g.stroke()
  }
  return c.toDataURL('image/png')
}

const SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  // ICON_SHEET=<dir>: the icon at 256 px at 24 phases through one cycle, to choose the pose from.
  if (process.env.ICON_SHEET) {
    mkdirSync(process.env.ICON_SHEET, { recursive: true })
    for (let i = 0; i < 24; i++) {
      PHASE = (i / 24) * 2 * TAU
      const url = await win.webContents.executeJavaScript(`(${paint.toString()})(${JSON.stringify(plan(256))})`)
      writeFileSync(join(process.env.ICON_SHEET, `phase-${String(i).padStart(2, '0')}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    }
    return
  }
  const set = join(root, 'build', 'icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  const drawn = new Map()
  for (const [name, N] of SIZES) {
    if (!drawn.has(N)) {
      const url = await win.webContents.executeJavaScript(`(${paint.toString()})(${JSON.stringify(plan(N))})`)
      drawn.set(N, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    }
    writeFileSync(join(set, name), drawn.get(N))
    console.log(`build/icon.iconset/${name}  ${N} px`)
  }
  copyFileSync(join(set, 'icon_512x512@2x.png'), join(root, 'build', 'icon.png'))
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build', 'icon.icns')])
  console.log('build/icon.icns, build/icon.png')
}

// Not awaited at the top: an ES module's top-level await holds back Electron's ready event.
app.dock?.hide()
app.whenReady().then(main).then(
  () => app.quit(),
  (err) => {
    console.error(err)
    app.exit(1)
  }
)
