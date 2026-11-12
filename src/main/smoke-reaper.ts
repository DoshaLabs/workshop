// A smoke run's tmux server must not outlive the run. index.ts kills it at the end, but a run that
// is stopped part way (a timeout, Ctrl-C, a harness killing the process, a crash) never gets there,
// and its server keeps the stand-in sessions alive for hours. So the run starts a reaper: a
// detached shell that waits for the run's process to be gone, however it went, then ends the
// server on that run's own socket and removes the socket file. It never touches any other socket.

import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

//
// The run's folder goes the same way: its profile (about 37 MB) with every other folder the run
// makes inside it (index.ts points TMPDIR there). Left in $TMPDIR they piled up by the hundred.

/** The reaper's script. The pid, socket, socket path and folder come in as arguments, never as script text. */
export const REAPER_SCRIPT =
  'while kill -0 "$1" 2>/dev/null; do sleep 2; done; tmux -L "$2" kill-server 2>/dev/null; rm -f "$3"; if [ -n "$4" ]; then rm -rf -- "$4"; fi'

/** Only a smoke run's throwaway socket may be reaped. */
export const SMOKE_SOCKET_RE = /^workshop-smoke-\d+$/

/** Only a smoke run's own folder may be removed: mkdtemp's `workshop-smoke-XXXXXX`, directly in the temp folder it was made in. */
export function isSmokeHome(home: string, tmp: string): boolean {
  return isAbsolute(home) && dirname(home) === resolve(tmp) && /^workshop-smoke-[A-Za-z0-9]{6}$/.test(basename(home))
}

/**
 * Starts the reaper for this process's smoke socket and, when given, its folder. Returns false (and
 * starts nothing) for any other socket, or for a folder that is not a smoke run's in `tmp`.
 */
export function reapTmuxWhenGone(socket: string, env: NodeJS.ProcessEnv, pid = process.pid, home?: { path: string; tmp: string }): boolean {
  if (!SMOKE_SOCKET_RE.test(socket)) return false
  if (home && !isSmokeHome(home.path, home.tmp)) return false
  // Where tmux keeps a -L socket: $TMUX_TMPDIR (else /tmp)/tmux-<uid>/<name>, as Tmux.killServer.
  const path = join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket)
  const child = spawn('/bin/sh', ['-c', REAPER_SCRIPT, 'workshop-smoke-reaper', String(pid), socket, path, home?.path ?? ''], {
    env,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  return true
}
