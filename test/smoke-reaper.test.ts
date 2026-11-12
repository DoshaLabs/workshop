import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSmokeHome, reapTmuxWhenGone } from '../src/main/smoke-reaper'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

const alive = (socket: string): boolean => {
  try {
    execFileSync('tmux', ['-L', socket, 'has-session'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('the smoke run’s tmux reaper', () => {
  it('reaps only a smoke run’s own socket', () => {
    expect(reapTmuxWhenGone('workshop', process.env)).toBe(false)
    expect(reapTmuxWhenGone('workshop-dev', process.env)).toBe(false)
    expect(reapTmuxWhenGone('workshop-smoke-1; rm -rf /', process.env)).toBe(false)
  })

  it.skipIf(!hasTmux)('ends the server and its socket once the run is gone, however it went', async () => {
    // A stand-in for the smoke run: a process that is killed outright, as a timed-out run would be.
    const run = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    const socket = `workshop-smoke-${run.pid}`
    const path = join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket)
    try {
      execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'probe', 'sleep 600'])
      expect(alive(socket)).toBe(true)
      expect(reapTmuxWhenGone(socket, process.env, run.pid!)).toBe(true)
      await new Promise((r) => setTimeout(r, 2500))
      expect(alive(socket)).toBe(true)
      run.kill('SIGKILL')
      const until = Date.now() + 8000
      while (alive(socket) && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
      await new Promise((r) => setTimeout(r, 200))
      expect(alive(socket)).toBe(false)
      expect(existsSync(path)).toBe(false)
    } finally {
      run.kill('SIGKILL')
      try {
        execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
      } catch {}
    }
  }, 15_000)

  it('removes only a smoke run’s own folder, directly in its temp folder', () => {
    const tmp = '/var/folders/x/T'
    expect(isSmokeHome('/var/folders/x/T/workshop-smoke-a1B2c3', tmp)).toBe(true)
    expect(isSmokeHome('/var/folders/x/T/workshop-smoke-a1B2c3', tmp + '/')).toBe(true)
    expect(isSmokeHome('/var/folders/x/T', tmp)).toBe(false)
    expect(isSmokeHome('/var/folders/x/T/workshop-smoke-a1B2c3/..', tmp)).toBe(false)
    expect(isSmokeHome('/var/folders/x/T/deep/workshop-smoke-a1B2c3', tmp)).toBe(false)
    expect(isSmokeHome('/Users/me/workshop-smoke-a1B2c3', tmp)).toBe(false)
    expect(isSmokeHome('workshop-smoke-a1B2c3', '.')).toBe(false)
    expect(isSmokeHome('/var/folders/x/T/workshop-smoke-', tmp)).toBe(false)
    expect(isSmokeHome('/var/folders/x/T/workshop-dev', tmp)).toBe(false)
    expect(reapTmuxWhenGone('workshop-smoke-1', process.env, process.pid, { path: homedir(), tmp: tmpdir() })).toBe(false)
  })

  it('removes the run’s folder once the run is gone', async () => {
    const tmp = realpathSync(tmpdir())
    const home = mkdtempSync(join(tmp, 'workshop-smoke-'))
    mkdirSync(join(home, 'tmp', 'ws-project-abc'), { recursive: true })
    writeFileSync(join(home, 'tmp', 'ws-project-abc', 'f'), 'x')
    const run = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    try {
      expect(reapTmuxWhenGone(`workshop-smoke-${run.pid}`, process.env, run.pid!, { path: home, tmp })).toBe(true)
      await new Promise((r) => setTimeout(r, 2500))
      expect(existsSync(home)).toBe(true)
      run.kill('SIGKILL')
      const until = Date.now() + 8000
      while (existsSync(home) && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
      expect(existsSync(home)).toBe(false)
    } finally {
      run.kill('SIGKILL')
    }
  }, 15_000)
})
