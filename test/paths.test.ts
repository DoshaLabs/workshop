import { describe, expect, it } from 'vitest'
import { isPathRef, linkPaths, pathRefs, splitRef } from '@shared/paths'

describe('pathRefs', () => {
  it('finds absolute, ~, relative and bare references, with their line', () => {
    const refs = pathRefs('see /etc/hosts, ~/notes/todo.md:12, ./bin/x.mjs and src/main/index.ts:40 or package.json')
    expect(refs.map((r) => [r.path, r.line])).toEqual([
      ['/etc/hosts', null],
      ['~/notes/todo.md', 12],
      ['./bin/x.mjs', null],
      ['src/main/index.ts', 40],
      ['package.json', null]
    ])
  })
  it('leaves URLs, words and fractions alone', () => {
    expect(pathRefs('https://example.com/a/b.ts and and/or, 1/2, e.g.')).toEqual([])
  })
})

describe('isPathRef and splitRef', () => {
  it('a code span that is one reference', () => {
    expect(isPathRef('src/App.tsx')).toBe(true)
    expect(isPathRef('index.ts:42')).toBe(true)
    expect(isPathRef('npm run smoke')).toBe(false)
    expect(isPathRef('const x')).toBe(false)
  })
  it('splits off a line, and a column after it', () => {
    expect(splitRef('a/b.ts:12')).toEqual({ path: 'a/b.ts', line: 12 })
    expect(splitRef('a/b.ts:12:5')).toEqual({ path: 'a/b.ts', line: 12 })
    expect(splitRef('a/b.ts')).toEqual({ path: 'a/b.ts', line: null })
  })
})

describe('linkPaths: running text', () => {
  it('links only references with a slash in them', () => {
    expect(linkPaths('Edited src/main/preview.ts:9 and README.md in Node.js')).toEqual([
      { t: 'text', v: 'Edited ' },
      { t: 'path', v: 'src/main/preview.ts:9', path: 'src/main/preview.ts', line: 9 },
      { t: 'text', v: ' and README.md in Node.js' }
    ])
  })
  it('text without a path is one piece', () => {
    expect(linkPaths('nothing here')).toEqual([{ t: 'text', v: 'nothing here' }])
    expect(linkPaths('')).toEqual([])
  })
})
