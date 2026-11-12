// Usage as Claude Code itself reports it (main/usage.ts), and what `workshop.usage` hands a tile.

export interface UsageWindow {
  /** 0–100. */
  pct: number
  /** When the window resets (epoch ms). */
  resetsAt: number
}

export interface Usage {
  /** The account's 5-hour and weekly windows; null = not known (no subscription, or nothing said yet). */
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** When a window last changed (epoch ms; 0 = never). */
  at: number
  /** Per session (core's id): context used (%) and what it has cost so far (USD, list price). */
  sessions: Record<string, { context: number | null; costUsd: number | null }>
  /** The Codex plan's windows, from a Codex session's app-server; null until one has said. */
  codex: CodexUsage | null
  /** Claude's per-model weekly windows ("Fable"…), when the status line carries them; often none. */
  scoped: ScopedWindow[]
}

/** One of Claude's per-model weekly windows, under the server's own label. */
export interface ScopedWindow extends UsageWindow {
  label: string
}

// ---- Claude's per-model windows (rate_limits.model_scoped on Claude Code 2.1.322) --------

/**
 * One `model_scoped` row (`display_name`, `utilization` 0–100 or null, `resets_at` an ISO string or
 * epoch seconds, or null), or null when it is not one this can show. The schema is the CLI's; no
 * account seen so far has had it filled in (12 Nov 2026: the Fable meter was in /usage only).
 */
export function scopedWindow(row: unknown): ScopedWindow | null {
  const r = row as { display_name?: unknown; utilization?: unknown; resets_at?: unknown } | null
  if (!r || typeof r.display_name !== 'string' || !r.display_name.trim()) return null
  if (typeof r.utilization !== 'number' || !isFinite(r.utilization)) return null
  const at = typeof r.resets_at === 'number' ? r.resets_at * 1000 : typeof r.resets_at === 'string' ? Date.parse(r.resets_at) : NaN
  if (!isFinite(at)) return null
  return { label: r.display_name.trim().slice(0, 24), pct: Math.round(Math.max(0, Math.min(100, r.utilization)) * 10) / 10, resetsAt: at }
}

/** What a status line said about the per-model windows, merged into what is kept (by label, laterWindow each). */
export function mergeScoped(cur: ScopedWindow[], rows: unknown, now: number): ScopedWindow[] {
  if (!Array.isArray(rows)) return cur
  const out = new Map(cur.map((w) => [w.label, w]))
  for (const w of rows.map(scopedWindow)) if (w) out.set(w.label, laterWindow(out.get(w.label) ?? null, w, now)!)
  return [...out.values()]
}

/** A Codex plan's window, with its length: plans differ (a free plan has one 30-day window). */
export interface CodexWindow extends UsageWindow {
  /** Its length in minutes, as Codex gives it (null: not said). */
  mins: number | null
}

export interface CodexUsage {
  primary: CodexWindow | null
  secondary: CodexWindow | null
  /** Codex's plan type ("free", "plus"…), for the tooltip. */
  plan: string | null
}

// ---- Codex's windows (account/rateLimits on codex-cli 0.167.1) -------------

/**
 * Which window to keep: the one a session just reported if it is a later window, or further into
 * the same one (two clocks a minute apart are still one window), else the one already kept. Both
 * CLIs' windows go by it.
 */
export function laterWindow<W extends UsageWindow>(cur: W | null, next: W | null, now: number): W | null {
  if (!next || next.resetsAt <= now) return cur
  if (!cur || cur.resetsAt <= now) return next
  if (next.resetsAt > cur.resetsAt + 60_000) return next
  if (next.resetsAt < cur.resetsAt - 60_000) return cur
  return next.pct > cur.pct ? next : cur
}

/** A RateLimitWindow (`usedPercent`, `windowDurationMins`, `resetsAt` in seconds), or null. */
export function codexWindow(w: unknown): CodexWindow | null {
  const x = w as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null
  if (!x || typeof x.usedPercent !== 'number' || !isFinite(x.usedPercent) || typeof x.resetsAt !== 'number' || !isFinite(x.resetsAt)) return null
  const mins = typeof x.windowDurationMins === 'number' && x.windowDurationMins > 0 ? x.windowDurationMins : null
  return { pct: Math.round(x.usedPercent * 10) / 10, resetsAt: x.resetsAt * 1000, mins }
}

/**
 * A rate-limit snapshot (`account/rateLimits/read`'s `rateLimits`, or an `account/rateLimits/updated`)
 * merged into what is kept. Updates are sparse: a window not given keeps the last one seen. Only
 * the `codex` bucket (or an unnamed one) is the plan's.
 */
export function mergeCodex(cur: CodexUsage | null, snap: unknown, now: number): CodexUsage | null {
  const s = snap as { limitId?: unknown; primary?: unknown; secondary?: unknown; planType?: unknown } | null
  if (!s || typeof s !== 'object' || (s.limitId !== null && s.limitId !== undefined && s.limitId !== 'codex')) return cur
  const primary = laterWindow(cur?.primary ?? null, codexWindow(s.primary), now)
  const secondary = laterWindow(cur?.secondary ?? null, codexWindow(s.secondary), now)
  const plan = typeof s.planType === 'string' && s.planType ? s.planType : (cur?.plan ?? null)
  if (!primary && !secondary && !plan) return cur
  return { primary, secondary, plan }
}

/** A window's short label from its length: "5h", "7d", "30d". */
export function windowLabel(mins: number | null): string {
  if (!mins) return '—'
  if (mins < 60) return `${mins}m`
  if (mins < 1440 || mins % 1440 !== 0) return `${Math.round(mins / 60)}h`
  return `${mins / 1440}d`
}

/** Its name in a sentence: "5-hour window", "weekly window", "30-day window". */
export function windowName(mins: number | null): string {
  if (!mins) return 'window'
  if (mins === 10080) return 'weekly window'
  if (mins < 60) return `${mins}-minute window`
  if (mins < 1440 || mins % 1440 !== 0) return `${Math.round(mins / 60)}-hour window`
  return `${mins / 1440}-day window`
}

// ---- how the window words them (deck's thresholds) -------------------------

/** Amber from here, red from there: for a rate-limit window and for a context window alike. */
export const USAGE_WARN = 70
export const USAGE_HOT = 90

export function usageLevel(pct: number): 'ok' | 'warn' | 'hot' {
  return pct >= USAGE_HOT ? 'hot' : pct >= USAGE_WARN ? 'warn' : 'ok'
}

/** Time LEFT until a window starts over, short: "2h 14m", "47m", "3d 4h". */
export function timeLeft(resetsAt: number, now: number): string {
  const m = Math.max(0, Math.round((resetsAt - now) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** A session's cost, short: "$0.42", "$12.30", "$140"; under a cent it says so rather than "$0.00". */
export function money(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd >= 100) return `$${Math.round(usd)}`
  return `$${usd.toFixed(2)}`
}
