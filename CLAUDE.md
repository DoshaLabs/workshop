# workshop

A desktop app for people who use Claude Code: several Claude Code sessions in one window, and a
column of small apps ("tiles") beside them that anyone can write, share and install. Open source,
in the DoshaLabs GitHub org. macOS and Claude Code first.

**Status (10 Nov 2026): the tile host (roadmap step 1), sessions, the status mark (section 8), the three-tab
`+` menu with install, the preview pane and the trusted tier are built; the rest of this
file is still the plan.** Every section says what was decided and why, so that whoever starts building, person or
Claude session, does not have to re-derive it. When code lands, rewrite the matching section to
describe what exists and delete the plan wording.

**What exists.** `npm run dev` · `npm test` (unit) · `npm run smoke` (launches the app with a
throwaway profile and `test/fixtures/probe`, a tile that tries every way out of the sandbox, and
drives the door, and ends by restarting core on the same profile, so sessions are seen to survive a restart
and a reboot; must print 0 failed; `WORKSHOP_SHOT=x.png` also saves a picture of the window).
Smoke sessions run a stand-in `claude` (`test/fixtures/fake-claude/claude`) that runs our hooks the
way the CLI does; `WORKSHOP_REAL_CLAUDE=1 npx electron . --smoke` runs one real Haiku turn instead.
The first build session's notes, open issues and second-pass list: `docs/progress/2026-11-10.md`.

- `src/shared/manifest.ts`: the tile.json validator and the per-request network rule. Unknown
  permissions are refused, `backend` is refused, `net` is https/wss to listed hosts only.
