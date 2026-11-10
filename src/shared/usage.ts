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
