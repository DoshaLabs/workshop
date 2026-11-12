import { describe, expect, it } from 'vitest'
import { mimeOf, sniffKind, viewKindOf } from '../src/shared/viewer'

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
})
