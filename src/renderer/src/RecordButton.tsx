// The top bar's screen recorder button (main/recorder.ts). It opens the 9:16 frame, and while a take
// runs it is a red dot and the time filmed so far, so you can see you are recording from anywhere
// in the window. A click while the frame is up does what ⌘⇧O does: stop the take, else close it.

import { useEffect, useState } from 'react'
import { clock, type RecState } from '@shared/recorder'

const TITLE = "Screen recorder: a 9:16 frame for Reels / Stories you drag anywhere, with the Mac's sound (⌘⇧O)"

export function RecordButton() {
  const [st, setSt] = useState<RecState>({ open: false, phase: 'idle', since: 0 })
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    void window.core.recorder.state().then(setSt)
    return window.core.recorder.onState(setSt)
  }, [])
  const live = st.phase === 'recording'
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [live])

  const label = live ? clock(now - st.since) : st.phase === 'countdown' ? 'Ready…' : st.phase === 'saving' ? 'Saving…' : 'Record'
  const title = live ? `Recording: click or ⌘⇧O to stop and save` : st.open ? 'The recorder is open: click or ⌘⇧O to close it' : TITLE
  return (
    <button
      className={`ghost small rec-btn ${st.open ? 'is-open' : ''} ${live ? 'is-live' : ''}`}
      data-phase={st.phase}
      title={title}
      aria-label={live ? `Recording, ${label}` : 'Screen recorder'}
      onClick={() => void window.core.recorder.toggle()}
    >
      <span className="rec-btn-dot" aria-hidden />
      <span className="rec-btn-label">{label}</span>
    </button>
  )
}
