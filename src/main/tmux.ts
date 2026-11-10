// Thin wrapper around workshop's tmux server. Every session is one tmux session on a private
// socket named after the profile (-L workshop, -L workshop-dev), so it survives the app quitting
// and a dev build never sees the installed app's sessions. Carried over from deck.

import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export class Tmux {
  constructor(
    readonly socket: string,
    private readonly conf: string,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  /** Args to reproduce this server from a shell: `tmux -L <socket> ...` */
  get cliPrefix(): string[] {
    return ['-L', this.socket]
  }

  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        'tmux',
        ['-L', this.socket, '-f', this.conf, ...args],
        { env: this.env, encoding: 'utf8', timeout: 10000 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
        }
      )
    })
  }

  // Targets are plain names: tmux matches an exact session name first, and our names
  // (`ws-` + 6 hex) can never be prefixes of each other. (The `=name` exact-match
  // form is rejected by tmux 3.5a for display-message/list-panes, so it is not used.)
  async hasSession(name: string): Promise<boolean> {
    const r = await this.run(['has-session', '-t', name])
    return r.code === 0
  }

  async listSessions(): Promise<string[]> {
    const r = await this.run(['list-sessions', '-F', '#{session_name}'])
    if (r.code !== 0) return [] // "no server running" is the normal empty case
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }

  /** Start a detached session running `command` (a shell string, run via sh -c). */
  async newSession(opts: { name: string; cwd: string; command: string; cols: number; rows: number }): Promise<void> {
    const r = await this.run([
      'new-session', '-d',
      '-s', opts.name,
      '-c', opts.cwd,
      '-x', String(opts.cols),
      '-y', String(opts.rows),
      opts.command
    ])
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim()}`)
  }

  /** Ends the whole server and removes its socket file (the smoke test's throwaway socket). */
  async killServer(): Promise<void> {
    await this.run(['kill-server'])
    // Where tmux keeps a -L socket: $TMUX_TMPDIR (else /tmp)/tmux-<uid>/<name>.
    await rm(join(this.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, this.socket), { force: true })
  }

  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', name])
  }

  /** Is the (single) pane of this session a dead pane kept by remain-on-exit? */
  async paneDead(name: string): Promise<boolean> {
    const r = await this.run(['display-message', '-p', '-t', name, '#{pane_dead}'])
    return r.code === 0 && r.stdout.trim() === '1'
  }

  /**
   * The visible screen of a session's pane, SGR colors kept (`capture-pane -e`). Reads the pane without attaching, so the size never changes. Null when
   * the session is gone.
   */
  async screen(name: string): Promise<{ text: string; cols: number; rows: number } | null> {
    const size = await this.run(['display-message', '-p', '-t', name, '#{pane_width} #{pane_height}'])
    if (size.code !== 0) return null
    const [cols, rows] = size.stdout.trim().split(' ').map(Number)
    const cap = await this.run(['capture-pane', '-p', '-e', '-t', name])
    if (cap.code !== 0) return null
    return { text: cap.stdout.replace(/\n$/, ''), cols: cols || 0, rows: rows || 0 }
  }

  /** The folder the session's pane is in (its foreground process's cwd), null when the session is gone. */
  async paneCwd(name: string): Promise<string | null> {
    const r = await this.run(['display-message', '-p', '-t', name, '#{pane_current_path}'])
    const p = r.stdout.trim()
    return r.code === 0 && p ? p : null
  }

  /** The session a pane id (`%12`, tmux's $TMUX_PANE) belongs to, null when it is not on this server. */
  async sessionOfPane(pane: string): Promise<string | null> {
    if (!/^%\d+$/.test(pane)) return null
    const r = await this.run(['display-message', '-p', '-t', pane, '#{session_name}'])
    const name = r.stdout.trim()
    return r.code === 0 && name ? name : null
  }

  async panePid(name: string): Promise<number | null> {
    const r = await this.run(['display-message', '-p', '-t', name, '#{pane_pid}'])
    const n = Number(r.stdout.trim())
    return r.code === 0 && Number.isFinite(n) ? n : null
  }
}

/** POSIX single-quote a string for sh -c. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
