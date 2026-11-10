import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '@shared/markdown'

describe('parseMarkdown', () => {
  it('blocks: heading, paragraph, list with tasks and nesting, code, table, quote, rule', () => {
    const md = [
      '# Plan',
      'First line',
      'joins the second.',
      '',
      '- [x] done',
      '- [ ] open',
      '  - nested',
      '',
      '1. one',
      '',
      '```ts',
      'const a = 1',
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '> quoted',
      '---'
    ].join('\n')
    const b = parseMarkdown(md)
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'list', 'list', 'code', 'table', 'quote', 'hr'])
    expect(b[1]).toEqual({ t: 'p', inl: [{ t: 'text', v: 'First line joins the second.' }] })
    const tasks = b[2] as Extract<(typeof b)[number], { t: 'list' }>
    expect(tasks.items.map((i) => i.task)).toEqual([true, false])
    expect(tasks.items[1].kids).toMatchObject({ t: 'list', items: [{ inl: [{ t: 'text', v: 'nested' }] }] })
    expect(b[3]).toMatchObject({ t: 'list', ordered: true })
    expect(b[4]).toEqual({ t: 'code', lang: 'ts', text: 'const a = 1' })
    expect(b[5]).toMatchObject({ t: 'table', head: [[{ v: 'a' }], [{ v: 'b' }]], rows: [[[{ v: '1' }], [{ v: '2' }]]] })
  })
  it('an unclosed fence takes the rest', () => {
    expect(parseMarkdown('```\nx\ny')).toEqual([{ t: 'code', lang: '', text: 'x\ny' }])
  })
})

describe('parseInline', () => {
  it('code, bold, italic, links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.org) https://y.org')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'b', kids: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'i', kids: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'a', href: 'https://x.org', kids: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' ' },
      { t: 'a', href: 'https://y.org', kids: [{ t: 'text', v: 'https://y.org' }] }
    ])
  })
  it('a link is http(s) only, and snake_case is not italic', () => {
    expect(parseInline('[x](javascript:alert(1))').some((n) => n.t === 'a')).toBe(false)
    expect(parseInline('use my_var_name here')).toEqual([{ t: 'text', v: 'use my_var_name here' }])
  })
  it('markup in text stays text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }])
  })
})
