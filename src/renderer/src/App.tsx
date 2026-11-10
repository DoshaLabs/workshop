// Core's window: sessions on the left (they arrive in roadmap step 3), what you are on now in the
// center, tiles on the right. Core draws every tile's head; the tile's page fills the face.
//
// The column holds tile INSTANCES. A tile's first instance is keyed by its id; a tile with
// `multiple: true` may have more, keyed `<id>.<n>` (n up to 4), each its own page and partition.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThemeState, TileHead, TileInfo, TileProblem } from '@shared/ipc'
import { syncCosmos } from './cosmos'
import { ThemePicker } from './ThemePicker'
import { TileLayer, type Instance } from './TileLayer'

const OFF_KEY = 'workshop.off'
const EXTRA_KEY = 'workshop.extra'
const MAX_INSTANCES = 4

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // the column still works, it just forgets
  }
}

/** Paints the window: the variables, and the attributes the stylesheet keys the wall and dark mode on. */
function applyTheme(t: ThemeState): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  root.dataset.theme = t.theme
  root.dataset.wall = String(t.wall)
  root.dataset.dark = String(t.dark)
  syncCosmos(t.theme)
}

const instanceN = (key: string): number => Number(/\.(\d)$/.exec(key)?.[1] ?? 1)
const tileIdOf = (key: string): string => key.replace(/\.\d$/, '')

