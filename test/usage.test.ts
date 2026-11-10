import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { money, timeLeft, usageLevel, type Usage } from '@shared/usage'
import { UsageTracker } from '../src/main/usage'

describe('usage words', () => {
  it('levels at 70 and 90', () => {
    expect(usageLevel(0)).toBe('ok')
    expect(usageLevel(69.9)).toBe('ok')
    expect(usageLevel(70)).toBe('warn')
    expect(usageLevel(90)).toBe('hot')
  })
  it('time left, short', () => {
    const now = 1_000_000
    expect(timeLeft(now + 47 * 60_000, now)).toBe('47m')
    expect(timeLeft(now + (2 * 60 + 4) * 60_000, now)).toBe('2h 04m')
    expect(timeLeft(now + (3 * 24 + 4) * 3_600_000, now)).toBe('3d 4h')
    expect(timeLeft(now - 5000, now)).toBe('0m')
  })
  it('money', () => {
    expect(money(0)).toBe('$0')
    expect(money(0.004)).toBe('<$0.01')
    expect(money(1.234)).toBe('$1.23')
    expect(money(140.6)).toBe('$141')
  })
})

describe('UsageTracker', () => {
  const tracker = () => {
    const pushed: Usage[] = []
    const file = join(mkdtempSync(join(tmpdir(), 'ws-usage-')), 'usage.json')
    return { t: new UsageTracker(file, (u) => pushed.push(u)), pushed, file }
  }
  const soon = () => Math.floor(Date.now() / 1000) + 3600

  it('keeps each session\'s context and cost, and keeps the last known one when a report leaves it out', () => {
    const { t } = tracker()
    t.onStatus('aaa', { context_window: { used_percentage: 17.4 }, cost: { total_cost_usd: 1.23456 } })
    t.onStatus('aaa', { cost: { total_cost_usd: 2 } })
    expect(t.get().sessions.aaa).toEqual({ context: 17, costUsd: 2 })
    t.forget('aaa')
    expect(t.get().sessions.aaa).toBeUndefined()
  })

  it('takes the highest percentage within a window, and saves the windows to disk', () => {
    const { t, file } = tracker()
    const r = soon()
    t.onStatus('a', { rate_limits: { five_hour: { used_percentage: 40, resets_at: r } } })
    t.onStatus('b', { rate_limits: { five_hour: { used_percentage: 30, resets_at: r } } })
    expect(t.get().fiveHour?.pct).toBe(40)
    expect(JSON.parse(readFileSync(file, 'utf8')).fiveHour.pct).toBe(40)
  })

  it('ignores a window that has already reset, and nonsense values', () => {
    const { t } = tracker()
    t.onStatus('a', { rate_limits: { five_hour: { used_percentage: 50, resets_at: Math.floor(Date.now() / 1000) - 10 } }, context_window: { used_percentage: 'x' }, cost: { total_cost_usd: -1 } })
    expect(t.get().fiveHour).toBeNull()
    expect(t.get().sessions.a).toEqual({ context: null, costUsd: null })
  })

  it('pushes only on a change', () => {
    const { t, pushed } = tracker()
    t.onStatus('a', { cost: { total_cost_usd: 1 } })
    t.onStatus('a', { cost: { total_cost_usd: 1 } })
    expect(pushed.length).toBe(1)
  })
})
