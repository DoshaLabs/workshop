// The PRs tab, through the user's own gh: each open pull request with its session, review state and
// checks; a failed check unfolds to the end of its log, which "Ask a session to fix it" types into
// the session on that branch (or opens the new-session form in its worktree); main's CI; and a pull
// request opened from any worktree branch with commits main lacks.

import { S, act, arm, armedNow, call, render, save, say, ws } from './app.js'
import { el } from './dom.js'
import { REVIEW_WORDS, fixMessage, short, took } from './model.js'
import { refreshPrs, refreshWorktrees, roots } from './data.js'
import { ciPill } from './lanes.js'
import { drawResult } from './worktrees.js'

const GLYPH = { ok: '✓', fail: '✕', run: '●', skip: '–' }

/** The session working on a branch now (its lane), if any. */
function sessionOn(branch) {
  for (const p of S.projects ?? []) for (const w of p.worktrees) if (w.branch?.head === branch && w.sessions.length) return w.sessions[0]
  return null
}
/** The worktree a branch is checked out in, from the Worktrees answer. */
function worktreeOf(root, branch) {
  return S.wt?.projects.find((p) => p.root === root)?.worktrees.find((w) => w.branch === branch) ?? null
}

async function showLog(root, c) {
  const k = `${root} ${c.run}`
  if (S.checkLogs.has(k)) {
    S.checkLogs.delete(k)
    render()
    return
  }
  S.checkLogs.set(k, { loading: true })
  render()
  try {
    S.checkLogs.set(k, await call('checklog', { root, run: c.run }))
  } catch (e) {
    S.checkLogs.set(k, { error: e.message })
  }
  render()
}

async function askFix(root, p, c) {
  const k = `${root} ${c.run}`
  let log = S.checkLogs.get(k)?.lines
  if (!log && c.run) {
    try {
      log = (await call('checklog', { root, run: c.run })).lines
    } catch {
      log = null
    }
  }
  const s = sessionOn(p.head)
  if (s && ws.sessions.paste) {
    try {
      await ws.sessions.paste(s.id, fixMessage(p, c, log))
      say(`told ${s.name} about the failing check`)
    } catch (e) {
      say(e.message, false)
    }
    return
  }
  const w = worktreeOf(root, p.head)
  try {
    await ws.sessions.launch({ folder: w?.path ?? root })
    say(`no session is on ${p.head}: the new-session form is open${w ? ' in its worktree' : ''}`)
  } catch (e) {
    say(e.message, false)
  }
}

function prCard(root, p) {
  const open = S.openPrs.has(`${root} ${p.number}`)
  const s = sessionOn(p.head)
  const fails = p.checks.filter((c) => c.state === 'fail')
  const running = p.checks.filter((c) => c.state === 'run').length
  return el(
    'div',
    { class: `pr${p.state === 'fail' ? ' fail' : ''}`, 'data-pr': p.number },
    el(
      'button',
      {
        class: 'line',
        'aria-expanded': String(open),
        onclick: () => {
          const k = `${root} ${p.number}`
          if (S.openPrs.has(k)) S.openPrs.delete(k)
          else S.openPrs.add(k)
          render()
        }
      },
      el('span', { class: 'row1' }, el('span', { class: p.state === 'fail' ? 'del' : p.state === 'ok' ? 'add' : 'warn', 'aria-label': `checks ${p.state ?? 'none'}` }, GLYPH[p.state] ?? '○'), el('span', { class: 'title' }, p.title), el('span', { class: 'mono muted' }, `#${p.number}`)),
      el(
        'span',
        { class: 'row2' },
        s ? el('span', { class: 'by exact', 'data-band': S.sessions.find((x) => x.id === s.id)?.band ?? undefined }, s.name) : el('span', { class: 'pill' }, 'no session'),
        p.draft ? el('span', { class: 'pill' }, 'draft') : null,
        p.review ? el('span', { class: `pill ${p.review === 'APPROVED' ? 'green' : p.review === 'CHANGES_REQUESTED' ? 'red' : 'yellow'}` }, REVIEW_WORDS[p.review] ?? p.review.toLowerCase()) : null,
        el('span', { class: 'mono muted nowrap' }, `${p.head} → ${p.base}`),
        p.add != null ? el('span', { class: 'counts' }, el('span', { class: 'add' }, `+${p.add}`), ' ', el('span', { class: 'del' }, `−${p.del}`)) : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted' }, p.checks.length ? (running ? `${running} running` : `${p.checks.filter((c) => c.state === 'ok').length} / ${p.checks.length} checks`) : 'no checks'),
        el('span', { class: 'muted' }, short(p.updated))
      )
    ),
    open || fails.length
      ? el(
          'div',
          { class: 'body' },
          (open ? p.checks : fails).map((c) => {
            const k = `${root} ${c.run}`
            const log = S.checkLogs.get(k)
            return [
              el('div', { class: 'chk' }, el('span', { class: `s-${c.state}` }, GLYPH[c.state]), el('span', { class: 'spacer nowrap', style: { fontWeight: c.state === 'fail' ? '700' : '400' } }, c.name), el('span', { class: 'mono muted' }, took(c.ms))),
              c.state === 'fail'
                ? el(
                    'div',
                    { class: 'acts' },
                    el('button', { class: 'act primary small', 'data-act': 'fix', onclick: () => void askFix(root, p, c) }, s ? `Ask ${s.name} to fix it` : 'Ask a session to fix it'),
                    c.run ? el('button', { class: 'act small', 'data-act': 'log', onclick: () => void showLog(root, c) }, log ? 'Hide log' : 'Show log') : null,
                    c.run ? el('button', { class: 'act small', 'data-act': 'rerun', disabled: !!S.acting, onclick: () => void act(`rerun ${c.run}`, 'rerun', { root, run: c.run }, refreshPrs) }, 'Re-run') : null,
                    c.url ? el('button', { class: 'act small', onclick: () => void ws.openExternal(c.url) }, 'Full log ↗') : null
                  )
                : null,
              log ? (log.loading ? el('p', { class: 'muted note' }, 'Reading the log…') : log.error ? el('p', { class: 'err note' }, log.error) : el('pre', { class: 'log' }, (log.more ? `… ${log.more} lines before\n` : '') + log.lines.join('\n'))) : null
            ]
          }),
          el('div', { class: 'acts' }, el('button', { class: 'act small', onclick: () => void ws.openExternal(p.url) }, 'Open on GitHub ↗'))
        )
      : null
  )
}

