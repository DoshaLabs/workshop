// Core's window: sessions on the left (they arrive in roadmap step 3), what you are on now in the
// center, tiles on the right. Core draws every tile's head; the tile's page fills the face.

import { useCallback, useEffect, useState } from 'react'
import type { TileHead, TileInfo, TileProblem } from '@shared/ipc'
import { TileLayer } from './TileLayer'

const OFF_KEY = 'workshop.off'

function readOff(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OFF_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function applyVars(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v)
}

export function App() {
  const [tiles, setTiles] = useState<TileInfo[]>([])
  const [problems, setProblems] = useState<TileProblem[]>([])
  const [off, setOff] = useState<string[]>(readOff)
  const [pane, setPane] = useState<string | null>(null)
  const [heads, setHeads] = useState<Record<string, TileHead>>({})
  const [chips, setChips] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.core.listTiles().then((r) => {
      setTiles(r.tiles)
      setProblems(r.problems)
      applyVars(r.vars)
    })
    const offs = [
      window.core.onTheme(applyVars),
      window.core.onTileHead((id, head) => setHeads((h) => ({ ...h, [id]: head }))),
      window.core.onTilePane((id, open) => setPane((p) => (open ? id : p === id ? null : p))),
      window.core.onTileNotify((id, text) => {
        setChips((c) => ({ ...c, [id]: text }))
        window.setTimeout(() => setChips((c) => (c[id] === text ? { ...c, [id]: '' } : c)), 8000)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(OFF_KEY, JSON.stringify(off))
    } catch {
      // the column still works, it just forgets
    }
  }, [off])

  useEffect(() => {
    for (const t of tiles) void window.core.setView(t.manifest.id, pane === t.manifest.id ? 'pane' : 'tile')
  }, [pane, tiles])

  useEffect(() => {
    if (!pane) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPane(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane])

  const on = tiles.filter((t) => !off.includes(t.manifest.id))
  const offTiles = tiles.filter((t) => off.includes(t.manifest.id))
  const close = useCallback((id: string) => {
    setPane((p) => (p === id ? null : p))
    setOff((o) => [...o, id])
  }, [])
  const paneTile = on.find((t) => t.manifest.id === pane)

  return (
    <div className="app">
      <aside className="col sessions">
        <div className="col-title">Sessions</div>
        <p className="empty">Sessions arrive with the core extraction (roadmap step 3).</p>
      </aside>

      <main className="col center">
        {paneTile ? (
          <section className="pane">
            <header className="head">
              <Icon tile={paneTile} />
              <span className="name">{heads[paneTile.manifest.id]?.title || paneTile.manifest.name}</span>
              <button className="ghost" title="Back to the column (Esc)" onClick={() => setPane(null)}>
                ×
              </button>
            </header>
            <div className="face pane-face" data-pane={paneTile.manifest.id} />
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
          {on.map((t) => {
            const id = t.manifest.id
            const head = heads[id]
            return (
              <article key={id} className={`tile ${pane === id ? 'in-pane' : ''}`}>
                <header className="head">
                  <Icon tile={t} />
                  <span className="name" title={t.manifest.hint}>
                    {head?.title || t.manifest.name}
                  </span>
                  {head?.badge && <span className="badge">{head.badge}</span>}
                  {chips[id] && <span className="chip" title={chips[id]}>{chips[id]}</span>}
                  {t.source === 'dev' && <span className="dev">dev</span>}
                  {t.manifest.pane && (
                    <button className="ghost" title="Open large" onClick={() => setPane(pane === id ? null : id)}>
                      ⤢
                    </button>
                  )}
                  <button className="ghost" title="Turn off" onClick={() => close(id)}>
                    ×
                  </button>
                </header>
                <div className="face" data-face={id} style={{ height: t.manifest.span * 190 }}>
                  {pane === id && <span className="away">open in the center</span>}
                </div>
              </article>
            )
          })}
          {offTiles.length > 0 && (
            <div className="plus">
              {offTiles.map((t) => (
                <button key={t.manifest.id} onClick={() => setOff((o) => o.filter((x) => x !== t.manifest.id))}>
                  + {t.manifest.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <TileLayer tiles={on} pane={pane} />
    </div>
  )
}

function Icon({ tile }: { tile: TileInfo }) {
  return tile.icon ? <img className="icon" src={tile.icon} alt="" /> : <span className="icon letter">{tile.manifest.name[0]}</span>
}
