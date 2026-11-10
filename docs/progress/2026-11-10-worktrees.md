# The Git tile's Worktrees tab, and `sessions: "launch"`

10 Nov 2026. One agent's round on top of the Changes tab (`2026-11-10-git.md`). The tab, its
backend ops (one read-only diff, three writes), and a contract change for every tile: bridge 1.4,
`sessions: "launch"`. `npm run typecheck` clean; `npm test` 361 passed (33 files; new:
`test/git-worktrees.test.ts` 18, `test/launch.test.ts` 7); `npm run smoke` 344 passed, 0 failed
(18 new under `worktrees:` and `launch:`, one backend check widened for `status`).

## What was built, file by file

- `tiles/git/lib/worktrees.mjs` (new): reads and writes. `readProject(root)` lists every worktree
  (`git worktree list --porcelain -z`, now parsed whole by `parseWorktreeList`), finds main
  (`baseOf`), and for each worktree reads its status (the Changes tab's `status()`, nested
  worktrees dropped), ahead / behind (`rev-list --left-right --count <main>...<head>`), the paths
  its commits touch since the merge base (`diff --name-only <main>...<head>`), and when it was last
  touched. `diffAgainstBase` (read-only), `rebase`, `merge`, `remove`.
- `tiles/git/lib/parse.mjs`: `parseWorktreeList`, `pickBase`, `staleness`, `overlaps`,
  `shortPath`, `NOT_QUIET`. Pure, tested as shipped.
- `tiles/git/lib/git.mjs`: `git(cwd, args, { write: true })` drops `--no-optional-locks` and
  `GIT_OPTIONAL_LOCKS=0` and sets `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
  `GIT_MERGE_AUTOEDIT=no` (a write never waits on an editor nobody sees). `status` and `failure`
  exported.
- `tiles/git/backend.mjs`: ops `worktrees`, `diffmain`, `rebase`, `merge`, `remove`. Writes run
  one at a time; a second while one runs is refused, not queued.
- `tiles/git/tile.json`: 0.2.0, `"workshop": "^1.4"`, `sessions: "launch"`, the five new backend
  ops, `timeoutMs` 60,000 (a write may take 45 s before git is stopped and put back).
- `tiles/git/dist/` : `model.js` (`press` / `isArmed` / `ARM_MS`, `versusBase`, `dirtyLabel`,
  `actionsFor`, `filtered`, `projectOverlaps`, `STALE_WORDS`), `tile.js` (the tab), `tile.css`.
- Core: `src/shared/manifest.ts` (bridge 1.4.0, `LAUNCH_SINCE`, `sessions: 'read' | 'launch' |
  'write'`), `src/shared/permissions.ts` (the words), `src/shared/sessions.ts` (`LaunchPrefill`,
  `worktreeName`, `launchRequest`, `NewSessionOpts.worktreeName`), `src/shared/ipc.ts`
  (`tileSessionsLaunch`, `sessionsLaunch`), `src/preload/tile.ts` (`workshop.sessions.launch`, only
  present with the permission), `src/preload/index.ts` (`onLaunch`), `src/main/index.ts` (the
  handler; `status` to backends), `src/main/sessions.ts` (`--worktree=<name>`), `App.tsx` and
  `Sessions.tsx` (the `prefill` prop only, as the lead asked: no layout or CSS change).
- `src/main/backend-protocol.ts` / `backend.ts`: `BackendSession.status`.
- `template/CLAUDE.md`: the `sessions` row and `sessions.launch`.
- Tests: `test/git-worktrees.test.ts`, `test/launch.test.ts`, `test/backend.test.ts` and
  `test/manifest.test.ts` updated; `src/main/smoke-worktrees.ts` (new, one line in `smoke.ts`),
  `smoke-backend.ts` (a session as a backend sees it now has `status`).

## How the tab works

- **Which worktrees**: every worktree of each open session's project (`root`), not only the ones
  a session is in. A row: branch (or detached / bare), `main worktree`, `locked`, a stale tag;
  `↑2 ↓1 on main` / `even with main`; `clean` or `n changed` (untracked files included, nested
  worktrees not); the open sessions in it with their dots, or "no session"; the path, shortened:
  relative to the project root when inside it (`.claude/worktrees/side`), `~/…` under home, else
  whole.
- **Main**: `refs/remotes/origin/HEAD` when it exists (`origin/HEAD names X`), compared as the
  local branch X if there is one, else as `origin/X` (then read-only: rebase onto it works, merge
  is refused, there is nowhere local to merge); with no origin HEAD, a local `main`, then `master`.
  The project head says which and how.
- **Stale** (the filter): never the main worktree, the one main is checked out in, or one an open
  session is in. Otherwise `gone` (git lists it prunable), `merged` (on a branch, clean, ahead 0),
  or `untouched` (the later of its last commit and its index's mtime older than 14 days).
- **Overlap warning**: per project, each pair of worktrees whose changed paths meet. A worktree's
  changed paths are its uncommitted ones (status, both sides of a rename) plus its commits'
  since the merge base with main. Listed once per pair at the project's head, first 20 files.
- **Live**: a poll every 6 s while the tab is up and the page visible, and at once when a session
  opens, closes or changes status, and after every action. An open diff against main is fetched
  again when its worktree's head, main or dirty count moved.
- **Actions per row** (shown only where they could work; the backend checks everything again):
  Diff vs main (read-only, from the merge base to the working tree, tracked files, drawn with the
  Changes renderer), Open a session, Rebase, Merge, Remove. At the project head: New chat in a
  worktree. Rebase, Merge and Remove take two clicks: the first arms the button red ("Merge? Click
  again") for 3 s; the second within 3 s acts. Each row shows the last result, with the
  conflicting files when there were some.

## The writes, and what they refuse

Every write re-reads the worktree list and main right before acting; the page sends what it saw
(`expect: { head, base }`) and a change since is refused ("look again"). The page names a project
by a root core gave a session and a worktree by a path git lists for it; anything else is refused.

- **Rebase** `git rebase <main's oid>` in the worktree. Refused: detached, main itself, a session
  there busy / needs you / starting, uncommitted changes (untracked included), a rebase, merge,
  cherry-pick or revert under way. Already on top: nothing done, said so. A failure or conflict:
  the conflicting files are read, `git rebase --abort`, and checked; if it could not be undone the
  result says so and names the command.
