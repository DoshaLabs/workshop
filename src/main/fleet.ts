// Poll `claude agents --json` for the state of every live Claude session on this machine.
// This is the source of truth for busy/idle; hooks (hooks.ts) add "needs you" on top.

import { execFile } from 'node:child_process'

export interface FleetEntry {
  sessionId: string
  name?: string
  cwd?: string
  pid?: number
  kind?: string
  /** interactive sessions report `status`, background ones `state` */
  status?: string
  state?: string
}

export class Fleet {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly onUpdate: (entries: FleetEntry[]) => void,
    private readonly intervalMs = 1500
  ) {}

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (this.inFlight) return
    this.inFlight = true
    execFile(
      'claude',
      ['agents', '--json'],
      { env: this.env, encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        this.inFlight = false
        if (err) return
        try {
          const parsed = JSON.parse(stdout) as unknown
          if (Array.isArray(parsed)) this.onUpdate(parsed as FleetEntry[])
        } catch {
          /* partial output; next tick */
        }
      }
    )
  }
}
