// A smoke run's tmux server must not outlive the run. index.ts kills it at the end, but a run that
// is stopped part way (a timeout, Ctrl-C, a harness killing the process, a crash) never gets there,
// and its server keeps the stand-in sessions alive for hours. So the run starts a reaper: a
// detached shell that waits for the run's process to be gone, however it went, then ends the
// server on that run's own socket and removes the socket file. It never touches any other socket.

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** The reaper's script. The pid, socket and socket path come in as arguments, never as script text. */
export const REAPER_SCRIPT = 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; tmux -L "$2" kill-server 2>/dev/null; rm -f "$3"'

/** Only a smoke run's throwaway socket may be reaped. */
export const SMOKE_SOCKET_RE = /^workshop-smoke-\d+$/

/** Starts the reaper for this process's smoke socket. Returns false (and starts nothing) for any other socket. */
export function reapTmuxWhenGone(socket: string, env: NodeJS.ProcessEnv, pid = process.pid): boolean {
  if (!SMOKE_SOCKET_RE.test(socket)) return false
  // Where tmux keeps a -L socket: $TMUX_TMPDIR (else /tmp)/tmux-<uid>/<name>, as Tmux.killServer.
  const path = join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket)
  const child = spawn('/bin/sh', ['-c', REAPER_SCRIPT, 'workshop-smoke-reaper', String(pid), socket, path], {
    env,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  return true
}
