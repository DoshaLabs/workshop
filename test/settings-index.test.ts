import { describe, expect, it } from 'vitest'
import { cleanSettings } from '../src/main/settings'

describe('settings: the index address', () => {
  it('keeps an https URL or a file on this Mac, drops anything else, and clears on ""', () => {
    expect(cleanSettings({ index: 'https://example.com/tiles.json' }).index).toBe('https://example.com/tiles.json')
    expect(cleanSettings({ index: '/Users/me/tiles.json' }).index).toBe('/Users/me/tiles.json')
    expect(cleanSettings({ index: 'file:///Users/me/tiles.json' }).index).toBe('file:///Users/me/tiles.json')
    expect('index' in cleanSettings({ index: 'http://example.com/tiles.json' })).toBe(false)
    expect('index' in cleanSettings({ index: 'tiles.json' })).toBe(false)
    const base = cleanSettings({ index: 'https://a.example/tiles.json' })
    expect(cleanSettings({ index: 42 }, base).index).toBe('https://a.example/tiles.json')
    expect('index' in cleanSettings({ index: '' }, base)).toBe(false)
  })
})
