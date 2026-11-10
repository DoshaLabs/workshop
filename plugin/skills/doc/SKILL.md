---
name: doc
description: Open a file in workshop's preview pane, the center column, where markdown renders, `- [ ]` task boxes are clickable and save to disk, and an edit toggle makes any text file editable in place (⌘S saves). Use INSTEAD OF macOS `open` whenever the user should read, tick off or edit a file: "open the checklist", "show me the notes", "let me edit that", or after you write a plan, checklist or notes file they will work through. The CLI is `node "$WORKSHOP_DOC" open <path> [--line N]`.
---

# Put the file in front of them, in workshop

```bash
node "$WORKSHOP_DOC" open notes/checklist.md            # relative to your cwd; ~/ and absolute work too
node "$WORKSHOP_DOC" open src/main/index.ts --line 120  # scrolled to line 120, which is marked; path:120 works too
```

It prints JSON, `{ "path": …, "kind": "markdown", "editable": true }`, once the file is up.
On a refusal (no such file, not inside workshop) it says why on stderr and exits 1.

**Use this, not `open`, for a file the user should read or edit.** `open` sends a `.md` to
whatever app macOS picked, away from workshop. The preview pane is where they already are.

What they get there:

- Markdown rendered (a `source` toggle shows it as written); code and plain text in a mono face
  with line numbers.
- `- [ ]` / `- [x]` items are checkboxes: a click rewrites that one character on disk and
  nothing else, so a checklist you write is one they can tick off.
- `edit` turns the file into a plain editor; ⌘S saves.
- If the file changes on disk while it is open, the pane reloads it, unless they have unsaved
  edits: then it says so and leaves their edits alone. So tell them before you rewrite a file
  they are editing.

Folders, binaries and files over 2 MB are refused politely; use `open` for those, or when the
user asks for a particular app.
