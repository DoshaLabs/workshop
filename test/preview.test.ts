import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '@shared/markdown'
import { PREVIEW_MAX, toggleTask } from '@shared/preview'
import { readDoc, resolveRef, tickTask, writeDoc } from '../src/main/preview'

const md = ['# Plan', '', '- [ ] first', '- [x] second', '  - [ ] nested', '1. [ ] numbered', '> - [ ] quoted', '', '```', '- [ ] in code', '```'].join('\n')

describe('task lines in the markdown tree', () => {
  it('each task item knows its line in the source, nested and quoted ones too', () => {
    const b = parseMarkdown(md)
    const list = b[1] as Extract<(typeof b)[number], { t: 'list' }>
    // The numbered item runs on in the same list (the parser joins adjacent list lines).
    expect(list.items.map((i) => i.line)).toEqual([2, 3, 5])
    expect((list.items[1].kids as typeof list).items[0].line).toBe(4)
    const quote = b[2] as Extract<(typeof b)[number], { t: 'quote' }>
    expect((quote.blocks[0] as typeof list).items[0].line).toBe(6)
    // A plain item has none; a box inside a code fence is not a task at all.
    expect(parseMarkdown('- plain').map((x) => (x as typeof list).items[0].line)).toEqual([undefined])
  })
})

describe('toggleTask', () => {
  it('flips the one mark and changes nothing else', () => {
    const r = toggleTask(md, 2, false)
    expect('text' in r && r.text).toBe(md.replace('- [ ] first', '- [x] first'))
    const back = toggleTask(md, 3, true)
    expect('text' in back && back.text).toBe(md.replace('- [x] second', '- [ ] second'))
  })
  it('works on nested, numbered and quoted items, and keeps CRLF line ends', () => {
    for (const line of [4, 5, 6]) {
      const r = toggleTask(md, line, false)
      if (!('text' in r)) throw new Error(r.error)
      const a = md.split('\n')
      const b = r.text.split('\n')
      expect(b.filter((l, i) => l !== a[i]).length).toBe(1)
      expect(b[line]).toBe(a[line].replace('[ ]', '[x]'))
    }
    const crlf = '- [ ] a\r\n- [ ] b\r\n'
    const r = toggleTask(crlf, 1, false)
    expect('text' in r && r.text).toBe('- [ ] a\r\n- [x] b\r\n')
  })
  it('refuses a line that is not the task it was', () => {
    expect(toggleTask(md, 2, true)).toHaveProperty('error') // it is not ticked
    expect(toggleTask(md, 0, false)).toHaveProperty('error') // a heading
    expect(toggleTask(md, 99, false)).toHaveProperty('error')
    expect(toggleTask(md, -1, false)).toHaveProperty('error')
  })
})

describe('main/preview: reading and writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-preview-'))
  const file = (name: string, body: string | Buffer): string => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  }

  it('reads markdown and text, and refuses folders, binaries, large and missing files politely', async () => {
    expect(await readDoc(file('a.md', '# hi'))).toMatchObject({ kind: 'markdown', text: '# hi', name: 'a.md' })
    expect(await readDoc(file('b.ts', 'const x = 1'))).toMatchObject({ kind: 'text', text: 'const x = 1' })
    expect(await readDoc(dir)).toMatchObject({ kind: 'refused', note: expect.stringMatching(/folder/) })
    expect(await readDoc(file('c.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])))).toMatchObject({ kind: 'refused', note: expect.stringMatching(/binary/) })
    expect(await readDoc(file('big.txt', 'x'.repeat(PREVIEW_MAX + 1)))).toMatchObject({ kind: 'refused', note: expect.stringMatching(/too large/) })
    expect(await readDoc(join(dir, 'nope.md'))).toMatchObject({ kind: 'refused', missing: true })
  })

  it('resolves a relative path against the session folder, and ~ against home', () => {
    expect(resolveRef('notes/a.md', '/work/proj')).toBe('/work/proj/notes/a.md')
    expect(resolveRef('/etc/hosts', '/work')).toBe('/etc/hosts')
    expect(resolveRef('~/x.md')).toMatch(/\/x\.md$/)
    expect(resolveRef('~/x.md')).not.toContain('~')
  })

  it('ticks a box on disk, one byte, keeping the file mode', async () => {
    const p = file('tasks.md', md)
    chmodSync(p, 0o640)
    const doc = await readDoc(p)
    const r = await tickTask(p, 2, false, doc.mtime)
    expect(r.ok).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(md.replace('- [ ] first', '- [x] first'))
    expect(statSync(p).mode & 0o777).toBe(0o640)
  })

  it('refuses a write over a file that changed since it was read', async () => {
    const p = file('stale.md', '- [ ] a\n')
    const doc = await readDoc(p)
    writeFileSync(p, '- [ ] a\n- [ ] b\n')
    utimesSync(p, new Date(), new Date(Date.now() + 5000))
    const r = await writeDoc(p, 'mine', doc.mtime)
    expect(r).toMatchObject({ ok: false, stale: true })
    expect(readFileSync(p, 'utf8')).toBe('- [ ] a\n- [ ] b\n')
    const t = await tickTask(p, 0, false, doc.mtime)
    expect(t).toMatchObject({ ok: false, stale: true })
  })

  it('saves an edit through a symlink, leaving the link a link', async () => {
    const real = file('real.txt', 'one')
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)
    const doc = await readDoc(link)
    const r = await writeDoc(link, 'two', doc.mtime)
    expect(r.ok).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('two')
    expect(statSync(link, { throwIfNoEntry: false })?.isFile()).toBe(true)
    expect(readFileSync(link, 'utf8')).toBe('two')
  })

  it('will not write a file that is not UTF-8', async () => {
    mkdirSync(join(dir, 'latin'), { recursive: true })
    const p = file('latin/l1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const doc = await readDoc(p)
    const r = await writeDoc(p, 'café', doc.mtime)
    expect(r).toMatchObject({ ok: false })
    expect(readFileSync(p)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  })
})
