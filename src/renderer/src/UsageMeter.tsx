// The account's two windows in the top bar, as Claude Code reports them (main/usage.ts). Nothing
// until a session has said (a subscriber's first response); an API-key account never shows one.

import type { Usage, UsageWindow } from '@shared/usage'

function left(w: UsageWindow): string {
  const ms = w.resetsAt - Date.now()
  const h = Math.floor(ms / 3_600_000)
  if (h >= 24) return `${Math.round(h / 24)}d`
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.round(ms / 60_000))}m`
}

function Meter({ label, w }: { label: string; w: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, w.pct))
  return (
    <span className={`meter ${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}`} title={`${label}: ${pct}% used, resets in ${left(w)}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-pct">{Math.round(pct)}%</span>
    </span>
  )
}

export function UsageMeter({ usage }: { usage: Usage | null }) {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null
  return (
    <span className="usage">
      {usage.fiveHour && <Meter label="5h" w={usage.fiveHour} />}
      {usage.sevenDay && <Meter label="week" w={usage.sevenDay} />}
    </span>
  )
}
