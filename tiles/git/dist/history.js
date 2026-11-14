// The History tab: the log across every branch, drawn as a graph (Fork, GitKraken) whose lanes take
// the colour of the session that made their commits, a search that reads tokens (Sublime Merge),
// and "Today, by session". A click unfolds a commit: who and when, its refs, Copy sha, its diff.

import { S, copy, render, save, session } from './app.js'
import { el, svg } from './dom.js'
import { drawFiles } from './diffview.js'
import { ago, byLabel, byTitle, groupCount, refsShown, short, todayBySession } from './model.js'
import { layout, graphWidth } from './graph.js'
import { chips, isEmpty, matches, parseQuery } from './query.js'
import { refreshHistory, toggleCommit } from './data.js'
import { statusMark } from './lanes.js'

const ROW = 40
const COL = 14
/** The colour a session's line is drawn in: the band its tile wears, as a readable line colour. */
const BAND_LINE = ['var(--accent-ink)', 'var(--accent-ink)', 'var(--cyan)', 'var(--magenta)', 'var(--blue)']
function lineColour(id) {
  if (!id) return 'var(--muted)'
  const b = session(id)?.band
  return BAND_LINE[b ?? 0]
}

/** One row of the graph as an SVG, ROW tall: the lines through it and the commit's dot. */
function graphCell(row, width, c) {
  const w = width * COL + 8
  const x = (k) => 8 + k * COL
  const mid = ROW / 2
  const bend = (a, b, y0, y1) => (a === b ? `M${x(a)} ${y0}V${y1}` : `M${x(a)} ${y0}C${x(a)} ${y0 + (y1 - y0) * 0.7},${x(b)} ${y0 + (y1 - y0) * 0.3},${x(b)} ${y1}`)
  const colour = lineColour(row.colour)
  const exact = c.by?.kind === 'exact'
  const probable = c.by?.kind === 'probable'
  return svg(
    'svg',
    { class: 'graph', width: String(w), height: String(ROW), viewBox: `0 0 ${w} ${ROW}`, 'aria-hidden': 'true' },
    row.up.map(([a, b, k]) => svg('path', { d: bend(a, b, 0, mid), fill: 'none', 'stroke-width': '2', style: { stroke: lineColour(k) } })),
    row.down.map(([a, b, k]) => svg('path', { d: bend(a, b, mid, ROW), fill: 'none', 'stroke-width': '2', style: { stroke: lineColour(k) } })),
    svg('circle', { cx: String(x(row.col)), cy: String(mid), r: exact || probable ? '5.5' : '4.5', 'stroke-width': '2.2', 'stroke-dasharray': probable ? '3 2' : undefined, style: { stroke: colour, fill: 'var(--panel)' } }),
    exact ? svg('circle', { cx: String(x(row.col)), cy: String(mid), r: '2.2', style: { fill: colour } }) : null
  )
}

/** The tag naming who made a commit, in that session's tile colour. */
function byTag(c, inGroup) {
  if (!c.by || (inGroup && c.by.kind === 'exact')) return null
  return el('span', { class: `by ${c.by.kind}`, title: byTitle(c.by), 'data-band': c.by.ids.length === 1 ? (session(c.by.ids[0])?.band ?? undefined) : undefined }, byLabel(c.by))
}

function drawer(root, c) {
  const when = new Date(c.ct)
  return el(
    'div',
    { class: 'drawer' },
    el('div', { class: 'row1' }, el('span', { class: 'sha', title: c.sha }, c.sha.slice(0, 12)), el('span', { class: 'muted' }, `${c.author} · ${when.toLocaleString()}`), el('span', { class: 'spacer' }), c.parents.length > 1 ? el('span', { class: 'pill' }, `merge of ${c.parents.length}`) : null),
    c.by ? el('div', { class: 'muted' }, byTitle(c.by)) : null,
    el('div', { class: 'acts' }, el('button', { class: 'act small', 'data-act': 'copysha', onclick: () => void copy(c.sha, 'the sha') }, 'Copy sha'), el('button', { class: 'act small', onclick: () => void copy(c.subject, 'the subject') }, 'Copy subject')),
    drawFiles({ key: `commit ${c.sha}`, top: null, empty: c.parents.length > 1 ? 'This merge brought no changes of its own.' : 'No changes to files.' }, S.commitDiffs.get(c.sha))
  )
}

/** One commit: graph, subject, refs, its session, short sha and when. A click unfolds it. */
function commitRow(root, c, row, width, { inGroup = false } = {}) {
  const open = S.openCommits.has(c.sha)
  return el(
    'div',
    { class: 'commit', 'data-sha': c.sha },
    el(
      'button',
      { class: `line${open ? ' open' : ''}`, 'aria-expanded': String(open), onclick: () => void toggleCommit(root, c) },
      row ? graphCell(row, width, c) : el('span', { style: { width: '12px', flex: 'none' } }),
      el(
        'span',
        { class: 'text' },
        el('span', { class: 'row1' }, el('span', { class: 'subject' }, c.subject || '(no message)'), el('span', { class: 'spacer' }), el('span', { class: 'muted sha' }, c.sha.slice(0, 7))),
        el(
          'span',
          { class: 'row2' },
          byTag(c, inGroup),
          c.parents.length > 1 ? el('span', { class: 'muted tag' }, 'merge') : null,
          refsShown(c.refs).map((r) => el('span', { class: `ref ${r.kind}` }, r.kind === 'tag' ? `tag ${r.name}` : r.name)),
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted ago', title: `${new Date(c.ct).toLocaleString()} · ${c.author}` }, ago(c.ct))
        )
      )
    ),
    open ? drawer(root, c) : null
  )
}

