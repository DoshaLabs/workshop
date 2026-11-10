// A tile's permissions in plain words, and what changed between two sets of them. The + menu
// shows the words on every row and in the install prompt; install and update compare the sets to
// decide whether the user must be asked again. CLAUDE.md §5.

import type { Permissions } from './manifest'

/** One line per permission, in the order a person would care about them: what can leave the machine first. */
export function permissionWords(p: Permissions): string[] {
  const out: string[] = []
  if (p.transcripts) out.push('read your conversations with Claude')
  if (p.net?.length) out.push(`reach ${p.net.join(', ')}`)
  if (p.camera) out.push('use the camera')
  if (p.microphone) out.push('use the microphone')
  if (p.sessions === 'write') out.push('see your sessions and type into them')
  else if (p.sessions === 'read') out.push('see your sessions (names, folders, status)')
  if (p.files) out.push('read files and folders you pick for it')
  if (p.door) out.push(`answer Claude sessions (${p.door.ops.join(', ')})`)
  if (p.usage) out.push('see your usage and costs')
  if (p.overlay) out.push('show itself over the whole window when you click it')
  if (p.notify) out.push('send you notifications')
  if (p.storage) out.push('keep its own data')
  if (p.backend) out.push('run a program with full access to this Mac')
  return out
}

/**
 * Each permission as a comparable string: a set of these is what the user agreed to. A door's
 * timeout is left out on purpose (how long core waits is not something the user is asked about);
 * its ops are in, one each, so a new op is a new thing the tile can be asked to do.
 */
export function permissionKeys(p: Permissions): string[] {
  const keys: string[] = []
  for (const k of ['storage', 'transcripts', 'usage', 'notify', 'files', 'camera', 'microphone', 'overlay', 'backend'] as const) if (p[k]) keys.push(k)
  if (p.sessions) keys.push(`sessions:${p.sessions}`)
  for (const op of p.door?.ops ?? []) keys.push(`door:${op}`)
  for (const h of p.net ?? []) keys.push(`net:${h}`)
  return keys.sort()
}

export interface PermissionChange {
  /** In plain words, what the new version may do that the old one could not. */
  added: string[]
  /** And what it no longer asks for. */
  removed: string[]
}

/** What changed from `before` to `after`, in words; both empty when nothing the user agreed to changed. */
export function permissionChange(before: Permissions, after: Permissions): PermissionChange {
  const a = new Set(permissionKeys(before))
  const b = new Set(permissionKeys(after))
  const only = (from: Set<string>, not: Set<string>): Permissions => {
    const p: Permissions = {}
    const ops: string[] = []
    const net: string[] = []
    for (const k of from) {
      if (!not.has(k)) {
        if (k.startsWith('door:')) ops.push(k.slice(5))
        else if (k.startsWith('net:')) net.push(k.slice(4))
        else if (k.startsWith('sessions:')) p.sessions = k.slice(9) as 'read' | 'write'
        else (p as Record<string, boolean>)[k] = true
      }
    }
    if (ops.length) p.door = { ops, timeoutMs: 0 }
    if (net.length) p.net = net
    return p
  }
  return { added: permissionWords(only(b, a)), removed: permissionWords(only(a, b)) }
}

/** Whether going from `before` to `after` needs the user's yes again: only if something was added. */
export const needsAsking = (before: Permissions, after: Permissions): boolean => permissionChange(before, after).added.length > 0
