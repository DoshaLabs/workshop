// The conversations main tails (main/transcript.ts), as the window sees them: one subscription
// for the whole window, each session tile reading its own. A session's transcript is fetched once
// when its tile first shows, then kept current by main's pushes.

import { useSyncExternalStore } from 'react'
import type { Transcript } from '@shared/transcript'

const byId = new Map<string, Transcript>()
const subs = new Set<() => void>()
const asked = new Set<string>()
let started = false

function changed(): void {
  for (const f of subs) f()
}

function start(): void {
  if (started) return
  started = true
  window.core.onTranscript((t) => {
    byId.set(t.id, t)
    changed()
  })
}

function ask(id: string): void {
  if (asked.has(id)) return
  asked.add(id)
  void window.core
    .transcript(id)
    .then((t) => {
      // A push may have come first; it is at least as new.
      if (t && !byId.has(id)) {
        byId.set(id, t)
        changed()
      }
    })
    .catch(() => asked.delete(id))
}

export function useTranscript(id: string): Transcript | null {
  return useSyncExternalStore(
    (f) => {
      start()
      ask(id)
      subs.add(f)
      return () => void subs.delete(f)
    },
    () => byId.get(id) ?? null
  )
}