let searchTimer = null
function search() {
  const q = parseQuery(S.query)
  return [
    el(
      'label',
      { class: 'search' },
      el('span', { class: 'muted', 'aria-hidden': 'true' }, '⌕'),
      el('input', {
        type: 'search',
        'data-key': 'histq',
        'aria-label': 'Search commits',
        placeholder: 'Search: words, session:name, author:, path:src/, since:2d',
        value: S.query,
        oninput: (e) => {
          const was = parseQuery(S.query).path
          S.query = e.target.value
          clearTimeout(searchTimer)
          searchTimer = setTimeout(() => {
            render()
            // A path is asked of git; the rest is filtered here.
            if (parseQuery(S.query).path !== was) void refreshHistory()
          }, 200)
        },
        onkeydown: (e) => e.stopPropagation()
      }),
      el('span', { class: 'k' }, '/')
    ),
    isEmpty(q) ? null : el('div', { class: 'qchips' }, chips(q).map((c) => el('span', { class: 'pill' }, c.key ? `${c.key}: ${c.value}` : c.value)))
  ]
}

export function drawHistory() {
  if (S.histError && !S.hist) return [el('p', { class: 'err empty' }, `Could not read the history: ${S.histError}`)]
  if (!S.hist) return [el('p', { class: 'muted empty' }, 'Reading…')]
  if (!S.hist.projects.length) return [el('p', { class: 'muted empty' }, 'No sessions open. The history of each session’s project shows here.')]
  const q = parseQuery(S.query)
  const now = Date.now()
  if (S.histFilter === 'today') {
    const groups = todayBySession(S.hist.projects)
    const many = S.hist.projects.length > 1
    return [
      search(),
      ...(groups.length
        ? groups.map((g) =>
            el(
              'section',
              { class: `project hgroup ${g.kind}`, 'data-group': g.key },
              el(
                'div',
                { class: 'project-head' },
                g.kind === 'session' ? statusMark(session(g.key.slice(2))?.status ?? 'unknown') : null,
                el('span', { class: g.kind === 'session' ? 'project-name' : 'project-name muted' }, g.label),
                many || g.kind !== 'session' ? el('span', { class: 'muted' }, g.project) : null,
                el('span', { class: 'spacer' }),
                el('span', { class: 'muted count' }, groupCount(g))
              ),
              g.commits.filter((c) => matches(c, q, now)).map((c) => commitRow(g.root, c, null, 1, { inGroup: g.kind === 'session' }))
            )
          )
        : [el('p', { class: 'muted empty' }, 'No commits in the last 24 hours.')])
    ]
  }
  return [
    search(),
    el(
      'div',
      { class: 'legend' },
      el('span', {}, '● made by a session'),
      el('span', {}, '◌ probably'),
      el('span', {}, '○ no session')
    ),
    ...S.hist.projects.map((p) => {
      const filtered = isEmpty({ ...q, path: null }) && S.histFilter !== 'sessions' ? p.commits : p.commits.filter((c) => matches(c, q, now) && (S.histFilter !== 'sessions' || c.by))
      // The graph needs every commit in order; a filtered list is drawn without it.
      const whole = filtered.length === p.commits.length && !q.path
      const rows = whole ? layout(p.commits) : null
      const width = rows ? graphWidth(rows) : 1
      return el(
        'section',
        { class: 'project hproject', 'data-root': p.root },
        el('div', { class: 'project-head', title: p.root }, el('span', { class: 'project-name' }, p.name), el('span', { class: 'path' }, `‎${p.root}`), el('span', { class: 'spacer' }), whole ? null : el('span', { class: 'muted' }, `${filtered.length} of ${p.commits.length}`)),
        p.error ? el('p', { class: 'err note' }, p.error) : null,
        !p.error && !p.commits.length ? el('p', { class: 'muted note' }, q.path ? 'No commits touch that path.' : 'No commits yet.') : null,
        filtered.map((c, i) => commitRow(p.root, c, rows ? rows[i] : null, width)),
        p.more
          ? el(
              'button',
              {
                class: 'act more',
                'data-act': 'more',
                disabled: S.histLimit >= 3000,
                onclick: () => {
                  S.histLimit += 300
                  void refreshHistory()
                }
              },
              S.histLimit >= 3000 ? 'Showing the newest 3,000' : 'Show 300 more'
            )
          : null
      )
    })
  ]
}

/** The History tab's filters, for the bar. */
export const HIST_FILTERS = [
  ['all', 'All'],
  ['today', 'Today, by session'],
  ['sessions', 'Made by sessions']
]
export function setHistFilter(id) {
  S.histFilter = id
  save('histFilter', id)
  render()
}
export { short }