- **Merge** `git merge --no-edit <branch>` in the worktree that has main checked out. If none
  does: "no worktree has main checked out…", nothing done. Refused also for a dirty or busy
  worktree on either side, a remote-only main, nothing to merge. A conflict: `merge --abort`, as
  above. Fast-forwards when it can (git's default; a user's `merge.ff` config applies).
- **Remove** `git worktree remove <path>` (no force) from the main worktree, then `git branch -d`
  where main is checked out. Refused: the main worktree, main's own worktree, any session core
  knows in it (open or parked, any status), locked, dirty, or a head main does not contain
  (`merge-base --is-ancestor`). If `branch -d` declines, the worktree is gone and the result says
  the branch was kept and why.
- Never `--force`, `reset --hard`, `branch -D`, push or fetch.

## The contract change: `sessions: "launch"` (bridge 1.4)

- **Name**: `"launch"`, a third value on the `sessions` ladder: `read` < `launch` < `write`, each
  taking the one before. Launching needs to know the sessions (read); a tile allowed to type into
  your sessions (write) is already trusted further than one that only fills in a form you must
  submit, so write includes it. A separate boolean would have allowed launch without read, which
  no tile could use.
- `workshop.sessions.launch({ folder, worktree? })`: `worktree` is absent, `true`, `{}` or
  `{ branch }`. Present only with `launch` or `write` (absent otherwise, not a rejecting stub).
