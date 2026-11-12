// The file viewer's rules (main/viewer.ts serves, renderer/src/FileViewer.tsx draws): which files
// are shown in the lightbox rather than the preview pane, and how a file with no telling name is
// recognised. Pure, so test/viewer.test.ts checks it on its own.
//
// Text and markdown stay in the preview pane, where they can be edited. What a person reads but
// cannot edit as text (a picture, a PDF, a web page, a film, a sound) opens in the lightbox. A
// binary that is none of these is never drawn: the viewer says so and offers its Mac app.

export type ViewKind = 'image' | 'pdf' | 'html' | 'video' | 'audio'

/** The scheme the viewer's files are served on: `view://<grant>/<name>`, each grant its own origin. */
export const VIEW_SCHEME = 'view'

const EXT: Record<string, [ViewKind, string]> = {
  png: ['image', 'image/png'],
  apng: ['image', 'image/apng'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  jfif: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  pdf: ['pdf', 'application/pdf'],
  html: ['html', 'text/html'],
  htm: ['html', 'text/html'],
  xhtml: ['html', 'application/xhtml+xml'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  wav: ['audio', 'audio/wav'],
  flac: ['audio', 'audio/flac'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg']
}

const extOf = (name: string): string => {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** What the viewer makes of a file by its name, or null (text for the pane, or unknown). */
export function viewKindOf(name: string): ViewKind | null {
  return EXT[extOf(name)]?.[0] ?? null
}

/** The type to serve a file as: by its name, else by what its first bytes said (`sniffed`). */
export function mimeOf(name: string, sniffed?: ViewKind | null): string {
  const byName = EXT[extOf(name)]
  if (byName) return byName[1]
  if (sniffed === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

/** A file whose name says nothing, recognised by its first bytes: the formats a session writes most. */
export function sniffKind(head: Uint8Array): { kind: ViewKind; mime: string } | null {
  const at = (i: number, ...b: number[]): boolean => b.every((x, j) => head[i + j] === x)
  const ascii = (i: number, s: string): boolean => at(i, ...[...s].map((c) => c.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', mime: 'image/gif' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' }
  if (ascii(0, '%PDF-')) return { kind: 'pdf', mime: 'application/pdf' }
  return null
}

/**
 * Whether a web page at `file` may load the files in its folder (Colin, 12 Nov 2026): only when it
 * is at or below an open session's start folder or project root. Elsewhere (Downloads, the Desktop)
 * it gets the page alone, so a stranger's page cannot read its neighbours and send them out. A
 * session started in the home folder or at `/` makes nothing a project. All paths real (symlinks resolved).
 */
export function pageGetsFolder(file: string, folders: string[], home: string): boolean {
  const dir = file.replace(/\/[^/]*$/, '') || '/'
  if (dir === '/' || dir === home) return false
  return folders.some((f) => {
    const root = f.replace(/\/+$/, '')
    if (!root || root === home) return false
    return dir === root || dir.startsWith(root + '/')
  })
}

/** What the window gets for a file it asked to view. */
export type ViewDoc =
  | { path: string; name: string; kind: ViewKind; url: string; size: number }
  | { path: string; name: string; kind: 'refused'; note: string; missing?: boolean }
