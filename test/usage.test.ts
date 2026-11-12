import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexWindow, mergeCodex, money, timeLeft, usageLevel, windowLabel, windowName, type Usage } from '@shared/usage'
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

describe("Codex's windows (account/rateLimits, codex-cli 0.167.1)", () => {
  const now = 1_794_441_625_000
  // A free plan's snapshot as the real CLI gave it (11 Nov 2026): one 30-day window, no secondary.
  const free = { limitId: 'codex', limitName: null, primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1797015329 }, secondary: null, planType: 'free', credits: null }
  it('labels a window by its length', () => {
    expect([300, 10080, 43200, 1440, 30, null].map(windowLabel)).toEqual(['5h', 'week', '30d', '1d', '30m', '—'])
    expect([300, 10080, 43200].map(windowName)).toEqual(['5-hour window', 'weekly window', '30-day window'])
  })
  it('reads a window: seconds to ms, its length kept; nothing usable is null', () => {
    expect(codexWindow(free.primary)).toEqual({ pct: 1, resetsAt: 1797015329000, mins: 43200 })
    expect(codexWindow({ usedPercent: 5, windowDurationMins: null, resetsAt: null })).toBeNull()
    expect(codexWindow(null)).toBeNull()
  })
  it("a free plan: one window, its plan", () => {
    expect(mergeCodex(null, free, now)).toEqual({ primary: { pct: 1, resetsAt: 1797015329000, mins: 43200 }, secondary: null, plan: 'free' })
  })
  it('an update is sparse: a window not given keeps the last one; further into a window climbs; a later window replaces', () => {
    const cur = mergeCodex(null, { ...free, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now / 1000 + 3600 } }, now)!
    const up = mergeCodex(cur, { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 1797015329 }, secondary: null, planType: null }, now)!
    expect(up.primary?.pct).toBe(3)
    expect(up.secondary?.pct).toBe(40)
    expect(up.plan).toBe('free')
    const older = mergeCodex(up, { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 43200, resetsAt: 1797015329 } }, now)!
    expect(older.primary?.pct).toBe(3)
    const next = mergeCodex(up, { limitId: 'codex', secondary: { usedPercent: 1, windowDurationMins: 300, resetsAt: now / 1000 + 5 * 3600 } }, now)!
    expect(next.secondary?.pct).toBe(1)
  })
  it("another bucket is not the plan's, and junk changes nothing", () => {
    expect(mergeCodex(null, { ...free, limitId: 'other' }, now)).toBeNull()
    expect(mergeCodex(null, { limitId: null, primary: free.primary }, now)?.primary?.pct).toBe(1)
    expect(mergeCodex(null, 'x', now)).toBeNull()
  })
  it('the tracker keeps them across a restart and drops a window that has reset', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ws-usage-')), 'usage.json')
    const pushed: Usage[] = []
    const t = new UsageTracker(file, (u) => pushed.push(u))
    t.setCodex({ ...free, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
    expect(pushed.at(-1)?.codex).toMatchObject({ primary: { pct: 12, mins: 300 }, secondary: null, plan: 'free' })
    t.setCodex({ ...free, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
    expect(pushed).toHaveLength(1)
    expect(new UsageTracker(file, () => undefined).get().codex).toMatchObject({ primary: { pct: 12, mins: 300 }, plan: 'free' })
    expect(JSON.parse(readFileSync(file, 'utf8')).codex.plan).toBe('free')
    const gone = new UsageTracker(file, () => undefined)
    gone.setCodex({ limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1 } })
    expect(gone.get().codex?.primary?.pct).toBe(12)
  })
})
