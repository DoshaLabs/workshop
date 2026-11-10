// Synthetic sprite sheets for the tests: plain coloured blocks laid out on a grid. Never a real
// sheet (CLAUDE.md §8: no part of Elthen's art, or anyone's, lives in this repo).

import { deflateSync } from 'node:zlib'
import type { Pixels } from '../src/shared/mascot'

/**
 * A sheet `cols × rows` frames of `frame` pixels, with `counts[r]` frames drawn on row r. Each
 * drawn frame is a block of `colour` filling `box` (frame coordinates).
 */
export function synthSheet(opts: { frame: { w: number; h: number }; cols: number; counts: number[]; box: { x: number; y: number; w: number; h: number }; colour?: [number, number, number] }): Pixels {
  const { frame, cols, counts, box } = opts
  const colour = opts.colour ?? [200, 120, 60]
  const width = frame.w * cols
  const height = frame.h * counts.length
  const data = new Uint8ClampedArray(width * height * 4)
  counts.forEach((n, r) => {
    for (let c = 0; c < n; c++)
      for (let y = box.y; y < box.y + box.h; y++)
        for (let x = box.x; x < box.x + box.w; x++) {
          const i = ((r * frame.h + y) * width + c * frame.w + x) * 4
          data[i] = colour[0]
          data[i + 1] = colour[1]
          data[i + 2] = colour[2]
          data[i + 3] = 255
        }
  })
  return { width, height, data }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}

/** Encodes pixels as an 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(p: Pixels): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(p.width, 0)
  ihdr.writeUInt32BE(p.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((p.width * 4 + 1) * p.height)
  for (let y = 0; y < p.height; y++) Buffer.from(p.data.buffer, p.data.byteOffset + y * p.width * 4, p.width * 4).copy(raw, y * (p.width * 4 + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
