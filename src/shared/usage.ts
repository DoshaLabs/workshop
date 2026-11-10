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