/** "Open a pull request": worktree branches with commits main lacks and no pull request yet. */
function newPr(root, prs) {
  const proj = S.wt?.projects.find((p) => p.root === root)
  if (!proj?.base) return null
  const have = new Set(prs.map((p) => p.head))
  const can = proj.worktrees.filter((w) => w.branch && !w.isBase && (w.ahead ?? 0) > 0 && !have.has(w.branch) && w.prunable == null)
  if (!can.length) return null
  const pick = S.results.get(`prpick ${root}`)?.path ?? can[0].path
  const w = can.find((x) => x.path === pick) ?? can[0]
  const key = `openpr ${w.path}`
  const on = armedNow(key)
  const res = S.results.get(`openpr ${root}`)
  return el(
    'div',
    { class: 'newpr' },
    el('div', { class: 'row1' }, el('b', {}, 'Open a pull request'), el('span', { class: 'spacer' }), el('span', { class: 'muted' }, `into ${proj.base.name}`)),
    el(
      'div',
      { class: 'row1' },
      el(
        'select',
        { class: 'sel-box', 'aria-label': 'Branch', onchange: (e) => (S.results.set(`prpick ${root}`, { path: e.target.value }), render()) },
        can.map((x) => el('option', { value: x.path, selected: x.path === w.path ? true : undefined }, `${x.branch} · ↑${x.ahead}`))
      ),
      el('span', { class: 'spacer' }),
      el(
        'button',
        {
          class: `act go${on ? ' armed' : ''}`,
          'data-act': 'openpr',
          disabled: !!S.acting,
          onclick: () =>
            arm(key, async () => {
              const r = await act(key, 'openpr', { root, path: w.path }, async () => {
                await refreshPrs()
                await refreshWorktrees()
              })
              S.results.set(`openpr ${root}`, r ? { ok: true, said: r.said } : { ok: false, said: 'not opened: see the message above' })
              if (r?.url) void ws.openExternal(r.url).catch(() => {})
              render()
            })
        },
        S.acting === key ? 'Opening…' : on ? 'Push and open? Click again' : 'Push and open'
      )
    ),
    el('div', { class: 'muted' }, 'Its title and description come from its commits; you edit them on GitHub. Never force-pushed.'),
    res ? drawResult(res) : null
  )
}

export function drawPrs() {
  const list = roots()
  if (!list.length) return [el('p', { class: 'muted empty' }, 'No sessions open. Each session’s project’s pull requests show here.')]
  return list.map((root) => {
    const d = S.prs.get(root)
    const name = root.replace(/\/+$/, '').split('/').pop()
    return el(
      'section',
      { class: 'project prproject', 'data-root': root },
      el('div', { class: 'project-head', title: root }, el('span', { class: 'project-name' }, name), el('span', { class: 'spacer' }), d?.base ? ciPill(d.base.state, `${d.base.name}`) : null),
      !d ? el('p', { class: 'muted note' }, 'Asking gh…') : null,
      d?.error ? el('p', { class: 'err note' }, d.error) : null,
      d && !d.error && !d.prs.length ? el('p', { class: 'muted note' }, S.prWhich === 'review' ? 'Nothing waits for your review.' : S.prWhich === 'merged' ? 'No merged pull requests.' : 'No open pull requests.') : null,
      (d?.prs ?? []).map((p) => prCard(root, p)),
      S.prWhich === 'open' && d && !d.error ? newPr(root, d.prs) : null
    )
  })
}

export const PR_FILTERS = [
  ['open', 'Open'],
  ['review', 'Needs my review'],
  ['merged', 'Merged']
]
export function setPrFilter(id) {
  S.prWhich = id
  save('prWhich', id)
  S.prs.clear()
  render()
  void refreshPrs()
}