- `src/main/tiles.ts`: finds tiles (`--dev-tile=<folder>`, then `tiles/`, then userData `tiles/`;
  an installed tile can never take a core tile's id), and arms each one's session: files on
  `tile://<id>/` (only the entry's folder), requests filtered, a dead proxy for everything
  undeclared (closes WebRTC; DNS prefetch is off in tile pages, because it goes around the proxy;
  both checked against core's window in smoke), media only if declared, no downloads or screen
  capture.
- `src/main/index.ts`: guards every webview (core's sandboxed preload only) and answers the bridge,
  checking the sender's webview, top frame and origin on every call.
- `src/preload/tile.ts`: `window.workshop`. Built separately (`vite.tile-preload.config.ts`)
  because a sandboxed preload must be one file. contextBridge copies getters once, so live values
  cross as functions and are rebuilt into properties with `executeInMainWorld`.
- `src/main/storage.ts`, `src/main/door.ts`, `bin/workshop-tile.mjs`: storage (5 MB, atomic) and
  the door (127.0.0.1, bearer token, caller from the token, browser `Origin` refused).
- `tiles/wikipedia/`: deck's Wikipedia tile ported onto the contract, plain JS with no build
  step: the picture of the day full bleed (cycling every 2 minutes, today's then two from the
  archive), a clock and the weather (Open-Meteo; asks for a city on first run, places kept in
  `workshop.storage`) top left, search and an in-tile article over the picture. A click opens it as
  a pane, which shows the picture whole. Rules in `dist/wiki.js`, tested as shipped.
- `tiles/reminders/`: deck's Reminders ported onto the contract (storage, sessions read, door,
  notify): to-dos, notes and a log by project. Its rules are `dist/model.js` (tested as shipped by
  `test/reminders.test.ts`), its page `dist/tile.js`. It lives here until the index exists, then
  moves to its own repo (section 3). What the port changed in core and what it could not do:
  `docs/progress/2026-11-10.md` section 8.
- Layout: three equal columns, as in deck. The tile column is four rows tall: a tile is one row
  (its manifest's `span`, 1 for every core tile) and ↕ on its head steps it taller.
- The `+` is the tile column's last cell (`TilePicker.tsx`), a card in three tabs. Built in:
  `tiles/`. Yours: dev folders, "make one with Claude" (copies `template/` to
  `~/workshop-tiles/<id>`, `src/main/scaffold.ts`, loads it as a dev tile, starts a session
  there), "load a folder", stop loading. Marketplace: installed tiles (update, remove with or
  without their data), the index's tiles, install from a git repo. Every row: icon, name, hint,
  permissions in words (`src/shared/permissions.ts`), on or off. `template/CLAUDE.md` is the tile
  contract written for the Claude that builds the tile. Dev tile folders are remembered in
  settings (`devTiles`) and loaded at every start.
- Install (`src/main/install.ts`, wired by `src/main/tile-menu.ts`): one pinned commit fetched with
  hooks, submodules, LFS and symlinks off, `.git` deleted, checked as an outside tile (no backend,
  no built-in id, nothing the index did not list), into userData `tiles/<id>` after the prompt in
  the menu card. An update asks again only if it asks for more. The index format is
  `src/shared/tile-index.ts`; its address is `settings.index` (or `WORKSHOP_INDEX`).
- `workshop tile check <folder> [--json]` (`src/main/tile-check.ts`, built into
  `out/check/tile-check.mjs` by `vite.check.config.ts`): core's own manifest, plugin and folder
  checks from the shell. Exit 0 if the tile would load.
- `bin/workshop.mjs tile dev <folder>`: loads a tile under development (reload on change, or a
  dev-server `entry`); hands the folder to the app if it is already running.
- Fonts (`src/shared/fonts.ts`, files and licences in `assets/fonts/`, all OFL): Nunito for the
  interface, JetBrains Mono for terminals and code, Source Serif 4 for prose that is read. Tiles
  get them as `--ws-font`, `--ws-font-mono`, `--ws-font-serif`; the bridge loads the faces from
  `tile://<id>/~fonts/`, so a tile's CSP needs `font-src 'self'`. Latin subsets only.
- Themes: deck's whole catalog (`src/shared/themes.ts`), saved by main (`src/main/settings.ts`),
  picked from the top bar, pushed to every tile as `--ws-*`. Deep Space's sky is
  `src/renderer/src/cosmos.ts`. Glass is solid until its picture wall comes over from deck.
- Sessions (`src/main/core-sessions.ts` wires them): `sessions.ts` (tmux + node-pty, park /
  resume / kill), `hooks.ts` (the `--settings` file), `fleet.ts`, `usage.ts`, `tmux.ts`, `env.ts`,
  carried from deck without slots, cap or wolfpack. In the window: `SessionColumn.tsx`,
  `Sessions.tsx` (launcher, focus pane) and `terminals.ts`. Differences from deck: hooks go through the door's
  server with a per-session token kept in a 0600 file named by `WORKSHOP_AUTH` (never on a
  command line, where `ps` shows it), so core knows which session called (the door's `caller`
  is the session's name) and a hook naming another session's id is ignored; hooks read core's
  port from `<profile>/port`, so a session that outlived a restart still finds core. Profiles:
  `workshop` (userData `workshop`), `workshop-dev` under `npm run dev` (its own socket and folder).
- Bridge: `sessions.list/watch/paste` (no titles: they quote the conversation) and
  `usage.get/watch` (the two windows, and per session context % and cost, from the status line).
- Overlay (bridge 1.1, `permissions.overlay`): `openOverlay()` lays the tile's own webview over
  the window below a strip core draws (`App.tsx`, `TileLayer.tsx`). Main opens it only after real
  input in that page (`input-event` / `before-input-event`, used up per open) and takes Esc from
  every webContents before the page sees it (`index.ts` `escClosesOverlay`). Wikipedia's picture
  lightbox uses it.
- The trusted tier (bridge 1.2, `docs/progress/2026-11-10-track-b.md`): a built-in tile (only
  `tiles/`) may declare `"backend": { "entry": "backend.mjs", "ops": [...], "timeoutMs"? }`.
  `src/main/backend.ts` runs one utility process per such tile while it is on (turned off or
  quit stops it; restarts after 1, 3, 10 s, then gives up and tells the page), from
  `backend-host.ts`, which hands the tile's default export `{ handle, sessions, onSessions }`.
  The wire is `backend-protocol.ts`. The page calls `workshop.backend.call(op, body)` (JSON);
  core refuses undeclared ops. The backend gets an allowlisted env (PATH, HOME, SSH_AUTH_SOCK…,
  never WORKSHOP_*), the sessions as `{ id, name, folder, root }`, no token; its output goes to
  `<profile>/logs/backend-<id>.log`. Smoke loads `test/fixtures/trusted` as built in.
- Session tiles (phase 1, `docs/progress/2026-11-10-phase1.md`): the left column is a column of
  tiles, one per open session, each its live conversation (`ChatView.tsx`; prose as markdown in
  the serif face, parsed to a tree by `src/shared/markdown.ts`, never HTML), with ⌘n, the status
  dot, Claude's title, model, context % and cost on its head and a prompt bar at its foot. Main
  tails each open session's transcript (`src/main/transcript.ts`, parser in
  `src/shared/transcript.ts`), finding `<session id>.jsonl` under the CLI's config folder by
  name. The focused session's terminal is in the center and its tile gives way to a line; parked
  sessions are a Closed card at the foot. A render error stays in its piece (`Guard.tsx`).
- Usage: the top bar's 5-hour and weekly meters are always there (a dash and a tooltip until a
  session reports); each session shows its context % and cost.
- Shortcuts (`src/shared/shortcuts.ts`): ⌘1–9 (sessions in the order they were started), ⌘[ ⌘],
  ⌘N. Main catches them in `before-input-event` on core's window and every tile's page.
- The tile column's state (off, extra instances, heights) is `settings.column` in core's
  settings (`src/shared/column.ts`), migrated once from the window's old localStorage.
- The status mark (section 8): the Knot (`src/shared/knot.ts`, `Knot.tsx`) on every session and
  at the top left; sprite packs over it (`src/shared/mascot.ts`, `src/main/mascot.ts`,
  `Mascot.tsx`, `MascotSetup.tsx`, `mascot-store.ts`); `notify({ attention: true })` flares or leaps it.
  Smoke: `WORKSHOP_SHOT_MASCOT=<dir>` saves pictures, `WORKSHOP_SMOKE_SHEET=<png>` tries a sheet
  in the setup screen (throwaway profile only), `WORKSHOP_MEASURE_CPU=1` prints renderer CPU.
- Preview pane (`PreviewPane.tsx`, `preview-store.ts`, `src/main/preview.ts`): a file a session
  points at, in the center. Markdown through the tree with live task boxes (one character
  written), code and text in mono with line numbers, `edit` and ⌘S; writes locked to the mtime
  read; the file watched and reloaded unless there are unsaved edits; folders, binaries and
  files over 2 MB refused with a note. Opened by a click on a path in a conversation
  (`src/shared/paths.ts`) or `node "$WORKSHOP_DOC" open <path> [--line N]`
  (`bin/workshop-doc.mjs`, POST /core/doc with the session's token; skill `workshop:doc` in core's
  own `plugin/`).
- Drag to reorder (`reorder.ts`, `src/shared/order.ts`): ⠿ on every head, both columns; orders in
  `settings.column` (`order`, `sessions`). A dragged session column keeps its order and ⌘1–9
  follow it; "most recent first" goes back. Tile pages let the pointer through during a drag.
- Pictures in a prompt bar: paste or drop, a chip with a thumbnail, sent as a path
  (`src/main/drops.ts`, `<profile>/drops/`).
- A session's project root (`src/main/project.ts`): resolved once through `git rev-parse
  --git-common-dir`, so worktrees of one repo share it; `workshop.sessions` gives it as `root`
  beside `project` (the start folder). A store that cannot be parsed is moved aside
  (`store.json.broken-<time>`), never written over. Long transcripts are read from the end.
- Not yet: `transcripts` for tiles, subagent tiles and the wolfpack, the leash
  and permission prompts in a tile.

Terms used throughout:

- **Core**: the app itself, this repo.
- **Tile**: a small app in a cell of the right-hand column. A web page plus a manifest.
- **Pane**: a tile opened large in the center column.
- **Door**: the way a Claude session calls a tile (one HTTP route, one CLI).
- **Bridge**: the `window.workshop` object a tile's page uses to talk to core.
- **deck**: Colin's private, personal app that workshop is extracted from (`~/deck`,
  `cgrilson7/deck`). It is the reference implementation for most of core. It is NOT this repo.

---

## 1. Ground rules

These were decided in the planning conversation and are not open for re-litigation without Colin.

1. **Separate repo.** workshop is its own repo with a fresh history. Never build workshop inside
   `~/deck`, and never push deck's history here. Code is carried over file by file, reviewed on
   the way (deck's history and tree hold personal tiles, keys in config paths, a GPL emulator and
   an art asset we may not redistribute).
2. **Open-source project, not a business.** MIT for core. No paid tier is planned. If money ever
   enters, the model is the host's (featured slots, a supporter tier), never per-tile sales.
3. **macOS and Claude Code first.** Say so in the README. Other platforms and other agent CLIs
   are welcome contributions, not launch scope.
4. **The CLI is never wrapped, forked or patched.** A session is the unchanged `claude` binary in
   a real terminal. Everything workshop adds goes through Claude Code's own extension points
   (section 9). Workshop never reads, copies or proxies the CLI's credentials.
5. **Stay on Electron and TypeScript. Not Rust.** Tiles are web pages and contributors write
   TypeScript; Electron's per-webview process isolation IS the tile sandbox. A Tauri rewrite
   would cost months and buy a smaller binary. Revisit only if memory use becomes the main
   complaint.
6. **Only truly open assets in the repo.** Art, sound and fonts committed here must be CC0, or
   owned by DoshaLabs, or under a licence that explicitly allows redistribution in source form
   (OFL fonts are fine). "Free to use" is not enough (section 8 has the case that taught us).
7. **No games, ROMs, discs or BIOS files, ever**, in this repo, the index, or any tile listing.
8. **Third-party tiles are untrusted code.** They run in a sandbox with declared permissions
   (section 5). Nothing a stranger wrote gets node, the file system, or the network by default.
9. **Our own tiles walk the author's path** (Colin, 10 Nov 2026). A tile DoshaLabs writes is
   built the way a stranger's is: from the starter (`template/`), loaded with `workshop tile dev`
   or the `+` menu, against the contract as `template/CLAUDE.md` states it. When a tile needs
   something the contract lacks, the contract changes (and that file with it), for every author;
   a core tile never gets a private way in. Wikipedia and Reminders predate this rule.

---

## 2. Why this exists

**The idea (Colin, 9 Nov 2026).** Vibe coders compete for the phone's lock screen. Do the same
for the desktop of Claude Code users: many tiles, authors competing for most-used tile, a hosted
marketplace, all of it open source so anyone can clone and build their own. The model is World of
Warcraft add-ons: mostly free and open, a folder with a manifest dropped into a directory, with a
marketplace on top. Designing a tile is fun, and that fun is the product.

**Who is nearby** (a quick search on 9 Nov 2026, not exhaustive):

- Anthropic's own desktop app runs several Claude Code sessions side by side. The "many sessions
  in one window" layer is theirs to give away. Workshop must win on tiles and on fun, not on
  session management.
- Agent Tile (macOS): Claude Code and Codex sessions as tiles. Sessions only, no other tiles, no
  marketplace. The closest match to deck.
- Session managers: opcode, CloudCLI, CCHub, Clawd Session House, Conductor, Crystal. None has
  third-party tiles.
- Claude Code's plugin marketplace (`/plugin marketplace add`) distributes skills, hooks and MCP
  servers. That covers what Claude does, not what you see.
- **Raycast is the model**: extensions open source in one public repo, a free store, developers
  competing for installs and featured spots with no payouts.

Nobody was found doing "a session manager plus a column of tiles anyone can write". The gap is
real. The hard parts are the sandbox, the tile interface, and getting users before a marketplace
means anything.

**The order that follows from that:** tile contract first, own tiles ported onto it second, public
core third, a plain index fourth, rankings fifth, anything hosted beyond that only if strangers
are actually building tiles.

---

## 3. What ships

### Core (this repo)

| Piece | Notes |
|---|---|
| Sessions | Each is the real `claude` CLI in its own tmux session; survives the app quitting |
| Layout | Left column: sessions. Center: what you are on now. Right column: tiles |
| Launcher | The empty center pane: start a session (folder, worktree, model, permission mode) |
| Preview pane | Read, tick task boxes in, and edit a file a session points at |
| Wolfpack | A session's subagents and helper sessions as live tiles, with pause and kill |
| All themes | Deep Space is the default |
| Wikipedia + weather + clock tile | Asks for your city on first run (deck defaults to Portland, Maine) |
| Git tile | One tile, four tabs (section 4) |
| Files tile | A plain directory tree |
| Web-app tiles | Any site registered by name and URL, as a tile |
| Status mark | The Knot, whose size, speed and colour are each session's status; a sprite pack (Foxtrot recommended) may replace it (section 8) |

The phone remote (deck's second renderer over Tailscale) is **not** in the launch scope.

### Launch tiles (separate repos, listed in the index)

| Tile | What it does | Tier (section 5) |
|---|---|---|
| Spotify | Now playing, transport, playlists, driving Spotify.app | Trusted |
| Reminders / notes | To-dos, notes and a log by project; sessions can write to it | Sandboxed |
| Posture | Camera-based slouch alert with a streak; off by default, all on-device | Sandboxed |
| Spend / usage | What each project and session cost; the 5-hour and weekly windows | Sandboxed |

### Emulators (their own section of the index)

Separate tiles, never in core. Bring your own games.

| Tile | How it runs | What the user installs | Tier |
|---|---|---|---|
| Game Boy / Color | Emulator inside the tile | The tile; a folder of their own `.gb` / `.gbc` files | Sandboxed |
| PS1 | Emulator inside the tile | The tile, their own disc images, possibly a BIOS file | Sandboxed |
| PS2 | Mirrors the separate PCSX2 app | PCSX2, their own BIOS dump, their own discs | Trusted |

The Game Boy core deck uses (serverboy) is GPL-2, which is why it can never be part of MIT core.
One install guide covers all three with the same three steps: install the tile, choose your games
folder (and install PCSX2 for PS2), open the tile and pick a game. The guide and every listing
say plainly that we provide no ROMs, discs or BIOS files.

### Held back, and out

- **The reader** (read a book, select text to translate, save words) waits until it handles any
  language. Translator and vocabulary fold into it when it comes. It is the first tile that needs
  a model call of its own, so `workshop.model` returns with it (section 5).
- **Broadcast** (the MLB gamecast) is out for good.
- Colin's personal tiles (Studio, Molecule, Lesson, Space, Sleepgod, the marathon stage, the body
  pad, the screen recorder) stay in deck. Some may be published later as his own tiles.

---

## 4. The git tile

One tile, four tabs. It ships in core because worktrees are tied to how sessions start. It is
built ON the tile contract (trusted tier) so that tier is exercised before strangers use it.

- **Changes.** Every open session, grouped by project: a line per session with branch, files
  touched and `+n −m`; click one to unfold its diffs. (deck's version shows only the focused
  session; `src/main/git.ts` there is the starting point, including `GIT_OPTIONAL_LOCKS=0` so a
  poll never fights Claude for the index lock.)
- **Worktrees.** One row per worktree in the project: the session that owns it, its branch, ahead
  / behind main, dirty or clean. One-click actions: open a session there, diff against main,
  rebase onto main, merge into main, open a PR, remove the worktree once merged. A "stale" filter
  for worktrees whose session is gone. A warning when two worktrees touch the same file. "New
  chat in a worktree" creates the worktree, the branch and the session in one step.
- **History.** The commit log across all branches, each commit tagged with the session that made
  it; click one for its diff. A "what did Claude do today" filter (24 hours, by session).
- **PRs and CI.** Your open pull requests and whether checks pass, through the `gh` CLI.

Destructive actions (merge, rebase, remove) are two clicks in place: the first arms the button
red for three seconds, the second acts. The tile never force-pushes.

---

## 5. The tile contract, version 1

A tile is a folder: a manifest, a built web page, optionally a Claude Code plugin with skills. The page runs
in its own sandboxed webview with its own storage and no network access unless declared.
Everything it can do goes through one `window.workshop` object that core injects, and every
capability beyond the basics is a permission named in the manifest and shown at install.

### The folder

```
my-tile/
  tile.json                               the manifest
  dist/index.html                         the built page (any stack; NO build step ever runs on the user's machine)
  icon.svg
  plugin/.claude-plugin/plugin.json       optional: a Claude Code plugin, "name" = the tile's id
  plugin/skills/<skill>/SKILL.md          how a Claude session uses this tile
  backend.mjs                             optional: built-in tiles only (trusted tier)
```

`plugin/` is an ordinary Claude Code plugin (`claude plugin validate tiles/wikipedia/plugin`
passes), so its skills read `<tile-id>:<skill>` in a session. Core accepts only skills there
(`src/main/plugin.ts`): hooks, MCP servers, agents and commands run with the session's full
permissions, which makes them the trusted tier.

### The manifest

```json
{
  "id": "reminders",
  "name": "Reminders",
  "version": "1.2.0",
  "workshop": "^1",
  "author": "someone",
  "repo": "https://github.com/someone/workshop-reminders",
  "hint": "To-dos, notes and a log, by project",
  "icon": "icon.svg",
  "entry": "dist/index.html",
  "pane": true,
  "multiple": false,
  "span": 1,
  "permissions": {
    "storage": true,
    "sessions": "read",
    "door": { "ops": ["add", "note", "log", "list", "done"], "timeoutMs": 10000 },
    "notify": true
  }
}
```

- `workshop`: the bridge version the tile was built for (semver). Core refuses a tile it cannot
  satisfy.
- `pane`: the tile can open in the center column at reading size.
- `multiple`: up to four instances at once. Each is its own page on its own partition
  (`persist:tile-<id>.<n>`), so web storage and cookies are per instance; `workshop.storage` is
  per tile and shared; a door call goes to the instance used most recently. A page knows which
  it is from `workshop.instance` (`<id>`, then `<id>.2`…).
- `span`: default height in grid rows.
- `backend` (built-in tiles only): `{ "entry": "backend.mjs", "ops": [...], "timeoutMs"?: n }`.
  A top-level key, not a permission; core shows it as one ("full access to this Mac") and refuses
  it, with the reason, from any installed, indexed or dev tile.

### Two trust tiers

| Tier | What it is | Index treatment |
|---|---|---|
| **Sandboxed** | Page only, bridge only | Automated checks, listed on merge |
| **Trusted** | Adds `backend.mjs`, a node process (Electron `utilityProcess`) with full machine access, run while the tile is on | **Reserved for DoshaLabs' own tiles at launch** (Spotify, PS2, git). Later: manual review, a visible "full access" badge, a louder install prompt |

A marketplace of full-access code is the security problem. Keeping nearly every tile in the
sandbox, and making the exception loud and rare, is the answer to it.

### The sandbox

- Each tile is served from its own origin (`tile://<id>/`), on its own session partition, so its
  storage and cookies are its own.
- No node. No preload of its own. Core's preload is the only one and exposes only
  `window.workshop`.
- Network is blocked by default. Only hosts listed under `permissions.net` get through, enforced
  in the main process, not in the page.
- One live page per tile. The same page moves between the grid cell and the center pane (deck's
  `WebLayer` does this for web apps: a webview that leaves the DOM loses its page, so it is hidden
  and repositioned, never unmounted). The tile is told which view it is in.
- Core draws the tile's head (icon, name, drag grip, expand, close), so tiles look consistent
  and cannot imitate a session.
- Popups go to the browser. Camera, microphone and file access go through the bridge.
- **Overlay** (`permissions.overlay`, a permission rather than a layout flag like `pane`, so it is
  shown at install and an older core refuses the tile): the same page, repositioned over the
  window under a 40 px strip core draws (icon, name, Esc, ×). The page cannot reach the strip.
  Opening needs real input in that page in the last 5 s, one open per input; Esc from any
  webContents closes it in main and never reaches the page. The page draws its own dim backdrop.
- **Files** (`src/main/files.ts`): `pick()` opens the macOS chooser; what the user picks is a grant
  for that tile, remembered across restarts. The page gets a handle and a name, never the path, and
  reads through its own origin at `tile://<id>/~files/<handle>/<path>`, streamed (a disc image
  never crosses IPC). Symlinks that lead outside the grant are refused. Read-only.

### The bridge

Always available:

```ts
workshop.view                      // 'tile' | 'pane' | 'overlay', plus onViewChange
workshop.theme                     // colors as CSS variables, already applied; onChange
workshop.head.set({ title, badge })
workshop.openPane() / workshop.closePane()
workshop.openExternal(url)         // http(s) only
```

Behind a permission:

```ts
workshop.openOverlay() / closeOverlay()  // "overlay" → the page over the whole window (bridge ^1.1)
```

Behind a permission:

```ts
workshop.storage.get/set/watch     // "storage": one JSON store per tile, written atomically by main
workshop.sessions.list/watch       // "sessions": "read"  → name, start folder (project), repo root (root), status, focused
workshop.sessions.transcript(id)   // "transcripts"       → the conversation (see the safeguard)
workshop.sessions.paste(id, text)  // "sessions": "write" → type into a session
workshop.usage.get/watch           // "usage"             → costs and rate-limit windows, computed by core
workshop.door.handle(op, fn)       // "door"              → fn(args, caller, { session }) answers a Claude session
workshop.notify({ text, attention }) // "notify"          → needs-you chip, macOS notification, the mark flares
workshop.files.pick/list/entries/read/url/forget  // "files" → only what the user picked for this tile
workshop.media                     // "camera" / "microphone" → passed to the macOS prompt
workshop.backend.call(op, body) / status() / onStatus(fn)   // built-in tiles with a "backend" only (bridge ^1.2)
```

**Not in version 1: `workshop.model`.** A model call is the tile's own page asking an AI for
something with no session involved (the reader translating a sentence). That is the opposite
direction from a skill, where a session uses the tile. No launch tile needs it, so it was dropped
from v1 and returns with the reader, with a per-tile daily cap the user sets.

### Transcripts and the one manual check

Sandboxed tiles may ask for `transcripts`, with a loud install prompt. A tile that asks for BOTH
`transcripts` and `net` gets a manual review before it is listed, because that pairing is the
only way a conversation can leave the machine. Everything else in the index stays automated.

The Spend tile does not need transcripts: core computes costs and exposes them as `usage`.

### The door (how Claude drives a tile)

This generalizes what deck does by hand for each tile (`/deck:mol`, `/deck:reminders`).

- One route and one CLI for every tile: sessions run `node "$WORKSHOP_TILE" <tile-id> <op>
  [args]`, which POSTs to `/tile/<id>` on core's local hooks server.
- Only ops declared in the manifest are delivered. Anything else is refused before it reaches
  the page.
- A call also carries the calling session's id (`{ session }`, null from outside a session):
  names are not unique, so a tile that must know which session called matches the id against
  `workshop.sessions`.
- The caller's identity (the session's name) is attached by core. It is never read from the
  request body.
- A tile that is turned off refuses at once with "turn on the X tile".
- Each installed tile's `plugin/` folder is handed to new sessions with `--plugin-dir`, which is
  repeatable (verified on Claude Code 2.1.322). A session already running does not see a tile
  installed after it started.

### Install, update, develop

- **Install**: fetch the commit the index pins (no hooks, submodules, LFS or symlinks; `.git`
  deleted), check it, show the permissions, enable on yes.
- **Update**: the index moves the pin. If the new commit asks for more, the user is asked again.
- **Develop**: `workshop tile dev ./my-tile` loads a local folder; `entry` may point at a local
  dev server for hot reload.
- **Remove**: deletes the folder and, on request, the tile's storage.

### Left out of version 1

- The phone.
- See-through tiles as a feature. A webview IS transparent: a tile page with no background of its
  own shows Deep Space's sky (seen 10 Nov 2026). What is missing is a contract for it (a
  `--ws-surface` variable for tiles, and readable text over the sky).
- Tile-to-tile messaging. The reader-to-vocabulary link was the only case and the reader is held.

### The contract checked against the launch tiles

| Tile | Tier | Permissions |
|---|---|---|
| Reminders | Sandboxed | storage, sessions read, door, notify |
| Posture | Sandboxed | camera, storage, notify |
| Spend | Sandboxed | usage |
| Game Boy | Sandboxed | files (the games folder), storage, door |
| PS1 | Sandboxed | files, storage |
| Spotify | Trusted | backend (AppleScript), net (album art) |
| PS2 | Trusted | backend (PCSX2) |
| Git (core) | Trusted | backend (`git`, `gh`), sessions read |

---

## 6. The marketplace

Three repos under DoshaLabs:

1. **`workshop`**: core (this repo).
2. **A tile template**, with an `npm create` script that scaffolds a working tile.
3. **The index**: one repo holding `tiles.json` (id, repo, pinned commit, permissions, category),
   with a static website on top.

How it works:

- **Submit**: scaffold, push to your own GitHub repo, open a PR adding one entry to the index.
  CI lints the manifest, checks the pinned commit builds nothing on install, and flags the
  permissions. The transcripts-plus-network pairing is routed to a human.
- **Browse and install**: the right column's `+` picker gets a Browse tab reading the index.
- **Rank**: the installer pings a small counter with the tile id only (no user id), and anyone
  can turn that off. That gives "most downloaded". "Most used" needs usage telemetry, so it is
  opt-in and comes later.
- **Reuse in other projects**: a tile's `plugin/` folder is an ordinary Claude Code plugin, so the
  index may double as a Claude Code plugin marketplace. The current marketplace file format must
  be checked before this is promised.
- **Sprite packs** (section 8) are a second category in the same index.
- **Profiles** (Colin, 10 Nov 2026): an optional sign-up that gives an author a page linking
  their tiles in the marketplace. It is never required: anyone can write a tile, share it on
  GitHub and submit it to the index without one. Not designed yet (what a profile holds, and
  whether sign-in is GitHub's).

There is no hosted backend at launch beyond the counter and a static site. A WoW-style hosted
marketplace is step 6 of the roadmap and happens only if strangers are building tiles.

---

## 7. How core works (carried over from deck)

This is deck's architecture, which workshop keeps. File names are deck's and are where to read
the working version.

- **A session is a process, not a view.** `exec claude --settings <hooks file> --session-id
  <our uuid> [--worktree] [--model …] [--permission-mode …] [--name …] [--plugin-dir …]… [first
  prompt]` inside its own tmux session on a PRIVATE tmux socket. Exactly one client is ever
  attached: a node-pty in the main process, drawn by xterm.js when the session is focused.
  tmux is there so sessions survive the app quitting. (`sessions.ts`, `tmux.ts`)
- **Close = park, not kill.** Closing detaches the client; the tmux session and the conversation
  stay and can be resumed.
- **Never attach a second tmux client** to a session the app has open; tmux sizes to the smallest
  client. To look from outside, use `capture-pane`.
- **Tiles of sessions are conversations, not terminals.** Main tails each session's transcript
  JSONL and the tile renders prompts, prose as markdown, and a line per tool call. Only the
  focused session mounts a terminal, and only that terminal holds a WebGL context.
  (`transcript.ts`, `ChatView`; built so in workshop too.) The CLI writes lines it injects as
  the user (a background task's notification, another session's message) with an `origin` that
  is not `human`: they are not your prompts, and the tile does not show them as such.
- **Status = a poll plus hooks.** `claude agents --json` polled is the truth; Notification / Stop
  / UserPromptSubmit hooks make it instant. After a Stop, the poll's "busy" is not believed until
  the next prompt (a background shell outliving the turn reads as busy). (`fleet.ts`, `hooks.ts`)
- **A local hooks server** (127.0.0.1 only) receives the hooks and is the door for tiles. Hook
  commands never block Claude (`curl -m 2 …; exit 0`), with one deliberate exception: PreToolUse
  → `/pretool`, which holds a tool call while the user has that agent paused (the leash).
- **`--settings` merges** with the user's own settings, so their hooks keep firing. `statusLine`
  is a single object and would replace theirs, so ours posts the status JSON to core and then
  runs the user's own command on the same input.
- **The columns have jobs.** Left: sessions, most recently active first until the user drags them, nothing else.
  Right: tiles, draggable, each column its own endless scroll. Center: whatever you are on now.
- **Profiles.** The profile name is the tmux socket name and the settings folder name, with its
  own hook port, so a dev build never sees the installed app's sessions. A session working ON
  workshop can run the dev build inside the installed one.
- **Themes are data.** A catalog of families with light and dark variants, written into CSS
  variables and the terminal palette. No colour is hard-coded in the stylesheet. Deep Space is a
  star-field wall behind see-through panes and is dark in both appearances.

### Things deck learned the hard way (keep them)

- **Claude Code's own theme must follow the app's.** The CLI paints some backgrounds itself (a
  prompt's row, a block opened in its transcript view) in ITS theme and leaves the text to the
  terminal's foreground. A light Claude theme inside Deep Space is near-white text on light grey.
  Fix: the `--settings` file carries `theme`: the user's own with only light / dark switched to
  match the app, `-daltonized` / `-ansi` kept. It is read when a session starts.
- **Some subagents never send a stop hook.** The built-in web-fetch agent hands its report back
  as a message and fires neither SubagentStart nor SubagentStop. The tracker must also read each
  working agent's sidecar (`agent-<id>.meta.json`, `"finished": true`) once its transcript has
  been quiet ten seconds. A few agents are never marked finished at all; the row's close button
  is the last resort.
- **Never guess a subagent's transcript path.** It differs for Agent-tool and Workflow agents and
  may not exist at start. Resolve it by looking, and prefer the path the stop hook names.
- **The CLI's internal forks** carry agent ids, call tools and stop, and never write a
  transcript. Make a tile for an unseen agent only if its transcript exists.
- **A webview that leaves the DOM loses its page.** Keep webviews mounted and hide them with
  `visibility`, never `display: none`.
- **Chromium caps live WebGL contexts** (about 16 per window). Budget them.
- **Electron ships no Widevine**, so web players that need DRM (Spotify's) cannot be embedded;
  drive the native app instead.
- **tmux 3.5a rejects `=name` exact-match targets** for some commands; use plain names.
- **Keep this file small.** deck's CLAUDE.md grew to 175,000 characters, past Claude Code's
  150,000 limit. This file is loaded into every session: one screen per topic, details in
  `docs/`.

---

## 8. The status mark: the Knot, and sprite packs over it

**Decision (Colin, 10 Nov 2026): the Knot is the default status mark and the app's mark.** It
replaces Foxtrot out of the box. A sprite pack, Foxtrot included, is what a user may install over
it. The commissioned fox is no longer needed for launch.

### The Knot (built)

A (3,4) torus knot turning in 3D on a small 2D canvas, strands back to front, a bright pulse
riding the strand: workshop's own version of the "AlgoGlyph" in Colin's Cura app (a (3,5) knot
there; no code is shared). `src/shared/knot.ts` holds the curve, the status language and the
colour maths (pure, tested); `src/renderer/src/Knot.tsx` runs it. It sits in every session's head
where the dot was (`Mascot.tsx` falls back to it), and larger at the top left of the window, right
of the traffic lights (`AppMark`), where it is full size and fast while any session works.

| Status | Mode | Size | Loop | Frames/s | Colour |
|---|---|---|---|---|---|
| busy | work | 1 | 2.4 s | 30 | accent → busy |
| idle, unknown | rest | 0.5 | 22 s | 6 | accent → starting |
| needs you (blocked, or attention) | needs | 0.85 | 7 s | 15 | blocked → busy |
| starting | start | 0.75 | 5 s | 15 | starting → accent |
| dead | dead | 0.5 | still | 0 | dead → muted; the head dimmed |

Size changes ease over a few hundred ms in the same box. The strand's width follows the box, not
the radius, so a small knot stays a line. A call for attention flares the pulse and swells the knot once (0.9 s).

- **Colour is the theme's.** Every colour drawn is checked against the panel and the window's
  background and moved toward the ink until it reaches 3:1; far strands are pulled toward the
  panel, never made see-through (that washed out on light themes). `test/knot.test.ts` checks
  every variant, every mode, both sizes, with and without a flare.
- **The curve closes after P = 3 loops** (the spin turns a third of the way per loop; the knot
  matches itself every quarter turn), so each knot's clock wraps at 3 loops and never jumps. A
  speed change keeps the phase: the clock advances by dt / loop.
- **Cost.** One shared clock that wakes only when some visible knot is due (a timer, then one
  rAF), nothing drawn off screen (IntersectionObserver) or while the window is hidden, one still
  frame under reduced motion, about 60 segments at 20 px. 2D canvases only: terminals need WebGL.

### Sprite packs (built)

A pack is a folder in `<profile>/mascots/<id>/`: a PNG and `pack.json` (`src/shared/mascot.ts`
validates it; `src/main/mascot.ts` stores it; core's settings name the active one):

```json
{ "format": 1, "name": "Foxtrot", "image": "sheet.png", "sheet": { "w": 448, "h": 224 },
  "frame": { "w": 32, "h": 32 }, "box": { "x": 4, "y": 14, "w": 22, "h": 18 },
  "states": { "idle": { "row": 0, "from": 0, "frames": 5, "ms": 280 }, "...": {} },
  "worker": { "swap": [["#d67941", "#e5b843"]] }, "credit": { "by": "Elthen", "url": "https://…" } }
```

States: `idle` (starting, default), `look` (needs you), `run` (working), `leap` (a call for attention, played
once), `sleep` (resting; a dead session sleeps, dimmed). One is required; the rest borrow the
nearest (`FALLBACK`). Unknown fields and states are refused. **There is no "alert, tail up" pose:
Colin's rule, it reads badly. Do not add one.** `box` crops each frame's empty margins; the art
is fitted into 22 × 18 at whole-number scales, `image-rendering: pixelated`. `worker` is the
subagent coat: its own sheet, or colours to swap, else `tintCoat`'s gold (built and tested, not
drawn yet: there are no subagent tiles). Calls for attention: a tile's `notify({ attention: true })` goes to the
session that last called that tile through the door (10 minutes), else the focused one; a session
also calls the moment it starts needing you or finishes a turn.

The setup screen (top bar, "Mascot"; `MascotSetup.tsx`) is "use your own sprite sheet instead of
the Knot": drop or choose a PNG, the grid is guessed (the smallest frame size whose grid lines
never cut through art) and can be corrected, each pose gets a row, first frame, count and speed
with a live preview, name it, save; Edit and Remove (back to the Knot).

### Foxtrot: recommended, downloaded by the user

The setup screen recommends Elthen's "2D Pixel Art Fox Sprites" and links to
https://elthen.itch.io/2d-pixel-art-fox-sprites (opened in the browser). Workshop does NOT
contain the sheet and never fetches it; the user downloads it (name your own price, $0 allowed)
and drops it in. Workshop ships only the MAPPING (`FOXTROT` in `src/shared/mascot.ts`: rows,
frame counts, speeds, the art box, the two coat colours for the worker swap), and recognises the
sheet by its LAYOUT: 448 × 224, 32-pixel frames, and how many frames each row holds read from
the transparent pixels (5, 14, 8, 11, 5, 6, 7). No pixels and no hash of the art. Beside the link:

- The art is Elthen's, under his own licence, not this project's.
- Credit is not required by his licence but he appreciates it; workshop credits him by name with
  a link, and suggests a tip.
- You may not redistribute the sheet, use it in anything blockchain-related, or train AI on it.

Tests and smoke use synthetic sheets of plain blocks. A commissioned, owned fox (brief: original
design, cute, big head and tail, 22 × 18 in a 32 × 32 frame, two coat ramp colours, a written
assignment or CC0, a row for a dead session) could still ship as a pack one day; it no longer
blocks anything.

### Why not the fox deck uses

deck's fox is Elthen's "2D Pixel Art Fox Sprites". Its licence ("Elthen's Common Sense License
1.0", in force for anything obtained after 1 Nov 2025; Colin's copy is from June 2026) allows
personal and commercial use and editing, does not require credit, and **forbids redistributing
the assets, even edited**, with no carve-out for open source. It also forbids blockchain uses and
training generative models on the assets.

**So that sheet, and anything derived from it (icons, recolours, Game Boy strips), must never be
committed to this repo.** A user may install it privately as their own sprite pack.

### What was tried and rejected for the default

Two CC0 3D foxes were rendered to sprite sheets with a throwaway three.js script (10 Nov 2026):

- **Quaternius, Ultimate Animated Animals** (CC0; idle, walk, gallop, jump, eating, death…): a
  realistic fox, thin and long-legged. At tile-head size the legs are a pixel wide and it has no
  charm. No sleep pose; the death pose looks dead.
- **Kenney, Cube Pets 2.0** (CC0, confirmed in its `License.txt`; idle, walk, run, eat, dance,
  two gestures): cute at preview size, an orange blob at 24–32 pixels, and its animations are
  all the same cube bobbing.

Hand-drawn pixel art beats a rendered model at this size. The render pipeline is still worth
keeping as a tool: it turns any CC0 3D model into a sprite pack.

---

## 9. Working with Claude Code

Claude Code is not open source, so there is no fork. Its extension points are enough, and deck
already uses most of them:

| Extension point | What workshop uses it for |
|---|---|
| `--settings <file>` | Our hooks, env vars, status line and theme, merged over the user's own |
| Hooks | Status (Notification, Stop, UserPromptSubmit), subagent tiles (SubagentStart / Stop), the leash (PreToolUse), session context (SessionStart) |
| `--plugin-dir` (repeatable) | Core's own skills, and each installed tile's `plugin/` folder |
| `statusLine` | The account's rate-limit windows and each session's context percentage |
| `--session-id` | Our own UUID, which is how hooks and poll rows are matched to a tile |
| `--worktree`, `--model`, `--permission-mode`, `--name` | The launcher's choices |
| The transcript JSONL | The conversation shown in tiles |

**What to build that the Claude app has and deck lacks:**

1. **Answer permission prompts from a tile.** Today they exist only in the terminal. The leash
   already holds every tool call at `/pretool`, so approve and deny buttons should be reachable
   the same way. This is the biggest gap. (Not yet verified end to end.)
2. Image paste into a tile's prompt bar.
3. A diff review pane (the git tile's Changes tab covers most of it).

### Bring your own model

- **Sessions (launch scope):** a per-session provider profile sets environment variables such as
  `ANTHROPIC_BASE_URL`, so the Claude Code interface stays and the model behind it changes.
- **Tiles (later):** `workshop.model`, routed to the user's own key or to headless `claude -p`
  on their account. Not in v1.
- **Constraint:** only the unchanged CLI is ever run, and its credentials are never touched.

---

## 10. Onboarding

- One install script: checks for macOS, tmux and a logged-in `claude`, installs the app.
- First launch asks for a city (weather) and opens a **tutorial session** that walks the user
  through building their first tile with Claude. A focus timer is the suggested example: small,
  and it exercises storage and notify.
- The README says in its first lines: macOS, Claude Code, here is how to build a tile.

---

## 11. Roadmap

1. **Tile contract and sandbox**, with Wikipedia as the reference tile.
2. **Port three tiles** to prove the contract: Reminders first (storage, sessions, door at once),
   then the git tile (trusted tier), then Posture or Spend.
3. **Extract core** into this repo, with the installer, the tutorial and the sprite-pack setup.
4. **The index repo and static site**, then the Browse tab.
5. **The counter and rankings.**
6. **Hosted marketplace extras**, only if strangers are building tiles.

The mascot does not block the first public push: the Knot is the default mark, and the setup
screen points at Foxtrot's download for anyone who wants the fox (section 8).

---

## 12. Open questions

- **The public name.** "workshop" is the working name and the repo name. Colin is fine with the
  overlap with deck's packaged app name ("Foxtrot's Workshop"); deck's build gets renamed when
  the public app exists. Other candidates raised: foxtrots-workshop, foxden, skulk, tilework.
- **The bridge's name.** This document uses `window.workshop`, `"workshop": "^1"` and
  `workshop tile dev`. Not confirmed; follows the public name.
- **The worker swap's two coat colours** in `FOXTROT` are read off Elthen's sheet (deck had them).
  Two hex values are not his art, but Colin should confirm; without them the default gold tint applies.
- **Does the tile index work as a Claude Code plugin marketplace** as is?
- **Permission prompts in a tile**: confirm the PreToolUse route can carry an approve / deny.
- **When to open the trusted tier** to outside authors, and what its review looks like.
- **The reader**: what "handles any language" means concretely (which books, which translator).

---

## 13. Sources

- Elthen's fox and licence: https://elthen.itch.io/2d-pixel-art-fox-sprites ,
  https://www.patreon.com/posts/licensing-27430241
- Quaternius, Ultimate Animated Animals: https://quaternius.com/packs/ultimateanimatedanimals.html
- Kenney, Cube Pets: https://kenney.nl/assets/cube-pets
- Raycast extensions: https://github.com/raycast/extensions
- Session tools: https://github.com/winfunc/opcode , https://github.com/siteboon/claudecodeui
- deck (private reference): `~/deck`, whose own CLAUDE.md documents every piece named in
  section 7 in full.
