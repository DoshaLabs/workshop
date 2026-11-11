// The door as MCP tools (phase 3 item 5 of docs/progress/2026-11-11-codex.md): how a Codex session
// reaches tiles, since Codex has no --plugin-dir. Core lists, for the session's MCP server
// (bin/workshop-mcp.mjs, started by the session's app-server), one tool per installed tile with
// door ops, whose description is the tile's own skills (the words a Claude session reads), plus
// `doc` for the preview pane. A call goes through the door's own route (/tile/<id>), so every
// check the door makes (declared ops, the tile on, the caller from the token) holds as for the CLI.
// Pure, tested in test/door-tools.test.ts.

/** A tool as MCP's tools/list gives it, plus what the server needs to route a call. */
export interface DoorTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** The tile it calls (POST /tile/<id>); absent: core's own `doc`. */
  tile?: string
}

/** A tile, as far as its tool needs it. */
export interface DoorTile {
  id: string
  name: string
  hint: string
  ops: string[]
  /** Its plugin's skills: the frontmatter's description and the body. */
  skills: { name: string; description: string; body: string }[]
}

/** A description's cap: a tile's skills can be long, and every tool's words go into each turn. */
export const DESCRIPTION_MAX = 6000

/** MCP tool names are [a-zA-Z0-9_-], 1–64; tile ids already are ([a-z0-9-], at most 40). */
export function toolName(tileId: string): string {
  return tileId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** A SKILL.md split into its frontmatter's name and description, and its body. */
export function parseSkill(text: string, fallbackName: string): { name: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { name: fallbackName, description: '', body: text.trim() }
  const field = (k: string): string => {
    const f = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1])
    return (f?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return { name: field('name') || fallbackName, description: field('description'), body: m[2].trim() }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** The tool for one tile, or null when it has no door ops (nothing a session can call). */
export function tileTool(t: DoorTile): DoorTool | null {
  if (!t.ops.length) return null
  const head = [
    `The workshop's ${t.name} tile${t.hint ? `: ${t.hint}` : ''}.`,
    `Call with { "op": one of ${t.ops.map((o) => `"${o}"`).join(', ')}, "args": [strings] }.`,
    `Where the instructions below say to run \`node "$WORKSHOP_TILE" ${t.id} <op> [args…]\`, call this tool with that op and those args instead (each argument one string, as the shell would split them). The tile must be on in the workshop's right-hand column; if it is off, the answer says so: tell the user.`
  ].join(' ')
  const skills = t.skills.map((s) => [s.description, s.body].filter(Boolean).join('\n\n')).filter(Boolean)
  return {
    name: toolName(t.id),
    description: clip([head, ...skills].join('\n\n'), DESCRIPTION_MAX),
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...t.ops], description: 'The operation.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Its arguments, as the command line would pass them.' }
      },
      required: ['op'],
      additionalProperties: false
    },
    tile: t.id
  }
}

/** The preview pane's `doc` (the skill workshop:doc), as a tool. */
export const DOC_TOOL: DoorTool = {
  name: 'doc',
  description:
    "Open a file in workshop's preview pane, the center column, where markdown renders, `- [ ]` task boxes are clickable and save to disk, and an edit toggle makes any text file editable in place. Use INSTEAD OF macOS `open` whenever the user should read, tick off or edit a file: \"open the checklist\", \"show me the notes\", \"let me edit that\", or after you write a plan, checklist or notes file they will work through.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file: absolute, or relative to the session\'s folder.' },
      line: { type: 'integer', minimum: 1, description: 'A line to show.' }
    },
    required: ['path'],
    additionalProperties: false
  }
}

/** Every tool a session's MCP server offers: the tiles' (by id), then `doc`. Names never repeat. */
export function doorTools(tiles: DoorTile[]): DoorTool[] {
  const out: DoorTool[] = []
  const seen = new Set<string>([DOC_TOOL.name])
  for (const t of [...tiles].sort((a, b) => a.id.localeCompare(b.id))) {
    const tool = tileTool(t)
    if (!tool || seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }
  return [...out, DOC_TOOL]
}
