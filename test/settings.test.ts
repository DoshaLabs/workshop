import { describe, expect, it } from 'vitest'
import { cleanSettings } from '../src/main/settings'

describe('cleanSettings', () => {
  it('keeps known values and drops the rest', () => {
    expect(cleanSettings({ theme: 'nord', appearance: 'dark', extra: 1, devTiles: ['/a', 'rel', 7, '/a'] })).toEqual({ theme: 'nord', appearance: 'dark', devTiles: ['/a'] })
    expect(cleanSettings({ theme: 'nope', appearance: 'dim' })).toEqual({ theme: 'cosmos', appearance: 'system', devTiles: [] })
    expect(cleanSettings(null)).toEqual({ theme: 'cosmos', appearance: 'system', devTiles: [] })
    expect(cleanSettings({ theme: 'nope' }, { theme: 'nord', appearance: 'light', devTiles: [] })).toEqual({ theme: 'nord', appearance: 'light', devTiles: [] })
  })
})
