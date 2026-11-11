# workshop

A desktop app for people who use Claude Code: several Claude Code sessions in one window, and a
column of small apps ("tiles") beside them that anyone can write, share and install. Open source,
in the DoshaLabs GitHub org. macOS and Claude Code first.

**Status (11 Nov 2026): the tile host (roadmap step 1), sessions, the status mark (section 8), the three-tab
`+` menu with install, the preview pane, the trusted tier, the leash and permission prompts, the wolfpack and `transcripts` are built; the rest of this
file is still the plan.** Every section says what was decided and why, so that whoever starts building, person or
Claude session, does not have to re-derive it. When code lands, rewrite the matching section to
describe what exists and delete the plan wording.

**What exists.** `npm run dev` · `npm test` (unit) · `npm run smoke` (launches the app with a
throwaway profile and `test/fixtures/probe`, a tile that tries every way out of the sandbox, and
drives the door, and ends by restarting core on the same profile, so sessions are seen to survive a restart
and a reboot; must print 0 failed; `WORKSHOP_SHOT=x.png` also saves a picture of the window).
Smoke sessions run a stand-in `claude` (`test/fixtures/fake-claude/claude`) that runs our hooks the
way the CLI does; `WORKSHOP_REAL_CLAUDE=1 npx electron . --smoke` runs one real Haiku turn instead.
Smoke needs no network: the Wikipedia tile's hosts are answered from canned data inside its own
session, behind its request filter (`src/main/smoke-net.ts`; `WORKSHOP_LIVE_NET=1` uses the real
services). A core that fails to start ends the run at once with `FAIL core started`.
The first build session's notes, open issues and second-pass list: `docs/progress/2026-11-10.md`.

`npm run dist` builds `dist/mac-arm64/workshop.app` (electron-builder, signed with the keychain's
identity, hardened runtime, not notarized); `npm run install-app` builds it and copies it to
/Applications, refusing while that copy runs. The installed app (profile `workshop`) shows
"Install update" in its top bar when the repo it was built from changes (`src/main/updates.ts`,
carried from deck: a fingerprint of the source every minute, `npm run dist`, then a swap once it
has quit, and a relaunch; sessions carry on in tmux). `npm run icon` redraws `build/icon.icns`
from the Knot. Core's own files (`tmux.conf`, `bin`, `tiles`, `template`, `assets`, `plugin`,
`native`) are `extraResources`, found through `coreFile()` (`src/main/resources.ts`).
`WORKSHOP_PROFILE=<name>` runs any build on a throwaway profile. Notes:
`docs/progress/2026-11-10-dist.md`.

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
- `tiles/wikipedia/` (named "Today"; the id stays `wikipedia`): deck's Wikipedia tile ported onto
  the contract, plain JS with no build step: the picture of the day full bleed (cycling every 2
  minutes, today's then two from the archive), a clock top left and the weather top right
  (Open-Meteo; asks for a city on first run, places kept in `workshop.storage`). No search box:
  a session's door search lists hits and opens an article over the picture. A click opens it as
  a pane, which shows the picture whole. Rules in `dist/wiki.js`, tested as shipped.
- `tiles/reminders/`: deck's Reminders ported onto the contract (storage, sessions read, door,
  notify): to-dos, notes and a log by project. Its rules are `dist/model.js` (tested as shipped by
  `test/reminders.test.ts`), its page `dist/tile.js`. It lives here until the index exists, then
  moves to its own repo (section 3). What the port changed in core and what it could not do:
  `docs/progress/2026-11-10.md` section 8.
