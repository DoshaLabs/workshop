// THE COSMOS THEME's wall ("Deep Space"): a flight through a field of stars with nebulae drifting
// past, painted on two canvases behind the whole window (`.cosmos-wall` in styles.css). Every pane
// is a see-through sheet over it (the `[data-wall='true']` rules), the terminal included.
//
// The sky is a little 3D world seen down the line of flight. STARS sit in a box ahead and come on
// at `STAR_SPEED`; each projects as (x / z, y / z) from a VANISHING POINT that wanders slowly
// round the middle of the window with a slight roll, so the ship is steering, not on rails. A
// star that passes the camera or leaves the window starts again far ahead. NEBULAE are the same,
// further off and slower: a procedural cloud each (domain-warped fbm, a palette of two or three
// hues, an irregular edge), generated when it is born, fading in from the distance and out as it
// slides past, three in flight at once and staggered. Behind them, a fixed backdrop of faint
// distant stars and dust that only pans with the heading.
//
// Cost: the nebula canvas is drawn at half resolution (it is soft anyway) and the stars at the
// screen's own; both at `FPS`, nothing at all while the window is hidden, and one still frame
// under `prefers-reduced-motion`. Carried over from deck's lib/cosmos.ts.

import { COSMOS_ID } from '@shared/themes'

const FPS = 30
const STARS = 650
/** Depth units a second: a star is ahead of the camera for ~30s. */
const STAR_SPEED = 0.032
const NEBULAE = 3
const NEB_SPEED = 0.018
const NEB_FAR = 2.2
const NEB_NEAR = 0.22
/** Side of a nebula's texture (it is drawn far larger, smoothed). */
const NEB_TEX = 224
/** The nebula canvas's resolution against CSS pixels. */
const NEB_RES = 0.5

const STAR_COLORS = ['#ffffff', '#ffffff', '#e4ecff', '#cbdcff', '#aac4ff', '#fff3dc', '#ffdcb4', '#ffb9a0']
/** Each nebula takes one of these: [body, edge, core]. */
const NEB_PALETTES: [string, string, string][] = [
  ['#ff3d9a', '#5b3cff', '#ffd1ec'],
  ['#21d4c4', '#2f5cff', '#d9fff8'],
  ['#ff7a35', '#d42a6a', '#ffe6b0'],
  ['#8b5cff', '#2a8cff', '#efe2ff'],
  ['#3ad6ff', '#9c3cff', '#e6f9ff'],
  ['#ff5468', '#ff9d3a', '#fff0d0']
]

interface Star {
  x: number
  y: number
  z: number
  color: string
  size: number
  phase: number
  /** Last projected position, for the streak; NaN = just born. */
  px: number
  py: number
}

interface Nebula {
  x: number
  y: number
  z: number
  /** World size: its width at depth 1 as a fraction of the projection's focal length. */
  size: number
  spin: number
  tex: HTMLCanvasElement
}

let wall: HTMLDivElement | null = null
let nebCanvas: HTMLCanvasElement | null = null
let starCanvas: HTMLCanvasElement | null = null
let backdrop: HTMLCanvasElement | null = null
let glow: HTMLCanvasElement | null = null
let stars: Star[] = []
let nebulae: Nebula[] = []
let raf = 0
let last = 0
let t = 0
let w = 0
let h = 0
let dpr = 1
let seed = (Date.now() % 100000) + 1

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

function rand(): number {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296
}

// ---- noise: value noise on a hashed lattice, summed into fbm ----

function hash(ix: number, iy: number, s: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 2147483647)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

function noise(x: number, y: number, s: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy, s)
  const b = hash(ix + 1, iy, s)
  const c = hash(ix, iy + 1, s)
  const d = hash(ix + 1, iy + 1, s)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

function fbm(x: number, y: number, s: number, octaves = 5): number {
  let sum = 0
  let amp = 0.5
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, s + i * 17)
    x = x * 2.03 + 11.7
    y = y * 2.03 - 7.3
    amp *= 0.5
  }
  return sum / (1 - Math.pow(0.5, octaves))
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ---- the pieces, made once ----

