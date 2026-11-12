// The account manager: a click on a plan's name in the top bar (UsageMeter.tsx) opens it in core's
// lightbox. One card per CLI: who it is signed in as, its plan and organisation, when the login
// runs out, its version; every window it reports, at full size, with when it starts over; what each
// open session of that CLI has used; Sign in (Claude Code: subscription, Console or SSO, its own
// flags), Sign out (two clicks), and the provider's own usage page. Everything comes from the CLIs'
// status commands and status lines, and every action is the CLI's own command (ground rule 4): no
// billing, no credits, no token. docs/progress/2026-11-12-accounts.md.

import { useEffect, useState } from 'react'
import { needsSignIn, planName, type AccountsState, type Cli, type CliAccount, type SignInHow } from '@shared/accounts'
import { money, timeLeft, usageLevel, type Usage, type UsageWindow } from '@shared/usage'
import type { SessionsState } from '@shared/sessions'
import { Lightbox } from './Lightbox'

export interface PlanRow {
  label: string
  name: string
  w: UsageWindow | null
}

export interface PlanInfo {
  id: Cli
  cli: string
  glyph: string
  rows: PlanRow[]
  /** The provider's own usage page (opened in the browser). */
  page: string
}

const HOW: [SignInHow, string, string][] = [
  ['claudeai', 'Subscription', 'Sign in with your Pro or Max subscription (the default)'],
  ['console', 'Console', 'Sign in to the Console: usage billed to the API account'],
  ['sso', 'SSO', "Sign in through your organisation's single sign-on"]
]

