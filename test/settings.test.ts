import { describe, expect, it } from 'vitest'
import { cleanSettings } from '../src/main/settings'

describe('cleanSettings', () => {
  it('keeps known values and drops the rest', () => {
    expect(cleanSettings({ theme: 'nord', appearance: 'dark', extra: 1, devTiles: ['/a', 'rel', 7, '/a'] })).toEqual({ theme: 'nord', appearance: 'dark', devTiles: ['/a'], mascot: null })
    expect(cleanSettings({ theme: 'nope', appearance: 'dim' })).toEqual({ theme: 'robin', appearance: 'system', devTiles: [], mascot: null })
    expect(cleanSettings(null)).toEqual({ theme: 'robin', appearance: 'system', devTiles: [], mascot: null })
    expect(cleanSettings({ theme: 'nope' }, { theme: 'nord', appearance: 'light', devTiles: [], mascot: null })).toEqual({ theme: 'nord', appearance: 'light', devTiles: [], mascot: null })
  })
  it('keeps the active sprite pack by its folder name, or none', () => {
    expect(cleanSettings({ mascot: 'foxtrot' }).mascot).toBe('foxtrot')
    expect(cleanSettings({ mascot: '../etc' }).mascot).toBe(null)
    expect(cleanSettings({ mascot: null }, { theme: 'nord', appearance: 'light', devTiles: [], mascot: 'pip' }).mascot).toBe(null)
    expect(cleanSettings({}, { theme: 'nord', appearance: 'light', devTiles: [], mascot: 'pip' }).mascot).toBe('pip')
  })
})
