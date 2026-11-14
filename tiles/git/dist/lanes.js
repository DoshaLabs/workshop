// The tile in the column: every open session's working tree as a lane (GitButler's idea, with
// workshop's sessions as the lanes), coloured as its session's tile. One glance says what everyone
// is changing: the branch, the files, +/−, what is waiting to push or pull, the pull request's
// checks, and where two lanes touch one file. A click opens the lane's review in the pane.

import { S, pickLane, render, ws } from './app.js'
import { el } from './dom.js'
import { LETTER, STATUS_WORDS, barOf, bandOf, chipFiles, filesLabel, laneOverlaps, laneStatus, names, prOfBranch, splitPath } from './model.js'
import { refreshDiffs } from './data.js'

const CI = { ok: ['green', '✓'], fail: ['red', '✕'], run: ['yellow', '●'] }

/** A check state as a chip: "✓ CI", "✕ #14", "● 2 running". */
export function ciPill(state, label) {
  if (!state) return null
  const [c, g] = CI[state]
  return el('span', { class: `pill ${c}`, title: state === 'ok' ? 'Checks pass' : state === 'fail' ? 'A check failed' : 'Checks are running' }, `${g} ${label}`)
}

export function statusMark(st) {
  return el('span', { class: `mark ${st}`, title: STATUS_WORDS[st] || undefined, 'aria-hidden': 'true' })
}

/** What a lane says it is on: its branch (or detached), its worktree when not the main one. */
export const branchName = (w) => w.branch?.head ?? (w.branch?.oid ? `detached at ${w.branch.oid.slice(0, 7)}` : w.name)

export function lane(p, w) {
  const band = bandOf(w, S.sessions)
  const st = laneStatus(w, S.sessions)
  const clean = !w.error && !w.count
  const pr = prOfBranch(S.prs.get(p.root)?.prs, w.branch?.head)
  const { shown, more } = chipFiles(w)
  const bar = barOf(w)
  const up = w.branch?.ahead ?? 0
  const down = w.branch?.behind ?? 0
  return el(
    'button',
    {
      class: `line lane${clean ? ' clean' : ''}`,
      'data-top': w.top,
      'data-band': band ?? undefined,
      'aria-expanded': String(ws.view !== 'tile' && S.lane === w.top),
      title: w.top,
      onclick: () => {
        pickLane(w.top)
        void ws.openPane().catch(() => {})
        void refreshDiffs(true)
      }
    },
    el(
      'span',
      { class: 'row' },
      statusMark(st),
      el('span', { class: 'who nowrap' }, names(w.sessions)),
      el('span', { class: 'branch nowrap' }, branchName(w)),
      w.main ? null : el('span', { class: 'tag mono nowrap' }, `⑂ worktree ${w.name}`),
      el('span', { class: 'spacer' }),
      w.error ? null : clean ? el('span', { class: 'tag' }, 'clean') : el('span', { class: 'counts pill' }, el('span', { class: 'add' }, `+${w.add}`), ' ', el('span', { class: 'del' }, `−${w.del}`))
    ),
    clean || w.error ? null : el('span', { class: 'bar', 'aria-hidden': 'true' }, el('span', { class: 'a', style: { width: `${bar.add}%` } }), el('span', { class: 'd', style: { width: `${bar.del}%` } })),
    w.error
      ? el('span', { class: 'row' }, el('span', { class: 'pill red' }, w.error))
      : el(
          'span',
          { class: 'chips' },
          shown.map((f) => el('span', { class: 'fchip', title: f.path }, el('span', { class: `letter k-${f.kind}` }, LETTER[f.kind] ?? 'M'), ' ', splitPath(f.path).name)),
          clean ? null : el('span', { class: 'pill', title: more > 0 ? `${more} more not shown here` : undefined }, filesLabel(w)),
          up ? el('span', { class: 'pill green', title: `${up} commit${up === 1 ? '' : 's'} not pushed` }, `↑${up} to push`) : null,
          down ? el('span', { class: 'pill yellow', title: `${down} commit${down === 1 ? '' : 's'} to pull` }, `↓${down} to pull`) : null,
          pr ? ciPill(pr.state ?? 'run', `#${pr.number}`) ?? el('span', { class: 'pill' }, `#${pr.number}`) : null,
          st === 'blocked' ? el('span', { class: 'pill red' }, 'needs you') : null
        )
  )
}

function overlapsOf(p) {
  return laneOverlaps(p).map((o) =>
    el(
      'div',
      { class: 'overlap', title: o.files.join('\n') },
      el('span', { 'aria-hidden': 'true' }, '⚠'),
      el('span', {}, `${o.a} and ${o.b} both change `, el('span', { class: 'mono' }, o.files.length === 1 ? o.files[0] : `${o.files.length} files: ${o.files.slice(0, 2).join(', ')}${o.files.length > 2 ? '…' : ''}`))
    )
  )
}

/** The tile's body: each project, its lanes, where they collide, and sessions outside git. */
export function drawLanes() {
  if (!S.projects) return [el('p', { class: 'muted empty' }, 'Reading…')]
  if (!S.projects.length) return [el('p', { class: 'muted empty' }, 'No sessions open. Each session’s changes show here as a lane, by project.')]
  return S.projects.map((p) => {
    const base = S.prs.get(p.root)?.base
    return el(
      'section',
      { class: 'project', 'data-root': p.root },
      el('div', { class: 'project-head', title: p.root }, el('span', { class: 'project-name' }, p.name), el('span', { class: 'path' }, `‎${p.root}`), el('span', { class: 'spacer' }), base ? ciPill(base.state, `${base.name}`) : null),
      el('div', { class: 'lanes' }, p.worktrees.map((w) => lane(p, w))),
      overlapsOf(p),
      p.outside.map((s) => el('div', { class: 'outside muted', title: s.folder }, `${s.name} · not in a git repository`))
    )
  })
}

/** The pane's strip of lanes: every lane in every project, the shown one marked. */
export function switcher() {
  const all = []
  for (const p of S.projects ?? []) for (const w of p.worktrees) all.push({ p, w })
  if (!all.length) return null
  return el(
    'nav',
    { class: 'switcher', 'aria-label': 'Lanes' },
    all.map(({ p, w }) =>
      el(
        'button',
        {
          class: 'line',
          'data-top': w.top,
          'data-band': bandOf(w, S.sessions) ?? undefined,
          'aria-expanded': String(S.lane === w.top),
          title: `${p.name} · ${w.top}`,
          onclick: () => {
            pickLane(w.top)
            render()
            void refreshDiffs(true).then(render)
          }
        },
        statusMark(laneStatus(w, S.sessions)),
        el('span', { class: 'nowrap' }, names(w.sessions) || w.name),
        w.main ? null : el('span', { class: 'tag nowrap' }, `worktree ${w.name}`),
        w.count ? el('span', { class: 'counts' }, el('span', { class: 'add' }, `+${w.add}`), ' ', el('span', { class: 'del' }, `−${w.del}`)) : el('span', { class: 'tag' }, 'clean'),
        el('span', { class: 'tag nowrap' }, `· ${branchName(w)} · ${filesLabel(w)}`)
      )
    )
  )
}
