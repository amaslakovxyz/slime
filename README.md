# slime — Liquid Engine

Liquid Engine serves business intents (`intents/*.md`) through agent-generated handlers. On a handler-cache miss the handler is generated just-in-time and cached in memory as **Gas** (sliding TTL); after 3 reuses with 3 harness-passing runs it is promoted to **Liquid** (persisted in `handlers/`, `fixtures/`, `state/`); a human can pin exact bytes as **Crystal** in `lee.lock`. Every handler — fresh or cached — runs through the same harness: sandbox (QuickJS) → gatekeeper → invariants, inside one SQLite transaction.

## Run

```bash
bun install
bun test

# JIT serve (needs ANTHROPIC_API_KEY for cache misses)
bun run lee serve
# offline: every cache miss "generates" examples/<intent>.handler.js (book_ticket, place_order, list_products, restock)
bun run lee serve --handler-dir examples

# manual build path: generate (or read a file), dry-run the spec's try inputs, show effects; caches nothing
bun run lee build book_ticket [--handler-file examples/book_ticket.handler.js]
```

```bash
curl -s -X POST localhost:3000/dispatch -H 'content-type: application/json' \
  -d '{"intent":"book_ticket","payload":{"eventId":7,"qty":2,"promo":"FALL10"}}'
```

Environment: `PORT` (3000), `LEE_DB` (`data/lee.sqlite`), `LEE_GAS_TTL_MS` (600000), `LEE_PROMOTE_HITS` (3).

## Docs

- [Architecture spec](docs/architecture-spec.md)
- [v0 plan: JIT Gas ladder](docs/plans/2026-11-20-gas-v0.md)