/** One nebula's cloud: a warped fbm density inside an irregular falloff, coloured body → edge, a lit core. */
function nebulaTexture(): HTMLCanvasElement {
  const n = NEB_TEX
  const c = document.createElement('canvas')
  c.width = c.height = n
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const img = ctx.createImageData(n, n)
  const px = img.data
  const s = Math.floor(rand() * 1e6)
  const pal = NEB_PALETTES[Math.floor(rand() * NEB_PALETTES.length)]
  const [body, edge, core] = pal.map(rgb)
  const freq = 2.2 + rand() * 1.6
  // A lobe pulled off centre makes it less of a blob.
  const lx = (rand() - 0.5) * 0.5
  const ly = (rand() - 0.5) * 0.5
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n - 0.5
      const v = j / n - 0.5
      const qx = fbm(u * freq, v * freq, s, 4)
      const qy = fbm(u * freq + 5.2, v * freq + 1.3, s + 3, 4)
      const d = fbm(u * freq + 2.4 * qx, v * freq + 2.4 * qy, s + 7, 5)
      // Ragged edge: the radius itself is noisy, and a second lobe widens the shape.
      const r1 = Math.hypot(u, v) * 2
      const r2 = Math.hypot(u - lx, v - ly) * 2.4
      const r = Math.min(r1, r2) + (qx - 0.5) * 0.55
      const fall = Math.max(0, 1 - r * r)
      const dens = Math.max(0, d - 0.38) * 2.4 * fall * fall
      if (dens <= 0.002) continue
      const k = Math.min(1, qy * 1.3)
      const hot = Math.max(0, dens - 0.55) * 1.6
      const o = (j * n + i) * 4
      px[o] = Math.min(255, body[0] * (1 - k) + edge[0] * k + core[0] * hot)
      px[o + 1] = Math.min(255, body[1] * (1 - k) + edge[1] * k + core[1] * hot)
      px[o + 2] = Math.min(255, body[2] * (1 - k) + edge[2] * k + core[2] * hot)
      px[o + 3] = Math.min(255, dens * 200)
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** A soft round glow, for the brightest stars. */
function glowSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.12, 'rgba(220,230,255,0.45)')
  g.addColorStop(0.4, 'rgba(160,180,255,0.08)')
  g.addColorStop(1, 'rgba(160,180,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return c
}

/** The far sky: deep space, faint dust and a few thousand stars too far to move. A margin all round for the pan. */
function makeBackdrop(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  const m = 0.12
  c.width = Math.ceil(w * (1 + 2 * m) * dpr)
  c.height = Math.ceil(h * (1 + 2 * m) * dpr)
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const g = ctx.createRadialGradient(c.width * 0.5, c.height * 0.45, 0, c.width * 0.5, c.height * 0.5, Math.max(c.width, c.height) * 0.75)
  g.addColorStop(0, '#0b0d22')
  g.addColorStop(0.6, '#060714')
  g.addColorStop(1, '#020309')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, c.width, c.height)
  // A faint band of dust across the sky, the Milky Way's idea, from a small noise field smoothed up.
  const dn = 96
  const dust = document.createElement('canvas')
  dust.width = dn
  dust.height = Math.round((dn * c.height) / c.width)
  const dctx = dust.getContext('2d')
  if (dctx) {
    const img = dctx.createImageData(dust.width, dust.height)
    const s = Math.floor(rand() * 1e6)
    const tilt = rand() * 0.8 - 0.4
    for (let j = 0; j < dust.height; j++) {
      for (let i = 0; i < dust.width; i++) {
        const u = i / dust.width
        const v = j / dust.height
        const band = Math.exp(-Math.pow((v - 0.5 - (u - 0.5) * tilt) * 3.2, 2))
        const d = fbm(u * 5, v * 5, s, 4) * band
        const o = (j * dust.width + i) * 4
        img.data[o] = 120
        img.data[o + 1] = 110
        img.data[o + 2] = 170
        img.data[o + 3] = Math.max(0, d - 0.25) * 110
      }
    }
    dctx.putImageData(img, 0, 0)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(dust, 0, 0, c.width, c.height)
  }
  const count = Math.round((c.width * c.height) / (2600 * dpr * dpr))
  for (let i = 0; i < count; i++) {
    const x = rand() * c.width
    const y = rand() * c.height
    const a = 0.15 + Math.pow(rand(), 3) * 0.75
    ctx.fillStyle = STAR_COLORS[Math.floor(rand() * STAR_COLORS.length)]
    ctx.globalAlpha = a
    const r = (rand() < 0.04 ? 1.2 : 0.6) * dpr
    ctx.fillRect(x, y, r, r)
  }
  ctx.globalAlpha = 1
  return c
}

