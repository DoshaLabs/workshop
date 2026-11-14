// The PRs tab, in the backend: pull requests and their checks, and main's latest CI, through the
// user's own `gh` CLI (signed in with `gh auth login`; core never sees a token). Like git: an argv,
// never a shell; a timeout and a cap; no prompts (GH_PROMPT_DISABLED), no colour. Opening a pull
// request pushes the branch first, never forced.

import { spawn } from 'node:child_process'
import { failure, git, note } from './git.mjs'
import { Refused } from './oplog.mjs'

const GH_MS = 30_000
const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_PAGER: 'cat', PAGER: 'cat' }
const PR_FIELDS = 'number,title,headRefName,baseRefName,additions,deletions,reviewDecision,isDraft,url,author,updatedAt,statusCheckRollup'
/** Lines of a failed check's log the page is given: its end, where the error is. */
export const LOG_LINES = 60

/** Runs gh in `cwd`: { code, out, err, missing }. Never throws. */
export function gh(cwd, args, { timeout = GH_MS, cap = 4 << 20 } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('gh', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message, missing: e.code === 'ENOENT' })
      return
    }
    let out = ''
    let err = ''
    let missing = false
    child.stdout.on('data', (b) => {
      if (out.length < cap) out += b.toString('utf8')
      else child.kill('SIGTERM')
    })
    child.stderr.on('data', (b) => {
      if (err.length < 8000) err += b.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('error', (e) => {
      if (e.code === 'ENOENT') missing = true
      err ||= e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      note('gh', cwd, args, { ms: Date.now() - started, code: code ?? -1, write: false })
      resolve({ code: code ?? -1, out, err: err.trim(), missing })
    })
  })
}

/** gh's failure as a sentence the page can show, with what to do. */
export function ghProblem(r) {
  if (r.missing) return 'gh is not installed: brew install gh, then gh auth login'
  if (/auth login|not logged|authentication|GH_TOKEN/i.test(r.err)) return 'gh is not signed in: run gh auth login in a terminal'
  if (/no git remotes|none of the git remotes|not a git repository|could not determine/i.test(r.err)) return 'this project has no GitHub remote'
  return r.err.split('\n').find(Boolean) || 'gh failed'
}

/** A run's id from a check's link (…/actions/runs/<id>/job/<id>), or null. */
export const runOf = (url) => {
  const m = /\/actions\/runs\/(\d+)/.exec(url ?? '')
  return m ? m[1] : null
}

/** One check, CheckRun or StatusContext, as { name, state: ok | fail | run | skip, ms, url, run }. */
export function check(c) {
  if (c.__typename === 'StatusContext' || c.context) {
    const s = String(c.state ?? '').toUpperCase()
    return { name: c.context ?? 'status', state: s === 'SUCCESS' ? 'ok' : s === 'PENDING' || s === 'EXPECTED' ? 'run' : 'fail', ms: null, url: c.targetUrl ?? null, run: runOf(c.targetUrl) }
  }
  const status = String(c.status ?? '').toUpperCase()
  const concl = String(c.conclusion ?? '').toUpperCase()
  let state = 'run'
  if (status === 'COMPLETED') state = concl === 'SUCCESS' ? 'ok' : concl === 'SKIPPED' || concl === 'NEUTRAL' ? 'skip' : 'fail'
  const ms = c.startedAt && c.completedAt ? Math.max(0, Date.parse(c.completedAt) - Date.parse(c.startedAt)) : null
  const name = c.workflowName && c.name && c.workflowName !== c.name ? `${c.workflowName} / ${c.name}` : (c.name ?? c.workflowName ?? 'check')
  return { name, state, ms, url: c.detailsUrl ?? null, run: runOf(c.detailsUrl) }
}

/** All checks as one: fail beats run beats ok; none is null. */
export function rollup(checks) {
  if (!checks.length) return null
  if (checks.some((c) => c.state === 'fail')) return 'fail'
  if (checks.some((c) => c.state === 'run')) return 'run'
  return 'ok'
}

