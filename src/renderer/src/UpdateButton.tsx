// The top bar's "Install update" (main/updates.ts, carried from deck's UpdateButton). It shows only
// in the packaged app, and only when the repo it was built from has changed since. A click builds
// the repo (`npm run dist`), swaps the new app in over this one and relaunches it; sessions live in
// tmux and carry on, and the new app picks them up again.

import { useEffect, useState } from 'react'
import type { AppUpdate } from '@shared/update'

const when = (ms: number): string => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function UpdateButton() {
  const [u, setU] = useState<AppUpdate>({ state: 'none' })
  useEffect(() => {
    let live = true
    void window.core.update.state().then((x) => live && setU(x))
    const off = window.core.update.onState(setU)
    return () => {
      live = false
      off()
    }
  }, [])
  if (u.state === 'none') return null
  const busy = u.state === 'building' || u.state === 'installing'
  const title =
    u.state === 'available'
      ? `${u.repo ?? 'The repo'} has changes this app does not have${u.builtAt ? ` (this one was built ${when(u.builtAt)})` : ''}. Builds it (npm run dist), installs the new app and relaunches; sessions keep running.`
      : u.state === 'building'
        ? 'Building the new app (npm run dist). The window relaunches when it is done; sessions keep running.'
        : u.state === 'installing'
          ? 'Installing and relaunching…'
          : `The update failed. Click to try again.\n\n${u.error ?? ''}`
  const label = u.state === 'building' ? 'Building…' : u.state === 'installing' ? 'Installing…' : u.state === 'error' ? 'Update failed' : 'Install update'
  return (
    <button className={`ghost small update-btn is-${u.state}`} disabled={busy} title={title} onClick={() => void window.core.update.install()}>
      <span className="update-btn-mark" aria-hidden>
        {busy ? (
          <svg viewBox="0 0 10 10" className="update-btn-spin">
            <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 9" strokeLinecap="round" />
          </svg>
        ) : u.state === 'error' ? (
          <svg viewBox="0 0 10 10">
            <path d="M5 1.2 9.2 8.6H.8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M5 4.2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10">
            <path d="M5 1v5.6M2.4 4.3 5 6.8l2.6-2.5M1.5 9h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span>{label}</span>
    </button>
  )
}