export function Accounts({
  plans,
  acc,
  usage,
  sessions,
  now,
  onClose
}: {
  plans: PlanInfo[]
  acc: AccountsState
  usage: Usage | null
  sessions: SessionsState | null
  now: number
  onClose: () => void
}) {
  // One armed Sign out at a time, for three seconds, as the Closed card's End All.
  const [arm, setArm] = useState<Cli | null>(null)
  useEffect(() => {
    if (!arm) return
    const t = window.setTimeout(() => setArm(null), 3000)
    return () => window.clearTimeout(t)
  }, [arm])
  const [busy, setBusy] = useState<Cli | null>(null)
  const signOut = async (cli: Cli): Promise<void> => {
    if (arm !== cli) return setArm(cli)
    setArm(null)
    setBusy(cli)
    try {
      await window.core.accounts.signOut(cli)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Lightbox onClose={onClose}>
      <section className="picker accounts" role="dialog" aria-label="Accounts">
        <header className="head">
          <span className="name">Accounts</span>
          <button className="ghost" title="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="picker-body">
          {plans.map((p) => (
            <Card
              key={p.id}
              plan={p}
              account={acc[p.id]}
              state={acc}
              usage={usage}
              sessions={sessions}
              now={now}
              armed={arm === p.id}
              busy={busy === p.id}
              onSignOut={() => void signOut(p.id)}
            />
          ))}
          <p className="picker-note">
            Each sign-in is the CLI's own login, run here; workshop never sees a password or a token. Sessions already running keep the login they started with.
          </p>
        </div>
      </section>
    </Lightbox>
  )
}

function Card({
  plan,
  account,
  state,
  usage,
  sessions,
  now,
  armed,
  busy,
  onSignOut
}: {
  plan: PlanInfo
  account: CliAccount | null
  state: AccountsState
  usage: Usage | null
  sessions: SessionsState | null
  now: number
  armed: boolean
  busy: boolean
  onSignOut: () => void
}) {
  const [how, setHow] = useState<SignInHow>('claudeai')
  const signing = state.signIn?.cli === plan.id ? state.signIn : null
  const anySigning = !!state.signIn && !state.signIn.error
  const outError = state.signOutError?.cli === plan.id ? state.signOutError.error : null
  const expired = needsSignIn(account, now)
  const mine = (sessions?.sessions ?? []).filter((s) => s.open && (s.cli ?? 'claude') === plan.id)
  const total = mine.reduce((n, s) => n + (usage?.sessions[s.id]?.costUsd ?? 0), 0)

  const facts: [string, string][] = []
  if (account?.loggedIn) {
    if (account.email) facts.push(['Account', account.email])
    if (account.org) facts.push(['Organisation', account.org])
    if (account.method) facts.push(['Signed in with', account.method])
    const p = planName(account.plan) ?? (plan.id === 'codex' ? planName(usage?.codex?.plan ?? null) : null)
    if (p) facts.push(['Plan', p])
    if (account.expiresAt) facts.push(['Login', account.expiresAt > now ? `runs out in ${timeLeft(account.expiresAt, now)}` : 'has run out'])
  }
  if (account?.version) facts.push(['Version', account.version])

  return (
    <article className="acct">
      <header className="acct-head">
        <span className="acct-name">
          <span className="usage-glyph" aria-hidden="true">
            {plan.glyph}
          </span>
          {plan.cli}
        </span>
        <span className={`acct-state ${account?.loggedIn && !expired ? 'is-in' : 'is-out'}`}>
          {!account ? 'Not installed, or not read yet' : account.loggedIn && !expired ? 'Signed in' : expired && account.loggedIn ? 'Login ran out' : 'Not signed in'}
        </span>
      </header>

      {facts.length > 0 && (
        <dl className="acct-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {account && (
        <>
          <h3>Windows</h3>
          {plan.rows.length === 0 ? (
            <p className="picker-note">Nothing reported yet: a session reports its plan's windows after its first reply.</p>
          ) : (
            <div className="acct-windows">
              {plan.rows.map((r, i) => (
                <BigMeter key={i} row={r} now={now} />
              ))}
            </div>
          )}

          {mine.length > 0 && (
            <>
              <h3>Open sessions</h3>
              <ul className="acct-sessions">
                {mine.map((s) => {
                  const u = usage?.sessions[s.id]
                  return (
                    <li key={s.id}>
                      <span className="acct-session-name">{s.title || s.name}</span>
                      <span className={`acct-ctx is-${u?.context != null ? usageLevel(u.context) : 'ok'}`} title="Context window used">
                        {u?.context != null ? `ctx ${u.context}%` : '—'}
                      </span>
                      {plan.id === 'claude' && (
                        <span className="acct-cost" title="At API list prices (on a subscription this is not a bill)">
                          {u?.costUsd != null ? money(u.costUsd) : '—'}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              {plan.id === 'claude' && total > 0 && <p className="picker-note">Together {money(total)} at API list prices; on a subscription this is not a bill.</p>}
            </>
          )}

          <div className="acct-actions">
            {signing && !signing.error ? (
              <span className="acct-signing">
                Signing in… your browser should have opened the sign-in page.
                {signing.url && (
                  <a href={signing.url} target="_blank" rel="noreferrer">
                    Open it
                  </a>
                )}
                <button className="preview-btn" onClick={() => void window.core.accounts.cancel()}>
                  Stop
                </button>
              </span>
            ) : (
              <>
                {plan.id === 'claude' && (
                  <span className="acct-how" role="radiogroup" aria-label="How to sign in">
                    {HOW.map(([k, label, hint]) => (
                      <button key={k} role="radio" aria-checked={how === k} className={`preview-btn ${how === k ? 'on' : ''}`} title={hint} onClick={() => setHow(k)}>
                        {label}
                      </button>
                    ))}
                  </span>
                )}
                <button
                  className="preview-btn acct-primary"
                  disabled={anySigning || busy}
                  title={`Runs ${plan.id === 'claude' ? `claude auth login${how === 'console' ? ' --console' : how === 'sso' ? ' --sso' : ''}` : 'codex login'}: your browser opens the sign-in page`}
                  onClick={() => void window.core.accounts.signIn(plan.id, plan.id === 'claude' ? how : undefined)}
                >
                  {account.loggedIn ? 'Sign in again' : 'Sign in'}
                </button>
                {account.loggedIn && (
                  <button
                    className={`preview-btn acct-out ${armed ? 'armed' : ''}`}
                    disabled={anySigning || busy}
                    title={armed ? 'Click again to sign out' : `Runs ${plan.id === 'claude' ? 'claude auth logout' : 'codex logout'}`}
                    onClick={onSignOut}
                  >
                    {busy ? 'Signing out…' : armed ? 'sign out?' : 'Sign out'}
                  </button>
                )}
              </>
            )}
            <a className="acct-page" href={plan.page} target="_blank" rel="noreferrer" title={plan.page}>
              Usage and billing ↗
            </a>
          </div>
          {signing?.error && (
            <p className="picker-problem">
              The last sign-in did not finish: {signing.error}{' '}
              <button className="usage-signin-x" onClick={() => void window.core.accounts.cancel()}>
                (dismiss)
              </button>
            </p>
          )}
          {outError && <p className="picker-problem">Sign out did not finish: {outError}</p>}
        </>
      )}
    </article>
  )
}

/** One window at reading size: its name, a long bar, the share used and when it starts over. */
function BigMeter({ row, now }: { row: PlanRow; now: number }) {
  const live = row.w && row.w.resetsAt > now ? row.w : null
  const pct = live ? Math.max(0, Math.min(100, live.pct)) : 0
  return (
    <div className={`acct-meter ${live ? `is-${usageLevel(pct)}` : 'unknown'}`}>
      <span className="acct-meter-name">{row.name[0].toUpperCase() + row.name.slice(1)}</span>
      <span className="meter-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="acct-meter-pct">{live ? `${Math.round(pct)}%` : '—'}</span>
      <span className="acct-meter-reset">{live ? `starts over in ${timeLeft(live.resetsAt, now)}` : 'not reported yet'}</span>
    </div>
  )
}
