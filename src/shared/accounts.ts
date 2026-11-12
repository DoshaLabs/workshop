// Who each CLI is signed in as (main/accounts.ts), read from the CLIs' own status commands, never
// from their credentials (ground rule 4). docs/progress/2026-11-12-accounts.md.

export type Cli = 'claude' | 'codex'

export interface CliAccount {
  loggedIn: boolean
  /** How: "claude.ai", "console", "ChatGPT", "an API key"…; null when not said. */
  method: string | null
  /** Claude Code only (Codex's status does not say). */
  email: string | null
  /** "max_20x", "max", "pro"…: Claude Code's planTier, else its subscriptionType. */
  plan: string | null
  /** When the login runs out (epoch ms), if the CLI says. */
  expiresAt: number | null
}

export interface SignIn {
  cli: Cli
  /** The sign-in page, if the CLI printed one (a browser that did not open). */
  url: string | null
  startedAt: number
  /** Why the last attempt failed (the command's last lines). */
  error?: string
}

export interface AccountsState {
  /** null: not read yet, or the CLI is not installed. */
  claude: CliAccount | null
  codex: CliAccount | null
  /** A sign-in under way, or the last one that failed. */
  signIn: SignIn | null
}

/** `claude auth status --json`'s output, or null if it is not that. */
export function parseClaudeStatus(text: string): CliAccount | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || typeof d.loggedIn !== 'boolean') return null
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const exp = str(d.loginExpiresAt)
  const method = str(d.authMethod)
  return {
    loggedIn: d.loggedIn,
    method: method === 'none' ? null : method,
    email: str(d.email),
    plan: str(d.planTier) ?? str(d.subscriptionType),
    expiresAt: exp && isFinite(Date.parse(exp)) ? Date.parse(exp) : null
  }
}

/** `codex login status`'s output and exit code ("Logged in using ChatGPT", "Not logged in"). */
export function parseCodexStatus(text: string, code: number): CliAccount {
  const m = /logged in using (.+)/i.exec(text)
  const loggedIn = code === 0 && !!m && !/not logged in/i.test(text)
  return { loggedIn, method: loggedIn && m ? m[1].trim().replace(/\.$/, '') : null, email: null, plan: null, expiresAt: null }
}

/** Signed out, or past the login's end: what turns the head's reset line into Sign in. */
export function needsSignIn(a: CliAccount | null, now: number): boolean {
  return !!a && (!a.loggedIn || (a.expiresAt !== null && a.expiresAt <= now))
}

/** The first https address in a sign-in command's output (the page to open by hand). */
export function signInUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')
  const m = /https:\/\/[^\s"'<>]+/.exec(plain)
  return m ? m[0] : null
}

/** "max_20x" → "Max 20x"; "pro" → "Pro". */
export function planName(plan: string | null): string | null {
  if (!plan) return null
  return plan
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
