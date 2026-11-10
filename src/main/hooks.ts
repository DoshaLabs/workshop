// What every session is started with: `claude --settings <this file>`. It MERGES with the user's
// own settings (their hooks keep firing). It adds:
//
// - hooks that POST their JSON to core (/hook/<event> on the door's server), authenticated with
//   the session's own token from the file WORKSHOP_AUTH names (`curl -H @file`: no token on any
//   command line), at the port core is on NOW (read from `port` in the profile, so a session that
//   outlived a restart still finds core). They never block Claude: two seconds, errors swallowed,
//   exit 0.
// - the status line, which is how the account's 5-hour and weekly windows reach core (usage).
//   `statusLine` is one object, so ours replaces the user's; the script posts the JSON to core and
//   then runs the user's own command on the same input, so what they see is unchanged.
// - Claude Code's theme, light or dark to match the app (deck learned that a light CLI theme
//   inside a dark app is near-white text on light grey); the user's -daltonized / -ansi is kept.
// - WORKSHOP_TILE, the door's CLI, so a tile's skill can run `node "$WORKSHOP_TILE" <id> <op>`.
// - WORKSHOP_DOC, the preview pane's CLI beside it: `node "$WORKSHOP_DOC" open <path> [--line N]`.
//
// Carried over from deck's hooks.ts, without its leash, wolfpack and tile routes.

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type HookEvent = 'Notification' | 'Stop' | 'UserPromptSubmit' | 'SubagentStart' | 'SubagentStop'

export interface HookPayload {
  session_id?: string
  hook_event_name?: string
  notification_type?: string
  cwd?: string
  transcript_path?: string
  prompt?: string
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  last_assistant_message?: string
}

/** /hook/<name> → the event it carries. `status` is the status line, not a hook. */
export const HOOK_ROUTES: Record<string, HookEvent> = {
  notification: 'Notification',
  stop: 'Stop',
  prompt: 'UserPromptSubmit',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop'
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function userSettings(): Record<string, unknown> {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The user's Claude Code theme with only light / dark switched to the app's. */
export function claudeTheme(dark: boolean, theirs: unknown): string {
  const flavour = typeof theirs === 'string' ? (/-(daltonized|ansi)$/.exec(theirs)?.[0] ?? '') : ''
  return (dark ? 'dark' : 'light') + flavour
}

export class SessionSettings {
  readonly path: string
  private readonly portFile: string
  private readonly statusScript: string
  private dark = true

  constructor(
    private readonly home: string,
    /** bin/workshop-tile.mjs, absolute. */
    private readonly tileCli: string
  ) {
    this.path = join(home, 'claude-settings.json')
    this.portFile = join(home, 'port')
    this.statusScript = join(home, 'statusline.sh')
  }

  /** Where core listens now. Sessions read it on every hook. */
  setPort(port: number): void {
    writeFileSync(this.portFile, String(port))
    this.write()
  }

  /** The app went light or dark: new sessions start with Claude Code's theme to match. */
  setDark(dark: boolean): void {
    if (this.dark === dark) return
    this.dark = dark
    this.write()
  }

  /** A hook command posting its stdin to /hook/<path>. */
  private post(path: string): string {
    return `curl -s -m 2 -X POST "http://127.0.0.1:$(cat ${sq(this.portFile)} 2>/dev/null)/hook/${path}" -H @"$WORKSHOP_AUTH" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1; exit 0`
  }

  private writeStatusScript(theirs: unknown): Record<string, unknown> {
    const t = (theirs && typeof theirs === 'object' ? theirs : {}) as { type?: string; command?: string; padding?: number }
    const own = t.type === 'command' && typeof t.command === 'string' && !t.command.includes(this.statusScript) ? t.command : ''
    const script = [
      '#!/bin/bash',
      '# Written by workshop at every launch (src/main/hooks.ts): usage for core, then your own status line.',
      'input=$(cat)',
      `printf '%s' "$input" | ${this.post('status').replace(/; exit 0$/, '')} &`,
      own ? `printf '%s' "$input" | (\n${own}\n)` : ':',
      ''
    ].join('\n')
    writeFileSync(this.statusScript, script, { mode: 0o755 })
    return { type: 'command', command: `bash ${sq(this.statusScript)}`, ...(typeof t.padding === 'number' ? { padding: t.padding } : {}) }
  }

  write(): void {
    const theirs = userSettings()
    const hook = (path: string) => [{ hooks: [{ type: 'command', command: this.post(path), timeout: 5 }] }]
    const settings = {
      theme: claudeTheme(this.dark, theirs.theme),
      statusLine: this.writeStatusScript(theirs.statusLine),
      env: { WORKSHOP_HOME: this.home, WORKSHOP_TILE: this.tileCli, WORKSHOP_DOC: join(dirname(this.tileCli), 'workshop-doc.mjs') },
      hooks: {
        Notification: hook('notification'),
        Stop: hook('stop'),
        UserPromptSubmit: hook('prompt'),
        SubagentStart: hook('subagent-start'),
        SubagentStop: hook('subagent-stop')
      }
    }
    writeFileSync(this.path, JSON.stringify(settings, null, 2))
  }
}
