---
name: helper
description: Hand a self-contained piece of work to a helper session, a background session of your own that works beside you in workshop (shown under this session, its conversation live) while you carry on, then collect its answer. Use when the user asks for work to be done "in the background", "in parallel", "by a helper", or when a long side task (a research sweep, a test run and fix, a second opinion) would hold up the conversation. Not for a quick lookup: a subagent is cheaper. The CLI is `node "$WORKSHOP_HELPER" start "<prompt>"`.
---

# A helper session

```bash
node "$WORKSHOP_HELPER" start --name "fix flaky test" "Run npm test until it is green; the failure is in test/parse.test.ts. Report what you changed."
node "$WORKSHOP_HELPER" list                 # [{ id, name, status: working | finished | needs you | stopped }]
node "$WORKSHOP_HELPER" wait h1a2b3c         # blocks until it finishes (10 minutes at most; --timeout <s>), then { …, result }
node "$WORKSHOP_HELPER" result h1a2b3c       # what it said last, without waiting
node "$WORKSHOP_HELPER" stop h1a2b3c         # stop it; its conversation is kept
```

A helper is Claude Code's own background session (`claude --bg`), started in your folder with
your permission mode and, unless you pass `--model`, your model. It does not see this
conversation: write the prompt as a complete brief (what to do, where, what "done" means, what to
report). It runs on its own; you can carry on and `wait` for it later.

- It shows in workshop under this session, in the worker coat, with its conversation live. The
  user can stop it there.
- At most 8 of yours work at once.
- If it reaches a permission prompt it waits ("needs you"): the user answers it with
  `claude attach <id>` in a terminal. Prefer briefs that need no new permissions.
- Two helpers editing the same files will collide: give each its own files, or ask for a report
  instead of edits.
- Outside workshop this does not exist; say so and do the work yourself.
