# The work list

Rewritten 10 Nov 2026, late, after phases 1 (first round) and 2 landed. `CLAUDE.md` is the
design; this file is what is left, in the order to build it. Section numbers (§) are
`CLAUDE.md`'s. Sizes: S = under a session, M = one session, L = several.

## Done so far

- The sandbox and tile contract (§5): storage, sessions, usage, door, notify, files, the overlay
  view, core's fonts. Not yet: `transcripts`, the trusted tier.
- Tiles: Wikipedia (deck's, with clock, weather, lightbox) and Reminders.
- Sessions: the real CLI in tmux, conversation tiles, context and cost on each, the usage meters,
  ⌘1–9 / ⌘[ ⌘] / ⌘N, park and resume.
- The status mark: the Knot by default, sprite packs over it, the setup screen, Foxtrot's mapping.
- The tile column: four rows, ↕, the `+` cell with "make one with Claude", dev tiles remembered.
- Themes, fonts (Nunito, JetBrains Mono, Source Serif 4), `npm run dev`.
- Round 3 (10 Nov 2026, three agents; notes in `docs/progress/2026-11-10-track-{a,e,f}.md`):
  track A (the three-tab menu), D1 (`tile check`), D2 (install, update, remove), the first half
  of E (preview pane with clickable paths and `$WORKSHOP_DOC`, drag to reorder, image paste) and
  F's rename (`attention`), storage fix, repo root, and the never-exercised list except camera and
  microphone. Not verified by hand: install from GitHub over https, "load a folder", a real drag,
  a Finder drop, a pasted image reaching the real CLI.

## Track A: the tile menu becomes three tabs (M)

The `+` cell's menu (`TilePicker.tsx`) is one list today. It becomes:

| Tab | What is in it | Source |
|---|---|---|
| **Built in** | Tiles that ship with workshop: Wikipedia, Reminders, Git, later Files and Spend | `tiles/` in the app |
| **Yours** | Tiles you are building or loaded from a folder; "make one with Claude"; "load a folder"; stop loading | `settings.devTiles` |
| **Marketplace** | Tiles from the index: name, author, hint, permissions, install / update / remove | the index (track D) |

- A tile's row shows the same things on every tab: icon, name, hint, its permissions in plain
  words, and whether it is on.
- Marketplace before the index exists: the tab is there and says what it will hold. It must not
  be a dead end once track D lands, so build it against the index's file format from the start.
- This reverses one line of the old plan: Wikipedia and Reminders stay built in. They are still
  written the author's way (ground rule 9), they just ship in the app.

## Track B: the trusted tier (M) · §5 · built 10 Nov 2026 (`docs/progress/2026-11-10-track-b.md`)

Blocks Git and PS2. **Agreed by Colin, 10 Nov 2026**, as written here:

- A trusted tile adds `backend.mjs`. Core runs it as its own process (Electron `utilityProcess`),
  started when the tile is turned on and stopped when it is turned off or core quits.
- The page calls `workshop.backend.call(op, body)`; core passes it to the backend and the answer
  back. The page stays in the sandbox: only the backend has the machine.
- The manifest declares `"backend": { "entry": "backend.mjs", "ops": [...] }`. Undeclared ops are
  refused by core before they reach the backend, as with the door.
- The backend is told which session folders exist (it needs them for git) but gets no session
  tokens and cannot type into a session.
- At launch only tiles on the **Built in** tab may have a backend. An installed or local tile
  that declares one is refused, with the reason shown. Opening it to others comes with the
  review process and the "full access" badge (§5), later.
- One process per tile. A backend stops when its tile is turned off; there is no background flag
  (Colin, 10 Nov 2026).

## Track C: the Git tile, written fresh (L) · §4 · Changes built 10 Nov 2026 (`docs/progress/2026-11-10-git.md`)

Not a port of deck's `git.ts`. Built in, trusted tier, on the contract, from the starter.

1. **Changes**: every open session by project; a line each with branch, files touched, `+n −m`;
   click to unfold the diffs.
2. **Worktrees**: a row per worktree with its session, branch, ahead / behind main, dirty or
   clean; open a session there, diff against main, rebase, merge, open a PR, remove once merged;
   a stale filter; a warning when two worktrees touch one file; "new chat in a worktree".
3. **History**: the log across branches, each commit tagged with the session that made it; a
   "what did Claude do today" filter.
4. **PRs and CI**: your open pull requests and their checks, through `gh`.

Rules carried from §4: destructive actions are two clicks (the first arms the button red for
three seconds); never force-push; every poll runs with `GIT_OPTIONAL_LOCKS=0` so it never fights
Claude for the index lock. Order: Changes first (it is the diff review pane §9 asks for), then
Worktrees, History, PRs. Needs from core: sessions' folders (`sessions: read` has them) and
which session made a commit (new: core records each session's commits, or the backend matches
by time and worktree; decide while building).

## Track D: the marketplace, smallest version that works (L) · §6

1. `workshop tile check <folder>`: the validator from the shell. Authors, the Claude building a
   tile, and the index's CI all need it. (S)
2. Install, update, remove: a tile cloned at a pinned commit into userData `tiles/`; the
   permission prompt on install and again when permissions change; storage kept or deleted on
   remove. (M)
3. The index: a repo with `tiles.json` (id, repo, pinned commit, permissions, category, author)
   and CI that runs `tile check`, confirms nothing is built on install, flags permissions, and
   routes transcripts-plus-network to a person. Core reads it over https. (M)
4. The Marketplace tab reads the index and installs from it. (S, on track A)
5. Seed it with one tile of ours built outside core (a focus timer made with "make one with
   Claude" is the obvious first), so the whole path has been walked once.

Later, only when strangers are submitting: the static site, the install counter and rankings,
profiles (optional sign-up, never required; to decide: what one holds, GitHub sign-in or not),
sprite packs as a second category, the tile template as its own repo with `npm create`.

## Track E: the rest of sessions (L) · §7, §9

| Piece | Size |
|---|---|
| Preview pane: read, tick boxes, edit a file a session points at; file paths in a conversation become clickable | M |
| Subagent and helper-session tiles with pause and kill (wolfpack); the worker coat finally drawn | L |
| The leash: PreToolUse held at `/pretool` | M |
| Permission prompts answered from a session's tile (verify the route first; the biggest gap against the Claude app) | M |
| Drag to reorder tiles, both columns | S |
| Image paste into a tile's prompt bar | S |
| `workshop.sessions.transcript` and the `transcripts` permission, with its loud prompt | M |

## Track F: loose ends and things only half done (S each)

- Nobody has clicked through the app by hand since phases 1 and 2. Do that first.
- A real Claude has never built a tile through "make one with Claude".
- "Bark" is deck's word and means nothing to a tile author. Rename it in the contract to
  `notify({ text, attention: true })` (Colin, 10 Nov 2026) before anyone outside uses it.
- `workshop.storage` starts empty over a store it cannot parse; it must move the file aside.
- A project is the session's start folder, not its repo root: core should resolve the root once
  and report it in `workshop.sessions` (Reminders files by it; Git needs it).
- Never exercised: sessions surviving a restart and a reboot, the WebRTC and DNS side doors,
  camera and microphone, reduced motion, the Knot's clocks stopping in a hidden window, a very
  long transcript's first read.
- A type scale as variables; a font setting beside the theme picker; Glass's picture wall.
- The two agent worktrees under `.claude/worktrees/` can be removed.

## Track G: the other promised tiles · §3

| Tile | Tier | Waits on |
|---|---|---|
| Spend / usage | Built in, sandboxed | nothing |
| Files (a directory tree) | Built in, sandboxed | nothing |
| Web-app tiles (a site by name and URL) | Core | a decision: how a site fits the sandbox |
| Posture | Marketplace, sandboxed | camera tested; install |
| Game Boy, PS1 | Marketplace, own repos | install; the GPL core stays out of this repo |
| Spotify | Marketplace, sandboxed | the `music` permission (Colin, 10 Nov 2026: Spotify is built the author's way, as anyone could, not as a trusted tile); Colin builds it with "make one with Claude" |
| PS2 | Trusted | the trusted tier opened beyond built-ins |

## Track H: something a stranger can install (M) · §10

Packaging (electron-builder; `tmux.conf`, the door CLI, `tiles/`, `template/`, `assets/` as
`extraResources`), the install script, the tutorial session on first launch, `README`,
`LICENSE`, bring-your-own-model provider profiles.

## Order

Next: **B then C** (the trusted tier, then Git, Changes
tab first), beside **D3–D5** (the index and the Marketplace tab live). Then the second half of
E (wolfpack, leash, permission prompts), G's two sandboxed built-ins, and H.

## Decisions that are Colin's

- The name and home of the index repo, and the public name of the app (it also names the bridge
  and the template's package).
- Whether permission prompts can ride the PreToolUse route (verify, then choose the UI).
- How web-app tiles fit the sandbox.
- Profiles: what they hold and how sign-in works.