- Layout: three equal columns, as in deck. A column holds 3.8 rows (`--tile-rows`, `--tile-gap`
  and `--tile-radius` in `styles.css`, shared by both columns; a tile's page is clipped to its
  tile's corners in `TileLayer.tsx`): a tile is one row
  (its manifest's `span`, 1 or 2; Git is 2) and ↕ on its head steps it to two rows at most. A new profile's column starts
  with Wikipedia at the top (`shared/column.ts` `DEFAULT_ORDER`). The left column's session tiles
  are one row too, so the two columns line up. A wheel a tile's page cannot use scrolls the column
  (`preload/tile.ts`).
- The `+` is the tile column's last cell; its menu (`TilePicker.tsx`) is a lightbox over the whole
  window and its tile pages (`.lightbox`, z-index above `.tile-layer`; Esc or the backdrop closes it), in three tabs. Built in:
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
  `src/shared/tile-index.ts`; its address is `WORKSHOP_INDEX`, else `settings.index`, else
  `DEFAULT_INDEX`, DoshaLabs/workshop-index's `tiles.json` on main (never in a smoke run). Main
  reads it (`src/main/index-read.ts`: 10 s, 2 MB counted as it streams, kept a minute). Git runs
  without the user's own config. `WORKSHOP_REAL_INDEX=1 npx electron . --smoke` walks the real
  index on GitHub: install, run, update and remove Pomodoro (`docs/progress/2026-11-11-index.md`).
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
- Commits (`src/main/commits.ts`): a PostToolUse hook on Bash posts to core when the call
  mentions git; when it made commits (the CLI's `gitOperation`, or git commit / merge /
  cherry-pick / rebase / revert / am / pull), core reads HEAD's reflog over the call's window and
  records sha → session id and name in `<profile>/commits.json` (atomic, 90 days, 5,000; never
  the command). Backends get the records (`commits` message) and may `emit` events to their pages
  (`workshop.backend.onEvent`).
- Bridge: `sessions.list/watch/paste` (no titles: they quote the conversation) and
  `usage.get/watch` (the two windows, and per session context % and cost, from the status line).
- `sessions: "launch"` (bridge 1.4; read < launch < write): `workshop.sessions.launch({ folder,
  worktree? })` opens the launcher filled in, Start focused, only from a real click in the page.
  It never starts a session or writes a prompt.
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
- Music (bridge 1.3, `permissions.music`, `docs/progress/2026-11-10-music.md`): `workshop.music`
  reads and drives Spotify.app and Music.app for a sandboxed tile. `src/main/music.ts` runs fixed
  JXA/AppleScript through osascript (a tile's values only as checked argv), never launches an app
  (`running()` first), polls only while a page watches (1 s playing, slower otherwise), and serves
  the artwork at `tile://<id>/~music/art/<hash>` (`tiles.ts`), so the tile needs no `net`.
  Denied Automation is `error: 'denied'`. `show()` (bridge 1.6) brings the app in use to the
  front, only from a click or key in the tile, once a second, and never opens one. Smoke drives it with a stand-in runner
  (`smoke-music.ts`, `test/fixtures/music`). A packaged build needs `NSAppleEventsUsageDescription`
  (and the Apple Events entitlement under the hardened runtime).
- Sign-in (bridge 1.5, `permissions.oauth`: hosts, as `net`; `docs/progress/2026-11-11-oauth.md`):
  `workshop.oauth.authorize(url)` opens a provider's authorize page and resolves with the loopback
  callback's query. `src/main/oauth.ts` listens on 127.0.0.1:47800 only while a sign-in is pending,
  at `/oauth/<tile id>/callback` (each tile its own path: with no client secret, the registered
  redirect is all that ties a client id to a tile), sets `state` itself, requires `response_type=code`
  and PKCE S256, needs a click in the page (once per input, like the overlay), answers only that
  path with Host `127.0.0.1:47800`, and serves fixed pages. Core never sees a token: the tile
  exchanges the code through `net`. Smoke (`smoke-oauth.ts`, `test/fixtures/oauth`) uses a free port.
- `tiles/git/` (track C, `docs/progress/2026-11-10-git.md`): the Git tile, built in with a
  backend, read-only. Changes: every open session by project, one line per working tree (sessions
  sharing one are named together) with branch, files and `+n −m` against HEAD (untracked lines
  counted, binary not), unfolding to the diff the backend parsed into hunks. The page names
  sessions by id; the backend finds their folders. Every git call: argv, no shell,
  GIT_OPTIONAL_LOCKS=0, no pager or colour, a timeout and a cap. Door: `git show`.
  Worktrees: every worktree of each open session's project, with its sessions, ahead / behind main
  (origin/HEAD, else main, else master), clean or dirty, a stale filter and a warning when two touch
  one file; diff against main, rebase, merge into main (where main is checked out) and remove once
  merged, each destructive one two clicks, refused while a session there is busy or the tree is
  dirty, a conflict aborted at once (`docs/progress/2026-11-10-worktrees.md`).
  History: the log across every branch of each open session's project (300, then more), each
  commit tagged with its session: exact when core saw the session make it, "probably <name>" when
  it is on that session's worktree branch and made in its lifetime, else nothing; a click unfolds
  the diff; "Today, by session" groups the last 24 hours (`docs/progress/2026-11-10-history.md`).
  PRs says "Coming".
- Theme variables include `--ws-green` and `--ws-red` (the terminal's, at 4.5:1 on the panel).
- Session tiles (phase 1, `docs/progress/2026-11-10-phase1.md`): the left column is a column of
  tiles, one per open session, each its live conversation (`ChatView.tsx`; prose as markdown in
  the serif face, parsed to a tree by `src/shared/markdown.ts`, never HTML), with ⌘n, the status
  dot, Claude's title, model, context % and cost on its head; no prompt bar (Colin, 10 Nov 2026:
  you type to a session in its terminal, a click away). Main
  tails each open session's transcript (`src/main/transcript.ts`, parser in
  `src/shared/transcript.ts`), finding `<session id>.jsonl` under the CLI's config folder by
  name. The focused session's terminal is in the center and its tile leaves the column, as in
  deck (the center's head has its ⌘ number and park ×); nothing in a conversation is a link (links, paths and pictures are text; Colin, 11 Nov 2026);
  a conversation is pinned to the latest and never scrolls itself (the wheel is the column's; its text a little greyer than the ink); files
  dropped on a session (`drop.ts`) are pasted as paths on the terminal or a tile; parked
  sessions are a Closed card at the foot. A render error stays in its piece (`Guard.tsx`).
- Usage: the top bar's 5-hour and weekly meters are always there (a dash and a tooltip until a
  session reports); each session shows its context % and cost.
- Shortcuts (`src/shared/shortcuts.ts`): ⌘1–9 (sessions in the order they were started), ⌘[ ⌘],
  ⌘N, ⌘⇧O (the screen recorder). Main catches them in `before-input-event` on core's window and every tile's page.
- The tile column's state (off, extra instances, heights) is `settings.column` in core's
  settings (`src/shared/column.ts`), migrated once from the window's old localStorage.
- The status mark (section 8): the Knot (`src/shared/knot.ts`, `Knot.tsx`) on every session and
  at the top left; sprite packs over it (`src/shared/mascot.ts`, `src/main/mascot.ts`,
  `Mascot.tsx`, `MascotSetup.tsx`, `mascot-store.ts`); `notify({ attention: true })` flares or leaps it.
  Smoke: `WORKSHOP_SHOT_MASCOT=<dir>` saves pictures, `WORKSHOP_SMOKE_SHEET=<png>` tries a sheet
  in the setup screen (throwaway profile only), `WORKSHOP_MEASURE_CPU=1` prints renderer CPU.
- The screen recorder (`src/main/recorder.ts`, `src/shared/recorder.ts`, the frame's page in
  `src/renderer/src/recorder/`, its preload `src/preload/recorder.ts`, the sound helper
  `native/recaudio.swift`; `docs/progress/2026-11-10-recorder.md`): deck's, carried over. The top
  bar's button or ⌘⇧O opens a 9:16 frame you drag anywhere that films what is under it at
  1080 × 1920, or (its bar's `9:16 | Column` switch, `settings.recorder.fit`) the center column
  exactly, at its own size in the display's pixels, the frame following the window and its bar above
  the column (`centerWindow`, `outSize` in `src/shared/recorder.ts`), or (`Brand`) no screen at all:
  the brand clip (`recorder/brand.ts`), Deep Space's sky as a `Sky` of its own (`cosmos.ts`: smaller
  nebulae, larger and more stars, the flight held near the middle) with the Knot turning 2.5 times slower than a
  working session's (`PACE`) over the word "workshop" (`scripts/wordmark.json`), drawn at 1080 × 1920 and
  recorded as it is, with the take's sound, with the Mac's sound through BlackHole (the user installs it) and optionally the
  microphone, into `~/Movies/workshop/` (ffmpeg makes it Instagram's H.264 if installed). Core's
  own, on its own partition: tiles still get no screen capture. Smoke films a test pattern, never
  the screen.
- Preview pane (`PreviewPane.tsx`, `preview-store.ts`, `src/main/preview.ts`): a file a session
  points at, in the center. Markdown through the tree with live task boxes (one character
  written), code and text in mono with line numbers, `edit` and ⌘S; writes locked to the mtime
  read; the file watched and reloaded unless there are unsaved edits; folders, binaries and
  files over 2 MB refused with a note. Opened by a click on a path in the focused session's terminal (an xterm
  link provider and `file://` OSC 8 links, `terminals.ts`; ⌘-click, and any HTML file, opens it
  in its own Mac app instead, never anything that would run) or in a previewed markdown file
  (`src/shared/paths.ts`) or `node "$WORKSHOP_DOC" open <path> [--line N]`
  (`bin/workshop-doc.mjs`, POST /core/doc with the session's token; skill `workshop:doc` in core's
  own `plugin/`).
- Drag to reorder (`reorder.ts`, `src/shared/order.ts`): ⠿ on every head, both columns; orders in
  `settings.column` (`order`, `sessions`). A dragged session column keeps its order and ⌘1–9
  follow it; "most recent first" goes back. Tile pages let the pointer through during a drag.
- A picture dropped with no file of its own (from a browser) is kept in `<profile>/drops/`
  (`src/main/drops.ts`) and pasted as that path.
- A session's project root (`src/main/project.ts`): resolved once through `git rev-parse
  --git-common-dir`, so worktrees of one repo share it; `workshop.sessions` gives it as `root`
  beside `project` (the start folder). A store that cannot be parsed is moved aside
  (`store.json.broken-<time>`), never written over. Long transcripts are read from the end.
- The leash and permission prompts (`src/main/leash.ts`, `src/shared/leash.ts`, `Leash.tsx`;
  `docs/progress/2026-11-11-leash.md`): ⏸ on a session's heads writes `<profile>/leash/<id>.paused`;
  its PreToolUse hook (`leash.sh`) exits at once without it and otherwise holds the call on
  `/ask/pretool` (Resume, or Refuse and stay paused). A PermissionRequest hook (`ask.sh`) holds
  `/ask/permission` while the CLI shows its dialog: the tile, or the center head, shows the tool
  and its input as text with Allow and Deny, the mark goes to needs you, and the terminal can
  still answer (core sees it through the hook hanging up, the poll's `waitingFor`, PostToolUse,
  Stop). Both scripts retry a core that is restarting; a pause is a file and outlives core.
  Core's window only: tiles see none of it.
- The wolfpack (`docs/progress/2026-11-11-wolfpack.md`): a session's subagents (`src/main/agents.ts`)
  and helper sessions (`src/main/helpers.ts`) as one pack tile under it (`PackTile.tsx`): a chip per
  agent, the chosen one's conversation (ChatView), its mark in the worker coat (the Knot gold:
  `knot.ts` `goldOf`, `--ws-worker`). Subagents from the SubagentStart / Stop hooks; transcripts
  found by looking under `<session id>/subagents/` (never guessed; the stop hook's path wins);
  finished by the stop hook or by the sidecar's `"finished": true` once quiet 10 s; no tile for a
  fork with no transcript; × as the last resort. Kill (■, two clicks): the tile goes, the parent is
  told in one typed line, and its held and later calls are refused. Pause holds one subagent's
  calls through the leash: a session with a subagent paused or killed in the last 10 minutes has
  `<profile>/leash/<id>.agents`, so `leash.sh` calls core for its calls, and `/ask/pretool` asks
  `AgentTracker.preTool` before the session's own pause. Every other session still makes no request.
  Helpers: `node "$WORKSHOP_HELPER" start "<prompt>"` (skill `workshop:helper`) runs `claude --bg`
  in the parent's folder with our settings, the parent's permission mode and a token of its own;
  kill is `claude stop <id>`. Smoke: the stand-in runs `agent <how>` and `--bg`.
- Float (bridge 1.8, a manifest's top-level `"float": true`, a layout flag beside `pane`): ⧉ on the
  tile's head pops its page into a 200 px square (`Float.tsx`) under a strip core draws (icon, name,
  author, ×; the drag grip), at the active session's top-right corner (the focused terminal, else
  the center), kept as an offset from it (`settings.column` `floating` / `floatAt`,
  `shared/column.ts` `placeFloat`), always inside the window. The tile layer rises to 12 while one
  is up, over the terminal; the box is 13. Main refuses the `float` view to a tile without the
  flag. Smoke's probe declares it (`floats` in `smoke.ts`; `WORKSHOP_SHOT_FLOAT=x.png`).
- Codex sessions (phase 1 of `docs/progress/2026-11-11-codex.md`): `src/shared/cli.ts` (`cli:
  'claude' | 'codex'` on a session, absent = Claude Code; `cliSessionId` was `claudeSessionId`,
  renamed on load). A Codex session is one tmux session, two windows: the TUI (attached) waiting
  for the socket, then `codex --remote unix://<profile>/codex/<id>.sock -C <cwd>`, a clean exit
  ending both; and `codex app-server --listen` started in the session's folder with the session's
  door env (tools run in the server). The launcher offers Codex only when it is on PATH
  (`core.clis()`), with its own modes (`CODEX_MODES`). Not yet: status (shown unknown), the
  conversation tile, usage, the leash (no ⏸). Worktrees: 0.167.1 refuses `--worktree` with
  `--remote`, so core makes one (`src/main/worktree.ts`): `<project root>/.workshop/worktrees/<name>`
  on `worktree-<name>` from the start folder's HEAD, `/.workshop/` in the repo's `info/exclude`
  (Colin, 11 Nov 2026). Hook ids match through `isSession` (never on ''). Smoke:
  `test/fixtures/fake-codex/codex`, `smoke-codex.ts`.
- `transcripts` (bridge 1.7): `workshop.sessions.transcript(id)` / `watchTranscript`, the parsed
  blocks a session tile draws, needs `sessions` too; a loud line in the menu and the install prompt;
  `tile check` prints `review` for transcripts with net.

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
3. **macOS, Claude Code and Codex.** Say so in the README. Codex runs as a second kind of
   session, each CLI on the user's own plan (Colin, 11 Nov 2026; plan in
   `docs/progress/2026-11-11-codex.md`). We never build an agent of our own. Other platforms and
   other agent CLIs are welcome contributions.
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
| Wolfpack | A session's subagents and helper sessions as one pack tile under it; kill built, pause waits on the leash |
| All themes | Deep Space is the default |
| Wikipedia + weather + clock tile | Asks for your city on first run (deck defaults to Portland, Maine) |
| Git tile | One tile, four tabs (section 4); Changes built |
| Files tile | A plain directory tree |
| Web-app tiles | Any site registered by name and URL, as a tile |
| Status mark | The Knot, whose size, speed and colour are each session's status; a sprite pack (Foxtrot recommended) may replace it (section 8) |
| Screen recorder | A 9:16 frame for Reels / Stories you drag anywhere, with the Mac's sound (from deck) |

The phone remote (deck's second renderer over Tailscale) is **not** in the launch scope.

### Launch tiles (separate repos, listed in the index)

| Tile | What it does | Tier (section 5) |
|---|---|---|
| Spotify | Now playing and transport, driving Spotify.app through core's `music` permission | Sandboxed |
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
  pad) stay in deck. Some may be published later as his own tiles. The screen recorder came over
  as part of core (Colin, 10 Nov 2026).

---

## 4. The git tile

One tile, four tabs. It ships in core because worktrees are tied to how sessions start. It is
built ON the tile contract (trusted tier) so that tier is exercised before strangers use it.

- **Changes** (built: `tiles/git`; sessions in one worktree share a line). Every open session, grouped by project: a line per session with branch, files
  touched and `+n −m`; click one to unfold its diffs. (deck's version shows only the focused
  session; `src/main/git.ts` there is the starting point, including `GIT_OPTIONAL_LOCKS=0` so a
  poll never fights Claude for the index lock.)
- **Worktrees** (built; Open a PR waits for the PRs tab). One row per worktree in the project: the session that owns it, its branch, ahead
  / behind main, dirty or clean. One-click actions: open a session there, diff against main,
  rebase onto main, merge into main, open a PR, remove the worktree once merged. A "stale" filter
  for worktrees whose session is gone. A warning when two worktrees touch the same file. "New
  chat in a worktree" creates the worktree, the branch and the session in one step.
- **History** (built: exact from a PostToolUse hook, else a visible guess; the filter is "Today, by session"). The commit log across all branches, each commit tagged with the session that made
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
| **Trusted** | Adds `backend.mjs`, a node process (Electron `utilityProcess`) with full machine access, run while the tile is on | **Reserved for DoshaLabs' own tiles at launch** (PS2, git). Later: manual review, a visible "full access" badge, a louder install prompt |

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
- **The wheel** at a page's edge is the column's (`preload/tile.ts`), as nested scrolling is in a
  page: a tile that scrolls keeps the wheel until its end.
- **Files** (`src/main/files.ts`): `pick()` opens the macOS chooser; what the user picks is a grant
  for that tile, remembered across restarts. The page gets a handle and a name, never the path, and
  reads through its own origin at `tile://<id>/~files/<handle>/<path>`, streamed (a disc image
  never crosses IPC). Symlinks that lead outside the grant are refused. Read-only.
- **Music** (`src/main/music.ts`): core, not the tile, talks to Spotify and Music, with fixed
  scripts; the tile's values (seek, volume, a Spotify URI) are checked and passed as arguments.
  Core never opens either app. The artwork is fetched by core (Spotify's CDN only) or read from
  Music, and served on the tile's own origin, so a music tile needs no `net`.

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
workshop.sessions.transcript(id) / watchTranscript(id, fn)  // "transcripts" (+ "sessions", bridge ^1.7) → the conversation, parsed (see the safeguard)
workshop.sessions.launch({ folder, worktree })  // "sessions": "launch" → the new-session form filled in; the user presses Start
workshop.sessions.paste(id, text)  // "sessions": "write" → type into a session
workshop.usage.get/watch           // "usage"             → costs and rate-limit windows, computed by core
workshop.door.handle(op, fn)       // "door"              → fn(args, caller, { session }) answers a Claude session
workshop.notify({ text, attention }) // "notify"          → needs-you chip, macOS notification, the mark flares
workshop.files.pick/list/entries/read/url/forget  // "files" → only what the user picked for this tile
workshop.music.get/watch/play/pause/toggle/next/previous/seek/setVolume/playUri  // "music" → Spotify or Music (bridge ^1.3)
workshop.oauth.redirectUri / authorize(url) / cancel()  // "oauth": [hosts] → a sign-in's callback query (bridge ^1.5)
workshop.media                     // "camera" / "microphone" → passed to the macOS prompt
workshop.backend.call(op, body) / status() / onStatus(fn)   // built-in tiles with a "backend" only (bridge ^1.2)
```

**Not in version 1: `workshop.model`.** A model call is the tile's own page asking an AI for
something with no session involved (the reader translating a sentence). That is the opposite
direction from a skill, where a session uses the tile. No launch tile needs it, so it was dropped
from v1 and returns with the reader, with a per-tile daily cap the user sets.

### Transcripts and the one manual check

Sandboxed tiles may ask for `transcripts` (built, bridge 1.7): the blocks a session tile draws
(prompts, prose, a line per tool call, the last 80), never the raw file, for a session's id only,
never a subagent's. It needs `sessions` too. The menu row and the install prompt give it a loud
line of its own (`TRANSCRIPTS_WARNING`). A tile that asks for BOTH `transcripts` and `net` gets a
manual review before it is listed, because that pairing is the only way a conversation can leave
the machine: `needsReview` in `src/shared/permissions.ts`, printed by `tile check` as `review` and
in `--json`. Everything else in the index stays automated.

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
| Spotify | Sandboxed | music (core drives Spotify.app and Music.app by AppleScript; art through the tile's origin); net and oauth for recent plays, playlists and search (Spotify's web API) |
| PS2 | Trusted | backend (PCSX2) |
| Git (core) | Trusted | backend (`git`, `gh`), sessions launch |

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

**Built (11 Nov 2026).** https://github.com/DoshaLabs/workshop-index holds `tiles.json`, a README
on how to submit, and a check (`.github/workflows/check.yml`) that runs on every pull request, on
main and weekly. It checks out workshop's main and bundles core's own code with esbuild
(`ci/core.ts`: `checkEntry`, `fetchCommit`, `checkTileFolder`, `permissionWords`), so the index
is checked by the code that reads and installs it, with nothing copied. Per entry: the entry's
rules, the pinned commit fetched as install fetches it, `tile check` as an outside tile, id,
version and permissions exactly tile.json's, every file the page names committed (nothing is
built on install). The summary lists each tile's permissions in words and, for an update, what
it now also asks for. `transcripts` with `net` fails until a maintainer adds the `reviewed`
label. A tile whose `workshop` range starts above core main's bridge is "waiting", not failed, if
its only errors are ones a newer core answers. Listed: Pomodoro
(https://github.com/DoshaLabs/workshop-pomodoro) and Spotify
(https://github.com/DoshaLabs/workshop-spotify, waiting for bridge 1.5; pull request 1 until
merged). Not built: the site,
the counter, CODEOWNERS.

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
  commands never block Claude (`curl -m 2 …; exit 0`), with two deliberate exceptions on
  `/ask/*`: PreToolUse, held only while the user has that session paused (the leash; unpaused it
  costs no request), and PermissionRequest, held until the tile or the terminal answers.
- **`--settings` merges** with the user's own settings, so their hooks keep firing. `statusLine`
  is a single object and would replace theirs, so ours posts the status JSON to core and then
  runs the user's own command on the same input.
- **The columns have jobs.** Left: sessions, most recently active first until the user drags them, nothing else.
  Right: tiles, draggable, each column its own endless scroll. Center: whatever you are on now.
- **Profiles.** The profile name is the tmux socket name and the settings folder name, with its
  own hook port, so a dev build never sees the installed app's sessions. A session working ON
  workshop can run the dev build inside the installed one. The installed app is `workshop`, `npm run dev` is `workshop-dev`, `WORKSHOP_PROFILE=<name>` is any
  other (install update is off there).
- **Dev and installed.** `npm run dev` hot-reloads the window and reloads dev tiles on save. The
  installed app updates itself from the repo it was built from: "Install update" builds it, swaps
  the bundle once the app has quit and relaunches; the tmux sessions are reattached.
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
- **`-webkit-app-region` is inherited**, and `none` is not a keyword Chromium takes: reset it with
  `initial`. A full-window fixed layer under `.app > *` silently made the whole window no-drag.
- **Keep this file small.** deck's CLAUDE.md grew to 175,000 characters, past Claude Code's
  150,000 limit. This file is loaded into every session: one screen per topic, details in
  `docs/`.

---

## 8. The status mark: the Knot, and sprite packs over it

**Decision (Colin, 10 Nov 2026): the Knot is the default status mark and the app's mark.** It
replaces Foxtrot out of the box. A sprite pack, Foxtrot included, is what a user may install over
it. The commissioned fox is no longer needed for launch.

### The Knot (built)

A (2,5) torus knot, the cinquefoil (Colin chose it on 10 Nov 2026 over the first (3,4), from a
gallery of fourteen curves), turning in 3D on a small 2D canvas, strands back to front, a bright pulse
riding the strand: workshop's own version of the "AlgoGlyph" in Colin's Cura app (a (3,5) knot
there; no code is shared). `src/shared/knot.ts` holds the curve, the status language and the
colour maths (pure, tested); `src/renderer/src/Knot.tsx` runs it. It sits in every session's head
where the dot was (`Mascot.tsx` falls back to it), and in the top left of the window, right of
the traffic lights (`AppMark`), where it is full size and quicker while any session works. Its
boxes (`BOX` in `knot.ts`) are measured against deck: at rest it stands as tall as Foxtrot (15
px in a 24 px box in a session's head), so the top bar is deck's 88 px (`--bar`) and the traffic
lights sit at deck's `{ x: 14, y: 37 }` (`docs/progress/2026-11-10-bar.md`). The top bar's mark
was then made 10% smaller (a 79 px box centred in the bar, about 50 px tall at rest) and turns
30% slower than a session's knot in the same mode (`MARK_PACE`; Colin, 11 Nov 2026).

| Status | Mode | Size | Loop | Frames/s | Colour |
|---|---|---|---|---|---|
| busy | work | 1 | 2.4 s | 30 | accent → busy |
| idle, unknown | rest | 0.8 | 22 s | 30 | accent → starting |
| needs you (blocked, or attention) | needs | 0.92 | 7 s | 30 | blocked → busy |
| starting | start | 0.86 | 5 s | 30 | starting → accent |
| dead | dead | 0.8 | still | 0 | dead → muted; the head dimmed |

Size changes ease over a few hundred ms in the same box. The strand thins with the radius, only
part of the way and never below a pixel, so a small knot stays a line. A call for attention flares the pulse and swells the knot once (0.9 s).

- **Colour is the theme's.** Every colour drawn is checked against the panel and the window's
  background and moved toward the ink until it reaches 3:1; far strands are pulled toward the
  panel, never made see-through (that washed out on light themes). `test/knot.test.ts` checks
  every variant, every mode, at rest and full size, in both boxes, with and without a flare.
- **The curve closes after P = 2 loops** (the spin turns half way per loop; the knot matches
  itself every fifth of a turn), so each knot's clock wraps at 2 loops and never jumps. A
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
subagent coat: its own sheet, or colours to swap, else `tintCoat`'s gold; with no pack, the Knot
wears it as a gold strand (`knotPalette(theme, mode, 'worker')`). Drawn on every pack tile. Calls for attention: a tile's `notify({ attention: true })` goes to the
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
| Hooks | Status (Notification, Stop, UserPromptSubmit), which session made a commit (PostToolUse on Bash), subagent tiles (SubagentStart / Stop), the leash (PreToolUse), permission prompts (PermissionRequest), session context (SessionStart) |
| `--plugin-dir` (repeatable) | Core's own skills, and each installed tile's `plugin/` folder |
| `statusLine` | The account's rate-limit windows and each session's context percentage |
| `--session-id` | Our own UUID, which is how hooks and poll rows are matched to a tile |
| `--worktree`, `--model`, `--permission-mode`, `--name` | The launcher's choices |
| The transcript JSONL | The conversation shown in tiles |

**What to build that the Claude app has and deck lacks:**

1. **Answer permission prompts from a tile.** Built (11 Nov 2026) on the `PermissionRequest`
   hook, not PreToolUse: on 2.1.322 it runs while the CLI shows its dialog, and whichever answers
   first wins (`decision.behavior` allow / deny). Verified by hand on the real CLI; not yet with a
   real session in the app (`docs/progress/2026-11-11-leash.md`).
2. A diff review pane (the git tile's Changes tab covers most of it).

### Codex (planned, `docs/progress/2026-11-11-codex.md`)

Codex is open source but we run it unchanged, as we run Claude Code. Its equivalents differ: no
id of our own (learnt from the app-server), no usable held PermissionRequest (it runs before the
dialog), no per-run plugin dir, no dollar cost. So a Codex session is the TUI with `--remote` on
an app-server of its own, both in the session's tmux, and core is a second client of that server
for status, approvals, items and usage. No Codex hooks (they need an internal trust hash).

### Bring your own model

- **Sessions:** a per-session provider profile sets environment variables such as
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
- **The leash's two choices**: a pause outlives core (quit with a session paused and its next
  call waits up to an hour), and Refuse keeps the session paused. Both are Colin's to confirm.
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
