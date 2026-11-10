---
name: wikipedia
description: Put a Wikipedia article, a search, or today's picture on the workshop's Wikipedia tile, beside the conversation. Use when the user asks to "show me X on Wikipedia", "look X up", "put the article up", or when an explanation would be better with the article beside it.
---

# The Wikipedia tile

Run these from the shell. The tile must be on in the workshop's right-hand column.

- `node "$WORKSHOP_TILE" wikipedia show <article title>`: shows the article's summary on the tile,
  prints its title, one-line description and URL.
- `node "$WORKSHOP_TILE" wikipedia search <words>`: lists matches on the tile, prints them.
- `node "$WORKSHOP_TILE" wikipedia today`: back to today's picture, prints its caption.

If the command says "turn on the Wikipedia tile", tell the user to add it from the column's `+`.
