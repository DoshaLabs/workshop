import { describe, expect, it } from 'vitest'
import { Accounts, type PtyLike, type Run } from '../src/main/accounts'
import { needsSignIn, parseClaudeStatus, parseCodexStatus, planName, signInUrl } from '../src/shared/accounts'

describe('the status commands', () => {
  it('reads claude auth status --json, signed in and out', () => {
    const inn = parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'max', planTier: 'max_20x', loginExpiresAt: '2026-12-11T12:43:59.211Z' }))
    expect(inn).toEqual({ loggedIn: true, method: 'claude.ai', email: 'a@b.c', plan: 'max_20x', expiresAt: Date.parse('2026-12-11T12:43:59.211Z') })
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: false, authMethod: 'none', loginExpiresAt: null }))).toEqual({ loggedIn: false, method: null, email: null, plan: null, expiresAt: null })
    expect(parseClaudeStatus('Usage: claude auth')).toBeNull()
  })
  it('reads codex login status', () => {
    expect(parseCodexStatus('Logged in using ChatGPT\n', 0)).toMatchObject({ loggedIn: true, method: 'ChatGPT' })
    expect(parseCodexStatus('Not logged in\n', 1).loggedIn).toBe(false)
  })
  it('asks for a sign-in when signed out or past the login’s end', () => {
    const a = { loggedIn: true, method: null, email: null, plan: null, expiresAt: 1000 }
    expect(needsSignIn(a, 999)).toBe(false)
    expect(needsSignIn(a, 1000)).toBe(true)
    expect(needsSignIn({ ...a, loggedIn: false, expiresAt: null }, 0)).toBe(true)
    expect(needsSignIn(null, 0)).toBe(false)
  })
  it('finds the sign-in page in coloured output, and names plans', () => {
    expect(signInUrl('\x1b[1mOpen this:\x1b[0m https://claude.ai/oauth/authorize?code=true&x=1\r\n')).toBe('https://claude.ai/oauth/authorize?code=true&x=1')
    expect(signInUrl('waiting…')).toBeNull()
    expect(planName('max_20x')).toBe('Max 20x')
  })
})

function fakes(status: { claude: string; codex: [string, number] | 'missing' }) {
  const calls: string[] = []
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'claude') return { code: 0, out: status.claude, missing: false }
    if (status.codex === 'missing') return { code: 1, out: '', missing: true }
    return { code: status.codex[1], out: status.codex[0], missing: false }
  }
  let data: (d: string) => void = () => {}
  let exit: (e: { exitCode: number }) => void = () => {}
  const spawned: string[] = []
  let killed = 0
  const child: PtyLike = { onData: (f) => (data = f), onExit: (f) => (exit = f), kill: () => void killed++ }
  return { calls, run, spawn: (cmd: string, args: string[]) => (spawned.push([cmd, ...args].join(' ')), child), spawned, data: (d: string) => data(d), exit: (c: number) => exit({ exitCode: c }), killed: () => killed }
}

describe('Accounts', () => {
  const OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' })
  const IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', planTier: 'max_20x' })

  it('reads both CLIs, and leaves out one that is not installed', async () => {
    const f = fakes({ claude: IN, codex: 'missing' })
    const a = new Accounts({ env: () => ({}), onChange: () => {}, run: f.run, spawn: f.spawn })
    await a.refresh()
    expect(f.calls).toEqual(['claude auth status --json', 'codex login status'])
    expect(a.get().claude).toMatchObject({ loggedIn: true, plan: 'max_20x' })
    expect(a.get().codex).toBeNull()
  })

  it('signs in with the CLI’s own login, shows its page, and clears once signed in', async () => {
    const st = { claude: OUT, codex: ['Logged in using ChatGPT', 0] as [string, number] }
    const f = fakes(st)
    const a = new Accounts({ env: () => ({}), onChange: () => {}, run: f.run, spawn: f.spawn })
    await a.refresh()
    a.signIn('claude')
    a.signIn('claude')
    expect(f.spawned).toEqual(['claude auth login'])
    f.data('Opening https://claude.ai/oauth/authorize?x=1 \r\n')
    expect(a.get().signIn).toMatchObject({ cli: 'claude', url: 'https://claude.ai/oauth/authorize?x=1' })
    st.claude = IN
    f.exit(0)
    await new Promise((r) => setTimeout(r, 5))
    expect(a.get().signIn).toBeNull()
    expect(a.get().claude?.loggedIn).toBe(true)
  })

  it('keeps why a sign-in failed, and cancel stops one', async () => {
    const f = fakes({ claude: OUT, codex: 'missing' })
    const a = new Accounts({ env: () => ({}), onChange: () => {}, run: f.run, spawn: f.spawn })
    a.signIn('claude')
    f.data('Login failed: denied\r\n')
    f.exit(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(a.get().signIn?.error).toMatch(/denied/)
    a.cancel()
    expect(a.get().signIn).toBeNull()
    a.signIn('codex')
    a.cancel()
    expect(f.killed()).toBe(1)
  })
})