- Core: the sender's checks as every bridge call; the level; the shape (`launchRequest`: an
  absolute path, `branch` a name `worktreeName` takes); **a real click or key in the page within
  5 s, used up by the call** (the overlay's rule, so a tile cannot take the center on a timer);
  the folder exists and is a directory. Then the window gets `{ cwd, worktree, branch?, nonce }`:
  the launcher takes the center (a pane, overlay, preview or mascot setup gives way), folder and
  worktree box filled in, the worktree's name shown as the session's name, Start focused. The user
  presses Start. No prompt, model or permission mode can come from a tile.
- **`branch` is the worktree's name, not git's branch**: `claude --worktree <name>` makes
  `.claude/worktrees/<name>` on branch `worktree-<name>`, so a tile can name it but not choose the
  exact branch. The launcher passes `worktreeName`; `sessions.ts` sends `--worktree=<name>` as one
  word (and bare `--worktree` before `--session-id`: before, a first prompt with no flag after it
  would have been read as the worktree's name).
- The manifest refuses `"launch"` unless the range's lowest version is 1.4 or later ("`launch` is
  bridge 1.4; set "workshop" to "^1.4""). Note: `overlay` and `music` do not do this today (a
  `^1` tile with `music` passes); worth making consistent.

## Backend protocol: sessions carry `status`

`{ id, name, folder, root, status }` (core's SessionStatus string). The Git tile's writes wait
out `busy`, `blocked` and `starting`. **"Needs you" was read as `blocked`** (a question or
permission prompt open), not core's `attention` flag, which is also set by every finished turn
not yet looked at: refusing on it would refuse almost every merge right after the session that
made the work stopped. Track B's notes and the protocol header should say the field exists.

## Not done, or not verified

- **Open a PR** is left for the PRs tab. `gh pr create --web` from an unpushed branch asks where
  to push, interactively; with no terminal it fails or would push, which is a write to the remote
  this round should not make. The PRs tab can push explicitly (never force) and then open it.
- The real `claude --worktree=<name>` was not run (fake-claude only). Commander takes
  `--opt=value` for an optional value; worth one real launch.
- The launcher's selectors the smoke uses (`.launcher input`, the checkbox, `button.primary`) will
  need updating with the lead's launcher redesign.
- Very large repositories: per worktree, a status, a rev-list, a name-only diff and a log per
  poll; not measured. Worktrees whose folders are gone are listed with a note, not pruned.
- Rebase and merge run the user's git hooks (pre-rebase, pre-merge-commit…) as git does.
- Writes are not cancelable from the page; a write past 45 s is killed and then aborted.

## Decisions for Colin

1. `sessions: "launch"` as a ladder step between read and write (above), gated on a real click.
2. `worktree.branch` names the worktree; the CLI's branch is `worktree-<name>`.
3. "Needs you" for writes = `blocked`, not `attention`; `starting` is also refused.
4. Remove refuses any session in the worktree, parked included, whatever its status.
5. Untracked files count as dirty (shown and refused), except nested worktrees.
6. Stale: no session and (gone, merged-and-clean, or untouched 14 days).
7. Merge fast-forwards when it can (git's default), no `--no-ff`.
8. Main: origin/HEAD, else local main, else master; local branch preferred for comparison.

## Lines for CLAUDE.md

Status line: bridge is 1.4. In "What exists", the `tiles/git/` bullet, replace "Worktrees,
History and PRs say "Coming"" with:

```
  Worktrees: every worktree of each open session's project, with its sessions, ahead / behind main
  (origin/HEAD, else main, else master), clean or dirty, a stale filter and a warning when two touch
  one file; diff against main, rebase, merge into main (where main is checked out) and remove once
  merged, each destructive one two clicks, refused while a session there is busy or the tree is
  dirty, a conflict aborted at once (`docs/progress/2026-11-10-worktrees.md`). History and PRs say
  "Coming".
```

After the bridge bullet ("`sessions.list/watch/paste`…"):

```
- `sessions: "launch"` (bridge 1.4; read < launch < write): `workshop.sessions.launch({ folder,
  worktree? })` opens the launcher filled in, Start focused, only from a real click in the page.
  It never starts a session or writes a prompt.
```

§5 "The bridge": add `workshop.sessions.launch({ folder, worktree })   // "sessions": "launch" →
the new-session form filled in; the user presses Start`. §5's contract table, Git row: "backend
(`git`), sessions launch". §4 Worktrees: append "(built; Open a PR waits for the PRs tab)".