function newStar(far: boolean): Star {
  return {
    x: (rand() * 2 - 1) * 1.3,
    y: (rand() * 2 - 1) * 1.3,
    z: far ? 0.85 + rand() * 0.15 : 0.04 + rand() * 0.96,
    color: STAR_COLORS[Math.floor(rand() * STAR_COLORS.length)],
    size: 0.5 + Math.pow(rand(), 4) * 1.6,
    phase: rand() * Math.PI * 2,
    px: NaN,
    py: NaN
  }
}

function newNebula(z: number): Nebula {
  const a = rand() * Math.PI * 2
  const r = 0.15 + rand() * 0.45
  return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.7, z, size: 0.9 + rand() * 0.8, spin: (rand() - 0.5) * 0.6, tex: nebulaTexture() }
}

// ---- the flight ----

/** Where the ship is pointed: the vanishing point (CSS px) and the roll. */
function heading(): { vx: number; vy: number; roll: number } {
  return {
    vx: w * (0.5 + 0.16 * Math.sin(t / 97) + 0.05 * Math.sin(t / 41 + 2)),
    vy: h * (0.5 + 0.12 * Math.sin(t / 131 + 1) + 0.04 * Math.sin(t / 53)),
    roll: 0.09 * Math.sin(t / 173) + 0.03 * Math.sin(t / 61 + 4)
  }
}

function draw(dt: number): void {
  if (!nebCanvas || !starCanvas || !backdrop || !glow) return
  const nctx = nebCanvas.getContext('2d')
  const sctx = starCanvas.getContext('2d')
  if (!nctx || !sctx) return
  const { vx, vy, roll } = heading()
  const f = Math.max(w, h) * 0.55
  const cos = Math.cos(roll)
  const sin = Math.sin(roll)

  // The far sky pans a little against the heading; then the nebulae, added light on it.
  const nr = NEB_RES
  nctx.globalCompositeOperation = 'source-over'
  nctx.globalAlpha = 1
  const mx = (vx - w / 2) * 0.06
  const my = (vy - h / 2) * 0.06
  nctx.drawImage(backdrop, (-w * 0.12 - mx) * nr, (-h * 0.12 - my) * nr, w * 1.24 * nr, h * 1.24 * nr)
  nctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < nebulae.length; i++) {
    const nb = nebulae[i]
    nb.z -= NEB_SPEED * dt
    if (nb.z <= NEB_NEAR) {
      nebulae[i] = newNebula(NEB_FAR)
      continue
    }
    const fadeIn = Math.min(1, (NEB_FAR - nb.z) / 0.45)
    const fadeOut = Math.min(1, (nb.z - NEB_NEAR) / 0.35)
    const alpha = 0.85 * fadeIn * fadeOut
    if (alpha <= 0) continue
    const scale = f / nb.z
    const rx = nb.x * cos - nb.y * sin
    const ry = nb.x * sin + nb.y * cos
    const cx = vx + rx * scale
    const cy = vy + ry * scale
    const size = nb.size * scale
    nctx.save()
    nctx.globalAlpha = alpha
    nctx.translate(cx * nr, cy * nr)
    nctx.rotate(roll + nb.spin)
    nctx.drawImage(nb.tex, (-size / 2) * nr, (-size / 2) * nr, size * nr, size * nr)
    nctx.restore()
  }

  // Stars: projected from the vanishing point, a streak from where each was a frame ago.
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  sctx.clearRect(0, 0, w, h)
  sctx.globalCompositeOperation = 'lighter'
  sctx.lineCap = 'round'
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]
    s.z -= STAR_SPEED * dt
    const rx = s.x * cos - s.y * sin
    const ry = s.x * sin + s.y * cos
    const sx = vx + (rx / s.z) * f
    const sy = vy + (ry / s.z) * f
    if (s.z <= 0.02 || sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) {
      stars[i] = newStar(true)
      continue
    }
    const near = 1 - s.z
    const twinkle = 0.8 + 0.2 * Math.sin(t * 2.3 + s.phase)
    const alpha = Math.min(1, near * 1.4) * twinkle
    const r = Math.min(3, s.size * (0.35 + 0.9 / (s.z * 3 + 0.4)))
    sctx.globalAlpha = alpha
    if (r > 1.6 && s.size > 1.2) {
      const g = r * 7
      sctx.globalAlpha = alpha * 0.55
      sctx.drawImage(glow, sx - g / 2, sy - g / 2, g, g)
      sctx.globalAlpha = alpha
    }
    if (!Number.isNaN(s.px) && Math.hypot(sx - s.px, sy - s.py) > 0.6) {
      sctx.strokeStyle = s.color
      sctx.lineWidth = r
      sctx.beginPath()
      sctx.moveTo(s.px, s.py)
      sctx.lineTo(sx, sy)
      sctx.stroke()
    } else {
      sctx.fillStyle = s.color
      sctx.beginPath()
      sctx.arc(sx, sy, r / 2, 0, Math.PI * 2)
      sctx.fill()
    }
    s.px = sx
    s.py = sy
  }
}