export function App() {
  const [tiles, setTiles] = useState<TileInfo[]>([])
  const [problems, setProblems] = useState<TileProblem[]>([])
  /** Tiles whose first instance is turned off. */
  const [off, setOff] = useState<string[]>(() => readList(OFF_KEY))
  /** Second and later instances that are on: `<id>.<n>`. */
  const [extra, setExtra] = useState<string[]>(() => readList(EXTRA_KEY))
  const [pane, setPane] = useState<string | null>(null)
  const [heads, setHeads] = useState<Record<string, TileHead>>({})
  const [chips, setChips] = useState<Record<string, string>>({})
  const [theme, setTheme] = useState<ThemeState | null>(null)

  useEffect(() => {
    const load = () =>
      void window.core.listTiles().then((r) => {
        setTiles(r.tiles)
        setProblems(r.problems)
        applyTheme(r.theme)
        setTheme(r.theme)
      })
    load()
    const offs = [
      window.core.onTilesChanged(load),
      window.core.onTheme((t) => {
        applyTheme(t)
        setTheme(t)
      }),
      window.core.onTileHead((key, head) => setHeads((h) => ({ ...h, [key]: head }))),
      window.core.onTilePane((key, open) => setPane((p) => (open ? key : p === key ? null : p))),
      window.core.onTileNotify((key, text) => {
        setChips((c) => ({ ...c, [key]: text }))
        window.setTimeout(() => setChips((c) => (c[key] === text ? { ...c, [key]: '' } : c)), 8000)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [])

  useEffect(() => writeList(OFF_KEY, off), [off])
  useEffect(() => writeList(EXTRA_KEY, extra), [extra])

  /** Every instance that is on, each tile's together, in the catalog's order. */
  const instances = useMemo<Instance[]>(() => {
    const out: Instance[] = []
    for (const tile of tiles) {
      const id = tile.manifest.id
      if (!off.includes(id)) out.push({ key: id, n: 1, tile })
      if (!tile.manifest.multiple) continue
      for (const key of extra.filter((k) => tileIdOf(k) === id).sort()) out.push({ key, n: instanceN(key), tile })
    }
    return out
  }, [tiles, off, extra])

  useEffect(() => {
    for (const i of instances) void window.core.setView(i.key, pane === i.key ? 'pane' : 'tile')
  }, [pane, instances])

  useEffect(() => {
    if (!pane) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPane(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane])

  const close = useCallback((key: string) => {
    setPane((p) => (p === key ? null : p))
    if (instanceN(key) === 1) setOff((o) => [...o, key])
    else setExtra((x) => x.filter((k) => k !== key))
  }, [])

  /** Another instance of a `multiple` tile: the first one that is off, else the lowest free slot. */
  const another = (tile: TileInfo): void => {
    const id = tile.manifest.id
    if (off.includes(id)) return setOff((o) => o.filter((x) => x !== id))
    for (let n = 2; n <= MAX_INSTANCES; n++) {
      const key = `${id}.${n}`
      if (!extra.includes(key)) return setExtra((x) => [...x, key])
    }
  }
  const countOf = (id: string): number => instances.filter((i) => i.tile.manifest.id === id).length

  const offTiles = tiles.filter((t) => countOf(t.manifest.id) === 0)
  const paneInst = instances.find((i) => i.key === pane)
  const label = (i: Instance): string => heads[i.key]?.title || (i.n > 1 ? `${i.tile.manifest.name} ${i.n}` : i.tile.manifest.name)

  return (
    <div className="app">
      <div className="topbar">{theme && <ThemePicker theme={theme} />}</div>
      <aside className="col sessions">
        <div className="col-title">Sessions</div>
        <p className="empty">Sessions arrive with the core extraction (roadmap step 3).</p>
      </aside>

      <main className="col center">
        {paneInst ? (
          <section className="pane">
            <header className="head">
              <Icon tile={paneInst.tile} />
              <span className="name">{label(paneInst)}</span>
              <button className="ghost" title="Back to the column (Esc)" onClick={() => setPane(null)}>
                ×
              </button>
            </header>
            <div className="face pane-face" data-pane={paneInst.key} />
          </section>
        ) : (
          <section className="launcher">
            <h1>workshop</h1>
            <p>The launcher lives here once sessions arrive. For now: the tile column, on the right.</p>
            {problems.length > 0 && (
              <div className="problems">
                <h2>Tiles that were refused</h2>
                {problems.map((p) => (
                  <div key={p.folder} className="problem">
                    <code>{p.folder}</code>
                    <ul>
                      {p.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      <aside className="col tiles">
        <div className="tile-scroll">
          {instances.map((i) => {
            const t = i.tile
            const head = heads[i.key]
            return (
              <article key={i.key} className={`tile ${pane === i.key ? 'in-pane' : ''}`}>
                <header className="head">
                  <Icon tile={t} />
                  <span className="name" title={t.manifest.hint}>
                    {label(i)}
                  </span>
                  {head?.badge && <span className="badge">{head.badge}</span>}
                  {chips[i.key] && (
                    <span className="chip" title={chips[i.key]}>
                      {chips[i.key]}
                    </span>
                  )}
                  {t.source === 'dev' && <span className="dev">dev</span>}
                  {t.manifest.multiple && countOf(t.manifest.id) < MAX_INSTANCES && (
                    <button className="ghost" title={`Another ${t.manifest.name}`} onClick={() => another(t)}>
                      +
                    </button>
                  )}
                  {t.manifest.pane && (
                    <button className="ghost" title="Open large" onClick={() => setPane(pane === i.key ? null : i.key)}>
                      ⤢
                    </button>
                  )}
                  <button className="ghost" title="Turn off" onClick={() => close(i.key)}>
                    ×
                  </button>
                </header>
                <div className="face" data-face={i.key} style={{ height: t.manifest.span * 190 }}>
                  {pane === i.key && <span className="away">open in the center</span>}
                </div>
              </article>
            )
          })}
          {offTiles.length > 0 && (
            <div className="plus">
              {offTiles.map((t) => (
                <button key={t.manifest.id} onClick={() => another(t)}>
                  + {t.manifest.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <TileLayer instances={instances} pane={pane} />
    </div>
  )
}

function Icon({ tile }: { tile: TileInfo }) {
  return tile.icon ? <img className="icon" src={tile.icon} alt="" /> : <span className="icon letter">{tile.manifest.name[0]}</span>
}
