// Drag to reorder, for both columns: where each tile goes, given what is showing and the order the
// user saved. Pure, so it is tested on its own (test/order.test.ts). After deck's
// shared/gridorder.ts, cut down to one list per column.
//
// The saved order keeps keys that are not showing now (a tile turned off, a session parked), so a
// tile that comes back takes its old place. A key the order has never seen goes to the foot, in
// the default order it came in: nothing that appears ever pushes the others down.

/** Saved keys are capped, so a column that has seen thousands of sessions does not grow for ever. */
export const ORDER_MAX = 200

/** The whole order: the saved one (deduplicated), then every showing key it does not know, in the order given. */
export function arrange(showing: string[], saved: string[]): string[] {
  const out = [...new Set(saved)]
  const known = new Set(out)
  for (const k of showing) if (!known.has(k)) out.push(k), known.add(k)
  return out
}

/** What to draw: `arrange`, cut to what is showing. */
export function ordered(showing: string[], saved: string[]): string[] {
  const here = new Set(showing)
  return arrange(showing, saved).filter((k) => here.has(k))
}

/** `full` with `key` moved before (or `after`) `target`; a null or unknown target is the foot. */
export function moved(full: string[], key: string, target: string | null, after = false): string[] {
  const out = full.filter((k) => k !== key)
  const i = target === null || target === key ? -1 : out.indexOf(target)
  if (i < 0) out.push(key)
  else out.splice(i + (after ? 1 : 0), 0, key)
  return out
}

/**
 * The order worth saving: the most recent ORDER_MAX keys, keeping every one that is showing.
 * `keep` says which of the others can come back (an extra instance that was closed cannot).
 */
export function pruned(full: string[], showing: string[], keep: (key: string) => boolean = () => true): string[] {
  const here = new Set(showing)
  const out = full.filter((k) => here.has(k) || keep(k))
  // Past the cap, keys that are not showing go first, lowest in the column first.
  while (out.length > ORDER_MAX) {
    let j = out.length - 1
    while (j >= 0 && here.has(out[j])) j--
    if (j < 0) break
    out.splice(j, 1)
  }
  return out
}
