// The account's two windows in the top bar, as Claude Code reports them (main/usage.ts), and a
// session's own context and cost (SessionUsage). Both meters are always there: a window nobody has
// reported yet is an empty bar and a dash, and its tooltip says why, so a fresh window does not look
// as if usage were not a thing workshop shows. The CLI's own numbers, never an estimate of ours.

import { useEffect, useState } from 'react'
import { money, timeLeft, usageLevel, type Usage, type UsageWindow } from '@shared/usage'

const UNKNOWN_WHY = 'nothing reported yet. A session reports it after its first reply, and only on a Claude subscription (an API key has no such window).'

function Meter({ label, name, w, now }: { label: string; name: string; w: UsageWindow | null; now: number }) {
  const live = w && w.resetsAt > now ? w : null
  if (!live)
    return (
      <span className="meter unknown" title={`The ${name}: ${UNKNOWN_WHY}`}>
        <span className="meter-label">{label}</span>
        <span className="meter-bar" />
        <span className="meter-pct">—</span>
      </span>
    )
  const pct = Math.max(0, Math.min(100, live.pct))
  const level = usageLevel(pct)
  return (
    <span
      className={`meter is-${level}`}
      title={`The ${name}: ${Math.round(pct)}% used${level === 'hot' ? ', nearly out' : level === 'warn' ? ', running high' : ''}; starts over in ${timeLeft(live.resetsAt, now)}`}
    >
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-pct">{Math.round(pct)}%</span>
      <span className="meter-left">{timeLeft(live.resetsAt, now)}</span>
    </span>
  )
}

export function UsageMeter({ usage }: { usage: Usage | null }) {
  // The time left moves on its own; a minute is as fine as it is shown.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <span className="usage" title="Usage, as Claude Code reports it to each session's status line">
      <Meter label="5h" name="5-hour window" w={usage?.fiveHour ?? null} now={now} />
      <Meter label="week" name="weekly window" w={usage?.sevenDay ?? null} now={now} />
    </span>
  )
}

/**
 * One session's context window and cost, for its head. Nothing until its status line has said
 * (after its first reply). Context turns amber at 70% and red at 90%, with the advice in words too.
 */
export function SessionUsage({ id, usage }: { id: string; usage: Usage | null }) {
  const u = usage?.sessions[id]
  if (!u || (u.context === null && u.costUsd === null)) return null
  return (
    <>
      {u.context !== null && (
        <span
          className={`badge ctx is-${usageLevel(u.context)}`}
          title={`Context window: ${u.context}% used${usageLevel(u.context) === 'ok' ? '' : '. /compact or a new session soon'}`}
        >
          ctx {u.context}%
        </span>
      )}
      {u.costUsd !== null && (
        <span className="badge cost" title="What this session has cost so far, at API list prices (on a subscription this is not a bill)">
          {money(u.costUsd)}
        </span>
      )}
    </>
  )
}
