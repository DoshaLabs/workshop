import { describe, expect, it } from 'vitest'
import { CAPTION_MAX, CROP_MIN, CROP_RATIO, clampCrop, cleanCaption, cropName, initialCrop, mimeOf, pageGetsFolder, resizeCrop, sniffKind, viewKindOf, wrapLines } from '../src/shared/viewer'

describe('viewer: which files open in the lightbox', () => {
  it('routes pictures, PDFs, web pages, films and sounds by name, any case', () => {
    expect(viewKindOf('/tmp/ld.png')).toBe('image')
    expect(viewKindOf('Shot.JPEG')).toBe('image')
    expect(viewKindOf('logo.svg')).toBe('image')
    expect(viewKindOf('report.pdf')).toBe('pdf')
    expect(viewKindOf('deck/index.html')).toBe('html')
    expect(viewKindOf('take.mov')).toBe('video')
    expect(viewKindOf('voice.m4a')).toBe('audio')
  })
  it('leaves text, markdown and the unknown to the pane', () => {
    for (const n of ['plan.md', 'code.ts', 'data.bin', 'Makefile', '.png', 'dir.png/notes.txt']) expect(viewKindOf(n)).toBeNull()
  })
  it('knows a picture or a PDF with no telling name by its first bytes', () => {
    expect(sniffKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({ kind: 'image', mime: 'image/png' })
    expect(sniffKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg')
    expect(sniffKind(new TextEncoder().encode('%PDF-1.7\n'))?.kind).toBe('pdf')
    expect(sniffKind(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp')
    expect(sniffKind(new Uint8Array([0, 1, 2, 3, 0, 255]))).toBeNull()
  })
  it('serves by name, never guessing a type for the unknown', () => {
    expect(mimeOf('a.html')).toBe('text/html')
    expect(mimeOf('a.pdf')).toBe('application/pdf')
    expect(mimeOf('a.bin')).toBe('application/octet-stream')
  })
  it('gives a web page its folder only inside an open session\'s folder or project (Colin, 12 Nov 2026)', () => {
    const home = '/Users/me'
    const folders = ['/Users/me/code/app/sub', '/Users/me/code/app']
    expect(pageGetsFolder('/Users/me/code/app/report.html', folders, home)).toBe(true)
    expect(pageGetsFolder('/Users/me/code/app/out/deep/report.html', folders, home)).toBe(true)
    expect(pageGetsFolder('/Users/me/Downloads/page.html', folders, home)).toBe(false)
    expect(pageGetsFolder('/Users/me/code/application/page.html', folders, home)).toBe(false)
    expect(pageGetsFolder('/Users/me/code/page.html', folders, home)).toBe(false)
    expect(pageGetsFolder('/Users/me/Downloads/page.html', ['/Users/me', '/'], home)).toBe(false)
    expect(pageGetsFolder('/Users/me/page.html', ['/Users/me'], home)).toBe(false)
    expect(pageGetsFolder('/x/page.html', [], home)).toBe(false)
  })
})

describe('the 9:16 crop', () => {
  const ratio = (c: { w: number; h: number }) => c.w / c.h
  it('starts as the largest 9:16 box, centred', () => {
    const c = initialCrop(1920, 1080)
    expect(c.h).toBe(1080)
    expect(c.w).toBeCloseTo(607.5)
    expect(c.x).toBeCloseTo((1920 - 607.5) / 2)
    expect(c.y).toBe(0)
    const tall = initialCrop(900, 3000)
    expect(tall).toMatchObject({ x: 0, w: 900, h: 1600, y: 700 })
  })
  it('stays inside the picture, 9:16, and no smaller than the least', () => {
    const c = clampCrop({ x: -50, y: 900, w: 10, h: 3 }, 1920, 1080)
    expect(ratio(c)).toBeCloseTo(CROP_RATIO)
    expect(c.x).toBe(0)
    expect(c.y + c.h).toBeLessThanOrEqual(1080)
    expect(c.w).toBeCloseTo(607.5 * CROP_MIN)
    const big = clampCrop({ x: 0, y: 0, w: 5000, h: 5000 }, 1920, 1080)
    expect(big.h).toBeCloseTo(1080)
  })
  it('sizes from the corner, the top left held, never past the edge', () => {
    const start = { x: 100, y: 100, w: 90, h: 160 }
    const r = resizeCrop(start, 280, 200, 1920, 1080)
    expect(r.x).toBe(100)
    expect(r.y).toBe(100)
    expect(r.w).toBeCloseTo(180)
    expect(ratio(r)).toBeCloseTo(CROP_RATIO)
    const far = resizeCrop(start, 5000, 5000, 1920, 1080)
    expect(far.y + far.h).toBeLessThanOrEqual(1080 + 1e-9)
    expect(far.x).toBe(100)
  })
})

describe('captions', () => {
  it('keeps plain text and a source line, capped', () => {
    expect(cleanCaption({ text: '  A  heron\nat dawn ', source: 'Wikipedia Photo of the Day, 11/12/26' })).toEqual({
      text: 'A heron at dawn',
      source: 'Wikipedia Photo of the Day, 11/12/26'
    })
    expect(cleanCaption({ text: 'x'.repeat(1000) })!.text).toHaveLength(CAPTION_MAX)
    expect(cleanCaption({ text: '   ' })).toBeNull()
    expect(cleanCaption('a string')).toBeNull()
    expect(cleanCaption({ text: 'a', source: '' })).toEqual({ text: 'a' })
  })
  it('wraps by width, a long word on a line of its own', () => {
    const m = (s: string) => s.length
    expect(wrapLines('the quick brown fox jumps', 10, m)).toEqual(['the quick', 'brown fox', 'jumps'])
    expect(wrapLines('a supercalifragilistic b', 10, m)).toEqual(['a', 'supercalifragilistic', 'b'])
    expect(wrapLines('', 10, m)).toEqual([])
  })
  it('names the saved crop after the picture', () => {
    expect(cropName('Heron at dawn.jpg')).toBe('Heron at dawn 9x16.png')
    expect(cropName('.png')).toBe('picture 9x16.png')
  })
})
