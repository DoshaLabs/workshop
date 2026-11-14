// The History tab's commit graph, laid out: which column each commit sits in and the lines that
// join it to its parents, as Fork and GitKraken draw it. Lanes are coloured by the session whose
// commit started them, not by branch name: in workshop a session is the thread of work. No DOM;
// tested as shipped (test/git-diff.test.ts).

/** Columns past this are folded into the last one (a repository with fifty live branches). */
export const MAX_COLS = 8

/**
 * Lays out `commits` (newest first, each { sha, parents, by }) row by row:
 * [{ col, colour, up: [[from, to, colour]], down: [[from, to, colour]], width }]
 * `up` are the lines in the top half of the row (from a column at the row's top edge to one at its
 * middle), `down` those in the bottom half (middle to bottom edge). `colour` is a session id or ''.
 */
export function layout(commits) {
  /** What each column waits for next: a sha, and the colour its line is drawn in. */
  let lanes = []
  const out = []
  const clamp = (c) => Math.min(c, MAX_COLS - 1)
  for (const c of commits) {
    let col = lanes.findIndex((l) => l && l.sha === c.sha)
    const fresh = col < 0
    if (fresh) {
      col = lanes.findIndex((l) => !l)
      if (col < 0) col = lanes.length
    }
    const colour = c.by?.ids?.length === 1 ? c.by.ids[0] : fresh ? '' : lanes[col].colour
    const up = []
    lanes.forEach((l, i) => {
      if (!l) return
      if (l.sha === c.sha) up.push([clamp(i), clamp(col), l.colour])
      else up.push([clamp(i), clamp(i), l.colour])
    })
    // Every column that waited for this commit ends here; the commit's own carries on to its first parent.
    lanes = lanes.map((l) => (l && l.sha === c.sha ? null : l))
    const parents = c.parents ?? []
    if (parents[0]) lanes[col] = { sha: parents[0], colour }
    const extra = []
    for (const p of parents.slice(1)) {
      let j = lanes.findIndex((l) => l && l.sha === p)
      if (j < 0) {
        j = lanes.findIndex((l) => !l)
        if (j < 0) j = lanes.length
        lanes[j] = { sha: p, colour: '' }
      }
      extra.push(j)
    }
    const down = []
    lanes.forEach((l, i) => {
      if (!l) return
      if (i === col || extra.includes(i)) down.push([clamp(col), clamp(i), i === col ? colour : l.colour])
      else down.push([clamp(i), clamp(i), l.colour])
    })
    while (lanes.length && !lanes.at(-1)) lanes.pop()
    const width = Math.min(MAX_COLS, Math.max(col + 1, ...up.map((u) => u[0] + 1), ...down.map((d) => d[1] + 1), 1))
    out.push({ col: clamp(col), colour, up, down, width })
  }
  return out
}

/** The widest row: how many columns the graph needs. */
export const graphWidth = (rows) => rows.reduce((w, r) => Math.max(w, r.width), 1)
