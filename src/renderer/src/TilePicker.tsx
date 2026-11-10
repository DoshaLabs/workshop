// The menu behind the + at the foot of the tile column: turn on a tile that is off, open another
// instance of one that allows it, or have Claude make a new tile. It is a card IN the column, in
// the +'s place, not a popover: every tile's page is a webview laid over the window, and nothing
// core draws can sit on top of one.

import { useEffect, useRef, useState } from 'react'
import type { TileInfo } from '@shared/ipc'

export function TilePicker({ tiles, countOf, max, onAdd, onClose }: { tiles: TileInfo[]; countOf: (id: string) => number; max: number; onAdd: (t: TileInfo) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const card = useRef<HTMLElement>(null)
  // In braces on purpose: this Chromium's scrollIntoView returns a promise, and an effect that
  // returns anything but a function takes the whole window down when the menu closes.
  useEffect(() => {
    void card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  const addable = tiles.filter((t) => countOf(t.manifest.id) === 0 || (t.manifest.multiple && countOf(t.manifest.id) < max))
  const dev = tiles.filter((t) => t.source === 'dev')

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem('')
    try {
      await window.core.createTile(name, idea)
      onClose()
    } catch (err) {
      setProblem(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="picker" ref={card}>
      <header className="head">
        <span className="name">Add a tile</span>
        <button className="ghost" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="picker-body">
        {addable.length === 0 && <p className="picker-note">Every tile you have is on.</p>}
        {addable.map((t) => {
          const on = countOf(t.manifest.id) > 0
          return (
            <button key={t.manifest.id} className="picker-row" title={t.manifest.hint} onClick={() => onAdd(t)}>
              {t.icon ? <img className="icon" src={t.icon} alt="" /> : <span className="icon letter">{t.manifest.name[0]}</span>}
              <span className="picker-text">
                <b>{on ? `Another ${t.manifest.name}` : t.manifest.name}</b>
                {t.manifest.hint && <span>{t.manifest.hint}</span>}
              </span>
              {t.source === 'dev' && <span className="dev">dev</span>}
            </button>
          )
        })}

        <h3>Make one with Claude</h3>
        <p className="picker-note">Starts a session in a new folder under ~/workshop-tiles with a working starter tile. It shows up here at once and reloads as Claude writes it.</p>
        <input value={name} maxLength={40} placeholder="Name, like “Focus timer”" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <textarea value={idea} rows={3} maxLength={4000} placeholder="What should it do?" onChange={(e) => setIdea(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.metaKey && void create()} />
        {problem && <p className="picker-problem">{problem}</p>}
        <button className="primary" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? 'Starting…' : 'Start building'}
        </button>

        {dev.length > 0 && (
          <>
            <h3>Tiles you are developing</h3>
            {dev.map((t) => (
              <div key={t.manifest.id} className="picker-dev">
                <span>{t.manifest.name}</span>
                <button className="ghost" title="Stop loading it. The folder and its data are left alone." onClick={() => void window.core.forgetTile(t.manifest.id)}>
                  stop loading
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  )
}