/** A pull request as the page draws it. */
export function pr(p) {
  const checks = (p.statusCheckRollup ?? []).map(check)
  return {
    number: p.number,
    title: String(p.title ?? '').slice(0, 300),
    head: p.headRefName,
    base: p.baseRefName,
    add: p.additions ?? null,
    del: p.deletions ?? null,
    review: p.reviewDecision || null,
    draft: !!p.isDraft,
    url: p.url,
    author: p.author?.login ?? null,
    updated: Date.parse(p.updatedAt) || 0,
    checks,
    state: rollup(checks)
  }
}

/** The newest run of each workflow on `branch`, rolled up: main's CI. */
export function latestRuns(runs) {
  const seen = new Map()
  for (const r of runs) if (!seen.has(r.workflowName)) seen.set(r.workflowName, r)
  const checks = [...seen.values()].map((r) => check({ name: r.workflowName, status: r.status, conclusion: r.conclusion, detailsUrl: r.url }))
  return { state: rollup(checks), checks }
}

/** `which`: open, review (asked of me) or merged. → { prs, base: { name, state, checks } | null } */
export async function prs(root, which, baseName) {
  const args = ['pr', 'list', '--limit', '30', '--json', PR_FIELDS, '--state', which === 'merged' ? 'merged' : 'open']
  if (which === 'review') args.push('--search', 'review-requested:@me')
  const r = await gh(root, args)
  if (r.code !== 0) throw new Refused(ghProblem(r))
  let list
  try {
    list = JSON.parse(r.out)
  } catch {
    throw new Refused('gh answered with something other than JSON')
  }
  let base = null
  if (baseName) {
    const runs = await gh(root, ['run', 'list', '--branch', baseName, '--limit', '20', '--json', 'workflowName,status,conclusion,url'])
    if (runs.code === 0) {
      try {
        base = { name: baseName, ...latestRuns(JSON.parse(runs.out)) }
      } catch {
        // main's CI is left out
      }
    }
  }
  return { prs: list.map(pr), base }
}

/** "2026-11-14T09:12:03.1234567Z some text" or "job\tstep\t<that>" → "some text", colour codes gone. */
export function logLine(l) {
  const last = l.split('\t').at(-1) ?? ''
  return last.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '')
}

/** The end of a run's failed steps' log. */
export async function failedLog(root, run) {
  if (!/^\d{1,20}$/.test(String(run))) throw new Refused('which run')
  const r = await gh(root, ['run', 'view', String(run), '--log-failed'], { cap: 2 << 20, timeout: 60_000 })
  if (r.code !== 0) throw new Refused(ghProblem(r))
  const lines = r.out.split('\n').map(logLine)
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  return { lines: lines.slice(-LOG_LINES), more: Math.max(0, lines.length - LOG_LINES) }
}

/** Runs a run's failed jobs again. */
export async function rerun(root, run) {
  if (!/^\d{1,20}$/.test(String(run))) throw new Refused('which run')
  const r = await gh(root, ['run', 'rerun', String(run), '--failed'])
  if (r.code !== 0) throw new Refused(ghProblem(r))
  return { said: 'the failed jobs are running again' }
}

/** Pushes `branch` (from its worktree `path`) and opens a pull request into `base`, titled and described from its commits. */
export async function openPr(path, branch, base) {
  if (!branch) throw new Refused('not on a branch')
  if (branch === base) throw new Refused(`this is ${base} itself`)
  const p = await git(path, ['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { write: true, timeout: 90_000 })
  if (p.code !== 0) throw new Refused(`git push: ${failure(p, 'git push', 90_000)}`)
  const r = await gh(path, ['pr', 'create', '--fill', '--head', branch, '--base', base], { timeout: 60_000 })
  if (r.code !== 0) throw new Refused(ghProblem(r))
  const url = r.out.split('\n').map((l) => l.trim()).find((l) => /^https:\/\/\S+\/pull\/\d+$/.test(l)) ?? null
  return { said: `opened a pull request for ${branch}`, url }
}
