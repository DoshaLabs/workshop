# The Git tile, redesigned (14 Nov 2026)

Colin asked for the Git tile rebuilt with the features and look of the best Git clients. The design
was drawn first as a canvas (six artboards: tile, review, history, worktrees, PRs, the whole
window), then built.

## What was looked at

GitHub stars on 14 Nov 2026: lazygit 83.9k, delta 32.7k, jj 32.5k, gitui 22.7k, GitHub Desktop
22.1k, GitButler 22.0k, fugitive 21.8k, tig 13.4k, Git Extensions 8.6k, Magit 7.3k, SourceGit 6.5k,
Neogit 5.7k. Closed and loved: Fork, Tower, Sublime Merge, GitKraken. `gh search repos "git
client"` misses most of these (they do not call themselves that); they were looked up by name.

What was taken, and from whom:

| Idea | From | Where |
|---|---|---|
| Each line of work a lane, side by side | GitButler (its agents sorted into branches) | Lanes: a session's working tree, in its tile's colour |
| Review like a pull request: viewed ticks, a progress bar | GitHub | The review (pane) |
| Notes on lines, sent back as one message | New: a review of the agent | `sessions.paste`, `notesMessage` |
| Diffs that read: syntax colour, changed words, split view | delta, Fork | `dist/diff.js`, `dist/diffview.js` |
| Sidebar, file list, one diff, a toolbar | Fork, Tower, Sublime Merge | The whole window (overlay) |
| Every key shown; the git each action ran | lazygit, Sublime Merge | `#foot`, `cmdlog` |
| ⌘K, every action by name | Sublime Merge, Tower | The palette |
| A graph | Fork, GitKraken | Coloured by session, not branch: `dist/graph.js` |
| Search with tokens | Sublime Merge | `session:` `author:` `path:` `since:` |
| An operation log you can undo | jj, Magit, lazygit | `lib/oplog.mjs`, ⌘Z twice |
| Divergence from main as a bar | Fork | The Worktrees board |
| Pull requests and checks | GitHub Desktop | The PRs tab, through `gh` |

## Decisions made while building

- **Three sizes.** The column and the pane are each a third of the window (about 490 px), so the
  three-panel layout lives only in the overlay. The Git tile now asks for `overlay`.
- **Writes.** The tile now stages, discards, commits, pushes, pulls, fetches, stashes and opens
  pull requests (the design's open question 1; Colin said "implement it"). Rules in
  `lib/write.mjs`: never force, never reset --hard; discard, pull, stash and pop refused while a
  session in that tree is busy; staging and committing allowed (they touch the index and history,
  and git's index lock keeps them from racing a session's own git). A hunk is found again in git's
  own diff and must carry the header the page drew; hunk staging needs the file to have nothing
  staged, so its HEAD diff is its index diff.
- **Notes go through `sessions: "write"`** (open question 2), typed into the session as one
  message, at most 9,000 characters (core's paste takes 10,000).
- **Undo needs no refs** (open question 3 changed): a rebased branch's old tip stays in its reflog
  30 days, a merge's and a fast-forward's old tip is an ancestor, a commit's parent is reachable,
  a removed worktree's branch was merged, and a discarded file is written to the object database
  first (`hash-object -w`; pruned after two weeks). The log is `<common dir>/workshop-oplog.json`,
  14 days, 60 entries. An undo checks the repository is where the step left it.
- **Colours in every theme.** Core gained `--ws-yellow`, `--ws-blue`, `--ws-magenta`, `--ws-cyan`,
  `--ws-accent-ink` and a diff's backgrounds (`--ws-add-bg`, `--ws-del-bg`, `--ws-add-mark`,
  `--ws-del-mark`), solved per variant so text reads at 4.5:1 (`test/themes.test.ts`). Measured
  before: `--ws-accent` as text fell under 4.5:1 in 9 of 18 variants, and the terminal's yellow to
  2.2:1 on some light panels. Solarized light's ink is only 5:1 on its panel, so its word marks
  are as faint as its rows; changed words are underlined too, so they show in every theme.
- **Lane colour = the session tile's.** The window reports each tile's band (`setSessionBands`);
  tiles get it as `band` on `workshop.sessions` (bridge 1.11).

## Differences from the canvas

- A commit's details open under its row, not in a drawer at the foot (works the same in the column).
- No "Revert…" or "Compare with main" on a commit, and no "Branch" button: which worktree they
  would act in is not clear from History. Copy sha and Copy subject instead.
- "Ask a session to fix it" types into the session on that branch; with none there it opens the
  new-session form in that worktree (a tile cannot fill in a first prompt).

## Open

- Hunk staging for a file with part already staged would need the index diff, not HEAD's.
- Line-by-line staging (lazygit's) is not built.
- PR review comments from GitHub are not shown; only checks and the review decision.
