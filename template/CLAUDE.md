# A workshop tile

This folder is a **tile**: a small app in the right-hand column of workshop (a desktop app for
Claude Code sessions). A tile is a web page plus a manifest. It runs in a sandbox: no node, no
file system, no network, nothing but what `tile.json` declares, and all of it through one object,
`window.workshop`.

**The loop.** Workshop is showing this folder as a tile now (marked `dev`). Save a file under
`dist/` and the page reloads; save `tile.json` and the whole tile loads again. If `tile.json` is
refused the tile leaves the column, and the reason is listed in workshop's center pane under
"Tiles that were refused" (press `+` at the top of the sessions column to see it). You cannot see
the tile yourself: say what you changed and ask the user to look.

## The folder

```
tile.json          the manifest
dist/index.html    the page (dist/tile.js, dist/tile.css beside it)
icon.svg           16 x 16, drawn in the tile's head
plugin/            optional: skills that teach a Claude session to use the tile (below)
```

Plain HTML, CSS and JavaScript modules, no build step, is the simplest thing that works and what
workshop's own tiles do. If you use a framework, the BUILT page must be in `dist/` and committed:
nothing is ever built on the user's machine.

## tile.json

```json
{
  "id": "my-tile",              lowercase letters, digits, dashes; never change it once it has data
  "name": "My tile",
  "version": "0.1.0",
  "workshop": "^1",
  "author": "you",
  "hint": "One line shown as a tooltip",
  "icon": "icon.svg",
  "entry": "dist/index.html",
  "pane": false,                true: the tile can open large in the center column
  "multiple": false,            true: up to four instances at once
  "span": 1,                    height in the column, 1 to 4 (each about 190 px)
  "permissions": { }
}
```

An unknown key under `permissions` is an error, not a warning. Ask for the least you need: the
user is shown the list.

| Permission | Gives |
|---|---|
| `"storage": true` | `workshop.storage` |
| `"net": ["api.example.com", "*.example.org"]` | https / wss to exactly these hosts. No IPs, no `localhost`, no bare `*`. `*.x.com` does not include `x.com`. |
| `"sessions": "read"` or `"write"` | `workshop.sessions` (`write` adds `paste`) |
| `"usage": true` | `workshop.usage` |
| `"notify": true` | `workshop.notify` |
| `"door": { "ops": ["add", "list"], "timeoutMs": 10000 }` | `workshop.door`: Claude sessions can call these ops |
| `"files": true` | `workshop.files`: read what the user picks, nothing else |
| `"camera": true`, `"microphone": true` | `navigator.mediaDevices.getUserMedia` |
| `"overlay": true` | `workshop.openOverlay()`: the page over the whole window, e.g. a lightbox. Needs `"workshop": "^1.1"` |

There is no permission for running programs, writing files, or reading a path the user did not
pick. If the tile needs one of those, say so plainly instead of working around it.

## window.workshop

Always there:

```js
workshop.id, workshop.instance
workshop.view                        // 'tile' | 'pane' | 'overlay'
workshop.onViewChange((view) => {})  // returns a function that stops listening
workshop.theme.vars                  // { '--ws-bg': '#…', … }; already applied to :root as CSS variables
workshop.theme.onChange((vars) => {})
await workshop.head.set({ title, badge })   // the tile's head is drawn by workshop; title ≤ 60, badge ≤ 12 chars
await workshop.openPane(); await workshop.closePane()   // needs "pane": true
await workshop.openExternal('https://…')    // the user's browser; one a second
```

The overlay (needs `"overlay": true`):

```js
await workshop.openOverlay()   // rejects unless the user clicked or typed in this page in the last 5 s
await workshop.closeOverlay()
```

The same page, not a new one, is laid over the whole window, below a strip workshop draws with the
tile's name and a ×; `workshop.view` becomes `'overlay'`. Draw your own backdrop: the page is
transparent, so a `color-mix(in srgb, var(--ws-bg) 70%, transparent)` background is what dims
the window behind it (`backdrop-filter` cannot blur what is outside the page). Esc always closes
it and your page never receives that Esc. One click opens it once: reopening needs a new click.
It goes back to the view it came from (`tile` or `pane`).

Behind a permission (each call rejects with a clear message if the permission is missing):

```js
await workshop.storage.get(key)             // any JSON value, or null
await workshop.storage.set(key, value)      // null removes it. 5 MB for the whole tile.
workshop.storage.watch(key, (value) => {})  // also fires for your own writes

await workshop.sessions.list()              // [{ id, name, project, status, focused, open }]
workshop.sessions.watch((list) => {})
await workshop.sessions.paste(id, text)     // "write" only: types into a session and submits

await workshop.usage.get(); workshop.usage.watch((u) => {})   // rate-limit windows, per-session cost and context %

await workshop.notify({ text })             // a chip on the tile's head and a macOS notification; one per 3 s

workshop.door.handle('add', async (args, caller, { session }) => result)
// args: string[] exactly as typed. caller: the session's name, or 'outside'.
// session: the caller's id as workshop.sessions lists it, or null. Return JSON; throw to refuse.

const picked = await workshop.files.pick({ folder: true, title: 'Your games' })  // { handle, name, kind } or null
await workshop.files.list()                 // what was picked before (kept across restarts)
await workshop.files.entries(handle, 'sub/folder')   // [{ name, kind, size }]
await workshop.files.read(handle, 'a/b.txt', 'text') // or 'bytes'
workshop.files.url(handle, 'a/b.png')       // for <img>, <audio>, fetch (streamed)
await workshop.files.forget(handle)
```

Web storage (`localStorage`, IndexedDB) works and is the tile's own, but `workshop.storage` is
what survives a reinstall and is shared between instances. Keep real data there.

## Rules of the sandbox

- **The network is closed.** A host must be in `permissions.net` AND in the page's
  Content-Security-Policy (`connect-src` for fetch, `img-src` for images) in `dist/index.html`.
- Keep the CSP strict: no inline scripts or styles. Build DOM nodes; never put text from the
  network or from a session into `innerHTML`.
- Links and popups open in the user's browser. The page cannot navigate away from itself.
- Use the `--ws-*` variables for every colour so the tile follows the user's theme, light or dark.
- A tile is small: the column is about a third of the window. Design for 400 px wide first, and
  give `pane` view more room if `"pane": true`.

## Letting Claude sessions use the tile (the door)

Declare ops in `permissions.door.ops`, answer them with `workshop.door.handle`, and a session
calls one from the shell:

```bash
node "$WORKSHOP_TILE" <tile-id> <op> [args…]    # prints the result as JSON; exit 1 on a refusal
```

`$WORKSHOP_TILE` is set in every session workshop starts, including this one, so you can test
your own ops. The tile must be on. To teach sessions when to use it, add a skill:

```
plugin/.claude-plugin/plugin.json     { "name": "<the tile's id>", "description": "…", "version": "0.1.0" }
plugin/skills/<skill>/SKILL.md        frontmatter (name, description), then the commands
```

Only skills are accepted there (no hooks, MCP servers, agents or commands). A session that was
already running does not see a skill added later; a new session does.

## When you are done

Tell the user what the tile does, which permissions it asks for and why, and anything it could not
do inside the sandbox.
