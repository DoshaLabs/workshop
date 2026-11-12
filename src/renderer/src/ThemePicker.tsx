// The theme picker: a button in the top bar that opens a list of the catalog's families, each
// with its swatch, and the appearance (follow macOS, light, dark). The choice is saved by main
// and reaches every tile at once.

import { useEffect, useRef, useState } from 'react'
import type { ThemeState } from '@shared/ipc'
import { THEMES, forcesDark, type Appearance } from '@shared/themes'

const APPEARANCES: [Appearance, string][] = [
  ['system', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark']
]

export function ThemePicker({ theme }: { theme: ThemeState }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const current = THEMES.find((t) => t.id === theme.theme)
  return (
    <div className="theme-picker" ref={box}>
      <button className="ghost small" onClick={() => setOpen(!open)} title="Theme">
        {current?.name ?? 'Theme'}
      </button>
      {open && (
        <div className="popover" role="menu">
          {forcesDark(theme.theme) ? (
            <div className="appearance-note">{current?.name} is always dark</div>
          ) : (
            <div className="segmented" role="group" aria-label="Appearance">
              {APPEARANCES.map(([a, label]) => (
                <button key={a} className={theme.appearance === a ? 'on' : ''} onClick={() => void window.core.setSettings({ appearance: a })}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {THEMES.map((t) => {
            const v = theme.dark ? t.dark : t.light
            return (
              <button key={t.id} role="menuitemradio" aria-checked={t.id === theme.theme} className={`theme-row ${t.id === theme.theme ? 'on' : ''}`} onClick={() => void window.core.setSettings({ theme: t.id })}>
                <span className="swatch" style={{ background: v.panel, borderColor: v.line }}>
                  <i style={{ background: v.accent }} />
                  <i style={{ background: v.ink }} />
                  <i style={{ background: v.busy }} />
                </span>
                {t.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
