// The wolfpack as the window sees it: one subscription to main's agents state (main/agents.ts,
// main/helpers.ts), read by each session's pack tile.

import { useSyncExternalStore } from 'react'
import type { AgentsState } from '@shared/agents'

const EMPTY: AgentsState = { agents: [], leash: false }
let state: AgentsState = EMPTY
const subs = new Set<() => void>()
let started = false

function start(): void {
  if (started) return
  started = true
  const set = (s: AgentsState): void => {
    state = s
    for (const f of subs) f()
  }
  window.core.agents.onChange(set)
  void window.core.agents.get().then(set, () => undefined)
}

export function useAgents(): AgentsState {
  return useSyncExternalStore(
    (f) => {
      start()
      subs.add(f)
      return () => void subs.delete(f)
    },
    () => state
  )
}
