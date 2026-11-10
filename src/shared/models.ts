// The models a new session can be started with: what `claude --model` accepts, as the chooser
// offers them. An alias tracks the latest of its line; a full id pins one. '' = no flag, so
// the CLI's own default (`model` in ~/.claude/settings.json, else the account's) applies.
// Keep this file dependency-free (main and the renderer both import it). Carried over from deck.

export interface ModelChoice {
  /** What goes after `--model`; '' for none. */
  id: string
  /** Short, for the chooser and the tile badge. */
  label: string
  /** One line for a tooltip. */
  hint: string
}

export const MODELS: readonly ModelChoice[] = [
  { id: '', label: 'Default', hint: "The CLI's own default: `model` in ~/.claude/settings.json, else your account's" },
  { id: 'fable', label: 'Fable', hint: 'The latest Fable' },
  { id: 'opus', label: 'Opus', hint: 'The latest Opus' },
  { id: 'sonnet', label: 'Sonnet', hint: 'The latest Sonnet' },
  { id: 'haiku', label: 'Haiku', hint: 'The latest Haiku' },
  { id: 'opusplan', label: 'Opus plan', hint: 'Opus while planning, Sonnet for the rest' },
  { id: 'opus[1m]', label: 'Opus 1M', hint: 'The latest Opus with the 1M-token context window' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M', hint: 'The latest Sonnet with the 1M-token context window' }
]

/** A model id typed by hand: trimmed, and only the characters an alias or id can have. */
export function cleanModel(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return /^[A-Za-z0-9._[\]:-]{1,80}$/.test(s) ? s : ''
}

/** The badge text for a model: the catalog's label, else the id without its `claude-` prefix. */
export function modelLabel(id: string): string {
  const hit = MODELS.find((m) => m.id === id)
  return hit ? hit.label : id.replace(/^claude-/, '')
}

// ---- permission modes: what `claude --permission-mode` takes, as the chooser offers them ----

export interface PermissionChoice {
  /** What goes after `--permission-mode`; '' for none (the CLI's default: ask about everything). */
  id: string
  label: string
  hint: string
  /** Turns the permission system off in part or in whole: shown with a warning tint. */
  risky?: boolean
}

export const PERMISSION_MODES: readonly PermissionChoice[] = [
  { id: '', label: 'Ask', hint: "The CLI's default: every edit and command asks first" },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through without asking; commands still ask' },
  { id: 'plan', label: 'Plan', hint: 'Read-only until you approve a plan' },
  { id: 'auto', label: 'Auto', hint: 'The CLI decides what to allow, as a careful colleague would', risky: true },
  { id: 'dontAsk', label: "Don't ask", hint: 'Anything that would ask is refused instead (for unattended runs)', risky: true },
  { id: 'bypassPermissions', label: 'Bypass', hint: 'Nothing asks. Only in a folder you can afford to lose', risky: true }
]

/**
 * A permission mode by name: the catalog's, or any word the CLI might take (one we do not list
 * yet), else '' (no flag).
 */
export function cleanPermissionMode(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z]{1,32}$/.test(v) ? v : ''
}

/** The badge text for a permission mode: the catalog's label, else the id. */
export function permissionLabel(id: string): string {
  return PERMISSION_MODES.find((m) => m.id === id)?.label ?? id
}
