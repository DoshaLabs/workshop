# What is missing, and the order to build it

Written 10 Nov 2026, after the second build session. `CLAUDE.md` is the design; this file is the
gap between it and the code, as a work list. Section numbers (§) are `CLAUDE.md`'s. Sizes are
rough: S = under a session, M = one session, L = several.

## Where things stand

Built: the sandbox and most of the tile contract (§5), themes, sessions as terminals (§7), the
Wikipedia and Reminders tiles, the `+` menu with "make one with Claude", `workshop tile dev`.

The three things that make workshop feel unlike deck today:

1. **A session is only a row and a terminal.** deck shows every session as a live conversation
   tile, with status, context and cost on it. Workshop computes context % and cost per session
   (`usage.ts`) and shows neither anywhere; the top bar's 5-hour and weekly meters are hidden
   until a session has reported, so a fresh window shows no usage at all.
2. **No mascot.** No sprite-pack format, no setup screen to drop a sheet into, no Foxtrot mapping,
   no pose on a session's head. Status is a dot.
3. **Nothing can be installed.** Not the app (no packaging), not a tile (no install, no index).

## Phase 0: land and verify what exists (S)

- Commit the second session's work.
- A person clicks through the app: launcher, theme picker, `+` menu, ↕, tabs in Reminders, the
  Wikipedia lightbox, drag-select in a terminal.
- A real Claude builds a tile through "make one with Claude" (so far only the stand-in has).
- Tests for what was never exercised: the real fleet poll, sessions surviving a restart and a
  reboot, the WebRTC and DNS side doors, camera and microphone.
- `workshop.storage` must move an unreadable store aside, not start empty over it.

## Phase 1: sessions as deck has them (L) · §7, §9

The daily experience. Until this is done Colin cannot move from deck to workshop, and nothing
else gets used for real.

| Piece | From deck | Size |
|---|---|---|
| Context % and cost on each session's row; usage meters always present (empty until known) | `usage.ts` data exists | S |
| Session tiles: the conversation, not a terminal, for every unfocused session | `transcript.ts`, `ChatView` | L |
| `workshop.sessions.transcript` + the `transcripts` permission and its loud prompt | same tailer | M |
| Subagent and helper-session tiles with pause and kill (wolfpack) | hooks, sidecar reading | L |
| The leash: PreToolUse held at `/pretool` | `hooks.ts` | M |
| Permission prompts answered from a tile (the biggest gap against the Claude app) | new; verify the route first | M |
| Preview pane: read, tick boxes, edit a file a session points at | deck's pane | M |
| Keyboard shortcuts (⌘1–9, ⌘[ ⌘], ⌘N), drag to reorder tiles, image paste into a prompt | deck | M |
| Tile column state (`off`, `extra`, `span`) into core's settings, out of `localStorage` | | S |

## Phase 2: the mascot (M) · §8

Independent of everything else; can run beside phase 1. **Done 10 Nov 2026**
(`docs/progress/2026-11-10-phase2.md`), with Colin's change of the same day: the Knot, not a dot
or the fox, is the default mark.

- [x] The Knot: the default status mark on every session and the app's mark, themed, tested for
  contrast in every theme.
- [x] The sprite-pack format: a PNG plus JSON mapping each state to a row or run of frames and a speed.
- [x] The setup screen: drop a PNG, guess the grid, map states with a live preview, save.
- [x] The Foxtrot mapping for Elthen's sheet (our data, not his art), the link to his page, the
  credit and licence lines. No sheet in the repo, no fetching it for the user.
- [x] The pose on every session head (idle, look around, run, leap, sleep); the Knot when no pack
  is installed; `notify({ bark })` wired to the leap and the Knot's flare.
- [x] The worker coat as a tested tint and a pack field (drawn nowhere until subagent tiles exist).
- [ ] ~~Commission the owned fox~~: no longer needed for launch (§8).

## Phase 3: finish the author's path (L) · §5, §6

Ground rule 9 says our own tiles walk this path, so it has to exist end to end.

- `workshop tile check <folder>`: the validator from the shell, for authors, for the Claude
  building a tile (which cannot see the window), and for the index's CI. (S)
- Install, update, remove: a folder into userData `tiles/` at a pinned commit, the permission
  prompt on install and again when permissions change, storage kept or deleted on remove. (M)
- The trusted tier: design `backend.mjs` with Colin first (process model, what it may be asked,
  the louder prompt), then build it. Git, Spotify and PS2 wait on this. (L)
- The tile template as its own repo with an `npm create` script; `template/` here is its seed. (S)
- Move Wikipedia and Reminders out of core into their own repos, installed like anyone's. (S)
- A flag-parsing helper for door ops in the template (every tile with options rewrites it). (S)

## Phase 4: the tiles the plan promises (L) · §3, §4

Each is its own track once phase 3's pieces it needs exist. Sandboxed ones can start now.

| Tile | Tier | Waits on |
|---|---|---|
| Spend / usage | Sandboxed | nothing (`usage` exists) |
| Files (a directory tree) | Sandboxed | nothing (`files` exists) |
| Web-app tiles (a site by name and URL) | Core | a decision: how a site fits the sandbox |
| Posture | Sandboxed | camera permission tested |
| Game Boy, PS1 | Sandboxed, own repos | install; the GPL core stays out of this repo |
| Git (four tabs) | Trusted, core | the trusted tier |
| Spotify | Trusted | the trusted tier |
| PS2 | Trusted | the trusted tier |

## Phase 5: something a stranger can install (M) · §10

- Packaging: electron-builder, `tmux.conf` / the door CLI / `tiles/` / `template/` as
  `extraResources` (they are read from inside the asar today), icon, entitlements, signing.
- The install script (macOS, tmux, a logged-in `claude`).
- First launch: the tutorial session, built on "make one with Claude" with a focus timer.
- `README` (macOS, Claude Code, how to build a tile) and `LICENSE`.
- Bring your own model: per-session provider profiles (`ANTHROPIC_BASE_URL` and friends).
- Glass's picture wall.

## Phase 6: the marketplace (L) · §6

Only worth starting when phases 3 and 5 are done: nobody can install from an index into an app
that cannot install tiles or be installed itself.

1. The index repo: `tiles.json`, CI that runs `tile check`, flags permissions and routes
   transcripts-plus-network to a person.
2. The Browse tab in the `+` menu, reading the index.
3. The static site.
4. The install counter (tile id only, can be turned off), then rankings.
5. Profiles: optional, never needed to write, share or submit a tile. To decide: what a profile
   holds, and whether sign-in is GitHub's.
6. Sprite packs as a second category.

## Order, and what can run at once

0 first. Then 1 and 2 side by side (different files), with phase 3's `tile check` and install
slotted in early because they are small and unblock phase 4's sandboxed tiles. The trusted tier
needs a design conversation before any code. 5 before 6.

Decisions that are Colin's and block work:

- The trusted tier's design (blocks git, Spotify, PS2).
- Whether permission prompts can ride the PreToolUse route (verify, then decide the UI).
- How web-app tiles fit the sandbox.
- The public name (blocks the template's package name and the bridge's name).
- Profiles: what they hold and how sign-in works.
