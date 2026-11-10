// Resolve the user's login-shell environment once, so `claude` and `tmux` are found
// even when Electron was launched from Finder/Dock with a bare PATH.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let cached: NodeJS.ProcessEnv | null = null

const NEEDED = ['claude', 'tmux']

export function shellEnv(): NodeJS.ProcessEnv {
  if (cached) return cached

  const base: NodeJS.ProcessEnv = { ...process.env }
  // Never let these leak into spawned sessions.
  delete base.ELECTRON_RUN_AS_NODE
  delete base.ELECTRON_NO_ATTACH_CONSOLE
  base.TERM = 'xterm-256color'
  base.COLORTERM = 'truecolor'
  base.LANG ||= 'en_US.UTF-8'
  base.TERM_PROGRAM = 'workshop'

  const shell = process.env.SHELL || '/bin/zsh'
  // -lc first (login shell, no prompt noise); -ilc as a fallback for PATH set only in .zshrc.
  for (const flags of ['-lc', '-ilc']) {
    try {
      const out = execFileSync(shell, [flags, 'env'], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const merged = { ...base, ...parseEnv(out) }
      if (NEEDED.every((bin) => findInPath(merged.PATH, bin))) {
        cached = merged
        return merged
      }
    } catch {
      /* try the next flag set */
    }
  }

  // Last resort: append the usual suspects.
  const home = homedir()
  const extra = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  cached = { ...base, PATH: [...extra, base.PATH ?? ''].filter(Boolean).join(':') }
  return cached
}

function parseEnv(out: string): Record<string, string> {
  const env: Record<string, string> = {}
  let key: string | null = null
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) {
      key = m[1]
      env[key] = m[2]
    } else if (key) {
      env[key] += '\n' + line // multi-line value continuation
    }
  }
  // Values from the shell that would confuse spawned programs.
  delete env.PWD
  delete env.OLDPWD
  delete env.SHLVL
  delete env._
  return env
}

export function findInPath(path: string | undefined, bin: string): string | null {
  for (const dir of (path ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, bin)
    if (existsSync(p)) return p
  }
  return null
}
