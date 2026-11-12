// The top bar's "Dev mode" (main/devmode.ts). Shown only in an app built from a checkout. On, this
// window is built from that repo and reloads on every save; core itself stays the installed one.

import { useEffect, useState } from 'react'
import type { DevMode } from '@shared/update'

export function DevModeButton() {
  const [d, setD] = useState<DevMode>({ state: 'unavailable' })
  useEffect(() => {
    let live = true
    void window.core.devMode.state().then((x) => live && setD(x))
    const off = window.core.devMode.onState(setD)
    return () => {
      live = false
      off()
    }
  }, [])
  if (d.state === 'unavailable') return null
  const on = d.state === 'on' || d.state === 'starting'
  const broken = d.state === 'error' || (d.state === 'on' && !!d.error)
  const title =
    d.state === 'off'
      ? `Build this window from ${d.repo ?? 'the repo'} and reload it on every save. Core itself (sessions, hooks, tiles' backends) stays this installed one: a change there still needs Install update.`
      : d.state === 'starting'
        ? 'Building the window from the repo…'
        : d.state === 'on'
          ? d.error
            ? `The last save did not build; the window is the last one that did.\n\n${d.error}`
            : `This window is ${d.repo ?? 'the repo'}'s, rebuilt on every save. Click to go back to the installed window.`
          : `Dev mode stopped. Click to try again.\n\n${d.error ?? ''}`
  return (
    <button
      className={`ghost small dev-btn is-${d.state}${broken ? ' is-broken' : ''}`}
      aria-pressed={on}
      title={title}
      onClick={() => void window.core.devMode.set(!on)}
    >
      <span className="dev-btn-dot" aria-hidden />
      <span>{d.state === 'starting' ? 'Dev mode…' : 'Dev mode'}</span>
    </button>
  )
}
