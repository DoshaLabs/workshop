// USAGE: what the account has left, as Claude Code itself reports it (`workshop.usage` for tiles
// with the "usage" permission). Every session's status line (the `statusLine` of our --settings
// file, main/hooks.ts) POSTs the CLI's status JSON to /hook/status with the session's token: `rate_limits.five_hour / seven_day` (claude.ai subscribers, after a session's first
// API response; `used_percentage` 0–100, `resets_at` epoch seconds) and that session's
// `context_window.used_percentage`, and `cost.total_cost_usd` (what the session has cost so far,
// at list price). The sessions share one account, so the windows are ONE pair: each session only knows them as of its own last response, so the newest window
// wins (the later `resets_at`) and, within a window, the highest percentage (it only climbs).
// These are the CLI's own numbers, never an estimate of ours. The windows are kept in
// the profile's usage.json so a restart does not blank them; per-session figures are in memory.
// Carried over from deck's usage.ts; the session comes from the token, not the payload.

import { readFileSync, writeFileSync } from 'node:fs'
import type { Usage, UsageWindow } from '@shared/usage'

interface StatusPayload {
  context_window?: { used_percentage?: number | null }
  cost?: { total_cost_usd?: number | null }
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>
}

export class UsageTracker {
  private fiveHour: UsageWindow | null = null
  private sevenDay: UsageWindow | null = null
  private at = 0
  private readonly sessions = new Map<string, { context: number | null; costUsd: number | null }>()
  private last = ''

  constructor(
    private readonly file: string,
    private readonly push: (u: Usage) => void
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Usage>
      this.fiveHour = win(raw.fiveHour)
      this.sevenDay = win(raw.sevenDay)
      this.at = Number(raw.at) || 0
    } catch {
      /* nothing kept yet */
    }
  }

  /** /hook/status: the status JSON of session `id` (core's id, known from the caller's token). */
  onStatus(id: string, body: unknown): void {
    const p = (body ?? {}) as StatusPayload
    const ctx = p.context_window?.used_percentage
    const cost = p.cost?.total_cost_usd
    const was = this.sessions.get(id) ?? { context: null, costUsd: null }
    this.sessions.set(id, {
      context: typeof ctx === 'number' && isFinite(ctx) ? Math.round(ctx) : was.context,
      costUsd: typeof cost === 'number' && isFinite(cost) && cost >= 0 ? Math.round(cost * 10000) / 10000 : was.costUsd
    })
    const five = newer(this.fiveHour, p.rate_limits?.five_hour)
    const seven = newer(this.sevenDay, p.rate_limits?.seven_day)
    if (five !== this.fiveHour || seven !== this.sevenDay) {
      this.fiveHour = five
      this.sevenDay = seven
      this.at = Date.now()
      try {
        writeFileSync(this.file, JSON.stringify({ fiveHour: five, sevenDay: seven, at: this.at }))
      } catch {
        /* the header still has it */
      }
    }
    const u = this.get()
    const key = JSON.stringify([u.fiveHour, u.sevenDay, u.sessions])
    if (key === this.last) return
    this.last = key
    this.push(u)
  }

  /**
   * A Codex session's context use, from its app-server. No cost: Codex reports tokens, not dollars
   * (docs/progress/2026-11-11-codex.md), so its cost stays unknown rather than guessed.
   */
  setContext(id: string, pct: number): void {
    const was = this.sessions.get(id) ?? { context: null, costUsd: null }
    if (was.context === pct) return
    this.sessions.set(id, { ...was, context: pct })
    const u = this.get()
    this.last = JSON.stringify([u.fiveHour, u.sevenDay, u.sessions])
    this.push(u)
  }

  /** A session that is gone takes its figures with it. */
  forget(id: string): void {
    this.sessions.delete(id)
  }

  get(): Usage {
    // A window whose reset has passed says nothing about the one that followed.
    const live = (w: UsageWindow | null) => (w && w.resetsAt > Date.now() ? w : null)
    return { fiveHour: live(this.fiveHour), sevenDay: live(this.sevenDay), at: this.at, sessions: Object.fromEntries(this.sessions) }
  }
}

function win(w: unknown): UsageWindow | null {
  const x = w as UsageWindow | null | undefined
  return x && typeof x.pct === 'number' && typeof x.resetsAt === 'number' ? { pct: x.pct, resetsAt: x.resetsAt } : null
}

/** `cur`, or what a session just reported when that is a later window or further into the same one. */
function newer(cur: UsageWindow | null, got: { used_percentage?: number; resets_at?: number } | undefined): UsageWindow | null {
  if (!got || typeof got.used_percentage !== 'number' || typeof got.resets_at !== 'number') return cur
  const next = { pct: Math.round(got.used_percentage * 10) / 10, resetsAt: got.resets_at * 1000 }
  if (next.resetsAt <= Date.now()) return cur
  if (!cur || cur.resetsAt <= Date.now()) return next
  // The same window a minute apart in two sessions' clocks is still the same window.
  if (next.resetsAt > cur.resetsAt + 60_000) return next
  if (next.resetsAt < cur.resetsAt - 60_000) return cur
  return next.pct > cur.pct ? next : cur
}
