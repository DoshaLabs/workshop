---
name: changes
description: Show the user this session's changes (its branch, the files touched, the diff) in the workshop's Git tile, opened large in the center. Use when the user says "show me the diff", "show me what you changed", "let me review", "what did you touch", or when you finish a piece of work and the user should look over the changes before a commit.
---

# Show your changes in the Git tile

```bash
node "$WORKSHOP_TILE" git show
```

The Git tile opens as a pane with this session's working tree unfolded: its branch, every file
changed against HEAD (staged or not, untracked files included) with `+n −m`, and the diff. It
answers with JSON, e.g. `{"shown":true,"branch":"main","files":3,"add":12,"del":4}`, or
`{"shown":false,"why":"…"}` when this session is not working in a git repository.

The tile only shows; it never stages, commits or discards anything. Tell the user it is up and
what to look at. The tile must be on in the workshop's right-hand column; if it is off, the
command says to turn it on.

## Review notes from the user

The user reviews your changes in this tile and may send notes on lines back to you. They arrive
as one typed message starting "A review note on your uncommitted changes:" (or "N review notes …"),
each with `path:line`, the line it is on, and what to change. Treat them as the user's requests:
make the changes, then say which notes you addressed.
