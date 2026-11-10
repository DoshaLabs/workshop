---
name: reminders
description: Write reminders, notes and accomplishments to the workshop's Reminders tile, filed by project (folder), from any session. Use when the user says "remind me", "don't let me forget", "add a reminder", "todo for later", "make a note", "note that", "log this", "what's on my list", "what did I get done", or asks you to mark a reminder complete. Also add one, unprompted, when something you find needs the USER to act later and it would otherwise be lost in this conversation, and say that you did.
---

# Reminders: the user's own list, by project

Run these from the shell. The tile must be on in the workshop's right-hand column.

```bash
R() { node "$WORKSHOP_TILE" reminders "$@"; }
R add "Rotate the Stripe test key" --priority high --due tomorrow
R add "Renew the domain" --project /Users/me/slay --detail "Registrar is Vercel; auto-renew is off."
R note "The staging DB is a copy from Oct 3"
R log "Shipped the export button"
R list                 # this project's open reminders, most important first (--all = every project, --done = with completed)
R notes                # this project's notes (--all, --limit N)
R history --limit 20   # this project's running log, newest first (--all)
R done r_ab12cd        # undo r_ab12cd takes it back the same day
R set r_ab12cd --priority low --due none     # also --text, --detail, --project
R rm r_ab12cd          # also takes a note's or a log line's id
```

Every command prints JSON, or a one-line error and exit code 1. Quote the text as one argument.

**The project** defaults to the folder this session was started in. `--project` takes an absolute
folder, or the folder name of a project the tile already has (`--project slay`). It does not take
`~` or a relative path: the tile cannot look at the disk.

**Priority:** `high` = has a deadline or a cost if missed soon; `normal` = the default; `low` =
worth keeping, no rush. Use the default unless you can say why. `--due` (`YYYY-MM-DD`, `today`,
`tomorrow`, `none`) only for a real date.

**What goes where:** a reminder is something the USER has to do later. A note is something worth
knowing, not an action. The log is work that got DONE. Completing a reminder writes its log line
itself, so do not also `log` it.

**This is the user's list.** Write one clear sentence they can act on without this conversation.
Only `done`, `set` or `rm` an item when they ask, or when it is one you added and you have finished
it. Do not add your own in-progress steps. Say what you added, in a line. Do not paste secrets.

If the command says "turn on the Reminders tile", tell the user to add it from the column's `+`.
