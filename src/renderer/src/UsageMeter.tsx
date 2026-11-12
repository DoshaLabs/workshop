// The account's two windows in the top bar, as Claude Code reports them (main/usage.ts), and a
// session's own context and cost (SessionUsage). Both meters are always there: a window nobody has
// reported yet is an empty bar and a dash, and its tooltip says why, so a fresh window does not look
// as if usage were not a thing workshop shows. The CLI's own numbers, never an estimate of ours.

import { useEffect, useState } from 'react'
import { needsSignIn, planName, type AccountsState, type Cli, type CliAccount } from '@shared/accounts'
import { money, timeLeft, usageLevel, windowLabel, windowName, type CodexWindow, type Usage, type UsageWindow } from '@shared/usage'

const UNKNOWN_WHY = 'nothing reported yet. A session reports it after its first reply, and only on a subscription (an API key has no such window).'

/** One window: a row of the product's stacked bars (its time left is in the tooltip and, for the first, under the name). */
function Meter({ label, name, w, now, plan }: { label: string; name: string; w: UsageWindow | null; now: number; plan?: string }) {
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
      title={`The ${name}${plan ? ` (${plan} plan)` : ''}: ${Math.round(pct)}% used${level === 'hot' ? ', nearly out' : level === 'warn' ? ', running high' : ''}; starts over in ${timeLeft(live.resetsAt, now)}`}
    >
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-pct">{Math.round(pct)}%</span>
    </span>
  )
}

/**
 * One CLI's plan: its name with the soonest window's time left under it, and its windows as
 * stacked bars beside them. The name here is which CLI's plan this is, so it may say Claude.
 */
function Plan({
  cli,
  id,
  title,
  rows,
  now,
  account,
  signIn
}: {
  cli: string
  id: Cli
  title: string
  rows: { label: string; name: string; w: UsageWindow | null; plan?: string }[]
  now: number
  account: CliAccount | null
  signIn: AccountsState['signIn']
}) {
  const live = rows.map((r) => r.w).filter((w): w is UsageWindow => !!w && w.resetsAt > now)
  const next = live.length ? Math.min(...live.map((w) => w.resetsAt)) : null
  const mine = signIn?.cli === id ? signIn : null
  const who = account?.loggedIn
    ? `Signed in${account.email ? ` as ${account.email}` : account.method ? ` with ${account.method}` : ''}${account.plan ? ` (${planName(account.plan)})` : ''}.`
    : account
      ? 'Not signed in.'
      : ''
  return (
    <span className="usage-plan">
      <span className="usage-who" title={[title, who].filter(Boolean).join('\n\n')}>
        <span className="usage-cli">{cli}</span>
        {mine && !mine.error ? (
          <span className="usage-signin is-busy">
            {mine.url ? (
              <a href={mine.url} target="_blank" rel="noreferrer" title="The sign-in page, if your browser did not open it">
                Open sign-in…
              </a>
            ) : (
              'Signing in…'
            )}
            <button className="usage-signin-x" title="Stop signing in" onClick={() => void window.core.accounts.cancel()}>
              ×
            </button>
          </span>
        ) : mine?.error || needsSignIn(account, now) ? (
          <button
            className="usage-signin"
            title={`${mine?.error ? `The last sign-in did not finish:\n${mine.error}\n\n` : account?.loggedIn ? 'This login has run out. ' : ''}Runs ${id === 'claude' ? 'claude auth login' : 'codex login'}: your browser opens the sign-in page. Sessions already running keep the login they started with.`}
            onClick={() => void window.core.accounts.signIn(id)}
          >
            Sign in
          </button>
        ) : (
          <span className="usage-reset" title={next ? `The soonest window starts over in ${timeLeft(next, now)}` : undefined}>
            {next ? `↻ ${timeLeft(next, now)}` : '—'}
          </span>
        )}
      </span>
      <span className="usage-bars">
        {rows.map((r, i) => (
          <Meter key={i} label={r.label} name={r.name} w={r.w} now={now} plan={r.plan} />
        ))}
      </span>
    </span>
  )
}

export function UsageMeter({ usage }: { usage: Usage | null }) {
  const [acc, setAcc] = useState<AccountsState>({ claude: null, codex: null, signIn: null })
  useEffect(() => {
    // An installed core older than this window (dev mode) has no accounts yet: nothing to show.
    const api = window.core.accounts as typeof window.core.accounts | undefined
    if (!api) return
    let live = true
    void api.state().then((x) => live && setAcc(x))
    const off = api.onState(setAcc)
    return () => {
      live = false
      off()
    }
  }, [])
  // The time left moves on its own; a minute is as fine as it is shown.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  // Codex's windows, only once a Codex session has said them (a plan may have one or two).
  // Claude's per-model weekly windows, under the server's own label ("Fable"), when reported.
  const scoped = (usage?.scoped ?? []).filter((w) => w.resetsAt > now)
  const codex = [usage?.codex?.primary, usage?.codex?.secondary].filter((w): w is CodexWindow => !!w && w.resetsAt > now)
  return (
    <span className="usage">
      <Plan
        cli="Claude"
        id="claude"
        account={acc.claude}
        signIn={acc.signIn}
        title={`The Claude plan's windows, as each session's status line reports them. Only the windows it reports are drawn: a plan with no 5-hour window has no 5h bar.${scoped.length ? '' : ' Per-model weekly meters (Fable) are in /usage only until the status line carries them.'}`}
        now={now}
        rows={[
          // The 5-hour window only while one is reported; the weekly one always (a dash until it is).
          ...(usage?.fiveHour && usage.fiveHour.resetsAt > now ? [{ label: '5h', name: '5-hour window', w: usage.fiveHour }] : []),
          { label: '7d', name: 'weekly window', w: usage?.sevenDay ?? null },
          ...scoped.map((w) => ({ label: w.label, name: `${w.label} weekly window`, w }))
        ]}
      />
      {(codex.length > 0 || needsSignIn(acc.codex, now) || acc.signIn?.cli === 'codex') && (
        <Plan
          cli="Codex"
          id="codex"
          account={acc.codex}
          signIn={acc.signIn}
          title="The Codex plan's windows, as a Codex session's app-server reports them"
          now={now}
          rows={codex.map((w) => ({ label: windowLabel(w.mins), name: `Codex ${windowName(w.mins)}`, w, plan: usage?.codex?.plan ?? undefined }))}
        />
      )}
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