function frame(now: number): void {
  raf = 0
  if (!wall) return
  const dt = last ? (now - last) / 1000 : 0
  if (dt && dt < 1 / FPS - 0.004) {
    raf = requestAnimationFrame(frame)
    return
  }
  last = now
  // A long gap (a stall, a background tab) is not a jump across the sky.
  const step = Math.min(dt, 0.1)
  t += step
  draw(step)
  if (!reduced.matches && !document.hidden) raf = requestAnimationFrame(frame)
}

function start(): void {
  if (raf || !wall) return
  last = 0
  raf = requestAnimationFrame(frame)
}

function resize(): void {
  if (!wall || !nebCanvas || !starCanvas) return
  w = window.innerWidth
  h = window.innerHeight
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  nebCanvas.width = Math.ceil(w * NEB_RES)
  nebCanvas.height = Math.ceil(h * NEB_RES)
  starCanvas.width = Math.ceil(w * dpr)
  starCanvas.height = Math.ceil(h * dpr)
  backdrop = makeBackdrop()
  for (const s of stars) s.px = s.py = NaN
  draw(0)
  start()
}

function build(): void {
  wall = document.createElement('div')
  wall.className = 'cosmos-wall'
  nebCanvas = document.createElement('canvas')
  starCanvas = document.createElement('canvas')
  wall.append(nebCanvas, starCanvas)
  document.body.prepend(wall)
  glow = glowSprite()
  stars = Array.from({ length: STARS }, () => newStar(false))
  // Staggered through the depth so one is always near, one mid-way, one coming.
  nebulae = Array.from({ length: NEBULAE }, (_, i) => newNebula(NEB_NEAR + 0.25 + ((NEB_FAR - NEB_NEAR - 0.25) * (i + rand() * 0.5)) / NEBULAE))
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', start)
  reduced.addEventListener('change', start)
  resize()
}

function teardown(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  window.removeEventListener('resize', resize)
  document.removeEventListener('visibilitychange', start)
  reduced.removeEventListener('change', start)
  wall?.remove()
  wall = nebCanvas = starCanvas = backdrop = null
  stars = []
  nebulae = []
}

/** Settings changed: put the sky up, or take it down. */
export function syncCosmos(themeId: string): void {
  if (themeId === COSMOS_ID) {
    if (!wall) build()
  } else if (wall) teardown()
}
