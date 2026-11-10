import { describe, expect, it } from 'vitest'
import { cleanSettings } from '../src/main/settings'

describe('cleanSettings', () => {
  it('keeps known values and drops the rest', () => {
    expect(cleanSettings({ theme: 'nord', appearance: 'dark', extra: 1 })).toEqual({ theme: 'nord', appearance: 'dark' })
    expect(cleanSettings({ theme: 'nope', appearance: 'dim' })).toEqual({ theme: 'cosmos', appearance: 'system' })
    expect(cleanSettings(null)).toEqual({ theme: 'cosmos', appearance: 'system' })
    expect(cleanSettings({ theme: 'nope' }, { theme: 'nord', appearance: 'light' })).toEqual({ theme: 'nord', appearance: 'light' })
  })
})
