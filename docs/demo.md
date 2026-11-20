# Hands-on demo — Liquid Engine on an online shop

About 10 minutes, fully offline. Two terminals. **A** runs the server, whose log shows every request and every JIT generation. **B** sends requests.

Offline, a cache miss "generates" `examples/<intent>.handler.js` instead of calling Claude. Everything else is the real system: the QuickJS sandbox, gatekeeper, invariants, SQLite, and the Gas → Liquid → Crystal ladder. Act 9 runs the same flow with a real LLM.

## 0. Setup

The code lives on branch `feat/shop-bench` (PR #4), not on `main`. Use its worktree. It already exists as `.worktrees/shop-bench`; otherwise create one with `git fetch && git worktree add .worktrees/demo origin/feat/shop-bench`.

```bash
# Terminal A — once
cd <slime>/.worktrees/shop-bench && bun install
export REPO=$PWD DEMO=/private/tmp/lee-demo   # scratch root: state/, handlers/, fixtures/, data/ land here, not in the repo
rm -rf $DEMO && mkdir -p $DEMO && cp -R intents examples $DEMO/ && cd $DEMO

# Terminal B — same variables, no reset
export REPO=<slime>/.worktrees/shop-bench DEMO=/private/tmp/lee-demo && cd $DEMO
```

**Terminal A**

```bash
PORT=3000 bun run $REPO/src/lee.ts serve --handler-dir examples
# lee serve on http://localhost:3000  runner: quickjs  gasTtlMs: 600000  promoteHits: 3
```

**Terminal B**

```bash
post() { curl -s -X POST localhost:3000/dispatch -H 'content-type: application/json' -d "$1" -w ' HTTP %{http_code}\n'; }
q()    { sqlite3 -header -column $DEMO/data/lee.sqlite "$1"; }
q "SELECT * FROM products"          # seed: 5 products for tenant 1, product 101 belongs to tenant 2
```

The dev session is fixed: tenant 1, user 42, role `user`. It comes from the server, never from the payload.

## 1. First request = JIT generation (Gas)

```bash
post '{"intent":"list_products"}'
```

- **A:** `⚙ JIT generate list_products (cache miss)…`, then `⚙ generated … 1 try input(s) passed`, then `→ 200 gas …`. The handler was verified on the spec's `try` inputs (on a seed copy) before it touched the real DB.
- **B:** 4 products. The sold-out hoodie (4) is filtered out, and tenant 2's product 101 is invisible: the kernel adds `tenant_id` to every read.

## 2. Buy something

```bash
post '{"intent":"place_order","payload":{"productId":1,"qty":2,"promo":"FALL10"}}'
q "SELECT * FROM orders"; q "SELECT id, name, stock FROM products WHERE id = 1"
```

- `order_total_cents: 3600` (2 × 2000 − 10%), `stock_left: 98`.
- `effectsApplied` shows what the handler *proposed*: one insert into `orders` and one update of `products`. The kernel validated and committed them; `tenant_id` was forced by the kernel.

## 3. The ladder: Gas → Liquid

```bash
for i in 1 2 3 4; do post '{"intent":"place_order","payload":{"productId":5,"qty":1}}' > /dev/null; done
ls state handlers fixtures/place_order; wc -l fixtures/place_order/*.jsonl
```

- **A:** `gas`, `gas`, `gas`, then `liquid`. After 3 reuses with 3 harness-passing runs, the handler is promoted and persisted.
- Files: `state/place_order.json`, `handlers/<hash>.js`, and `fixtures/place_order/<hash>.jsonl` with 4 recorded real runs.

## 4. Business rules and validation

```bash
for i in 1 2 3; do post '{"intent":"place_order","payload":{"productId":3,"qty":1}}'; done   # cap: stock 2
post '{"intent":"place_order","payload":{"productId":1,"qty":0}}'      # BAD_QTY
post '{"intent":"place_order","payload":{"qty":1}}'                    # no productId → PRODUCT_NOT_FOUND
post '{"intent":"place_order","payload":{"productId":101,"qty":1}}'    # tenant 2's product → PRODUCT_NOT_FOUND
```

- Cap: 200, 200, then **422 OUT_OF_STOCK**. Nothing is committed on a rejection (`q "SELECT COUNT(*) FROM orders"`).
- A missing `productId` no longer buys "the first product" (QA bug V2, fixed in the kernel).

## 5. Roles: rejected before anything is generated

```bash
post '{"intent":"restock","payload":{"productId":4,"qty":10}}'
post '{"intent":"restock","payload":{"productId":4,"qty":10}}'
```

- **403 ROLE_NOT_DECLARED**, with `tier: null`.
- **A** shows no `⚙ JIT generate` line: a forbidden caller never costs a generation (QA bug R2, fixed).

## 6. Attacks: malicious handlers vs the harness

The build path dry-runs a handler on the spec's `try` inputs and never commits. Feed it the attack files:

```bash
for a in forbidden_tenant read_undeclared delete_catalog infinite_loop host_escape; do
  echo "== $a"; bun run $REPO/src/lee.ts build place_order --handler-file examples/attacks/$a.js | grep -E 'REJECTED|BUILD' | head -2
done
```

| attack | rejected at | reason |
|---|---|---|
| `forbidden_tenant` — write into tenant 2 | gatekeeper | `FORBIDDEN_COLUMN` |
| `read_undeclared` — read other users' orders | sandbox | `READ_TABLE_NOT_DECLARED` |
| `delete_catalog` — delete products | gatekeeper | `WRITE_NOT_DECLARED` |
| `infinite_loop` | sandbox | `SANDBOX_TIMEOUT` (500 ms) |
| `host_escape` — `process.env` | sandbox | `HANDLER_ERROR` (`'process' is not defined`) |

For comparison, the honest handler passes: `bun run $REPO/src/lee.ts build place_order --handler-dir examples` → `BUILD PASS`.

Be honest about the limit: the gatekeeper checks *names* (tables, ops, columns), not *values*. A handler that sets `user_id: 999` or `price_cents: 1` on a declared column would pass (QA A13).

## 7. Restart, Crystal pin, tamper detection

Stop A with Ctrl-C and start it again with the same command. Then:

```bash
O='{"intent":"place_order","payload":{"productId":2,"qty":1}}'
post "$O"     # A: 200 liquid — survived the restart, no generation

# Crystal: a human pins the exact bytes in lee.lock (lee freeze is planned; do it by hand)
bun -e '
const s = JSON.parse(await Bun.file("state/place_order.json").text());
const specHash = new Bun.CryptoHasher("sha256").update(await Bun.file("intents/place_order.md").text()).digest("hex");
await Bun.write("lee.lock", JSON.stringify({ place_order: { intent: "place_order", handlerHash: s.handlerHash, specHash, frozenAt: new Date().toISOString() } }, null, 2) + "\n");'
post "$O"     # A: 200 crystal

# Tamper with the pinned bytes → refused, nothing committed
H=$(ls handlers); echo '// sneaky edit' >> handlers/$H
post "$O"     # 500 "handler bytes do not match hash …"
sed -i '' '$d' handlers/$H      # restore exact bytes
post "$O"     # 200 crystal again
```

## 8. Spec edit invalidates every tier

```bash
sed -i '' 's/capped at 50%/capped at 40%/' intents/place_order.md
post "$O"     # A: ⚙ JIT generate place_order … → 200 gas
```

The spec hash changed, so Crystal, Liquid and Gas recorded under the old hash are all ignored, and the next request regenerates. Offline, the "generator" returns the same file, so the hash and the 50% cap stay the same. With the LLM (act 9), the new handler follows the edited rule.

## 9. Same thing with a real LLM (needs `ANTHROPIC_API_KEY`)

```bash
export ANTHROPIC_API_KEY=...        # never commit it
export LIVE=/private/tmp/lee-live && rm -rf $LIVE && mkdir -p $LIVE && cp -R $REPO/intents $LIVE/ && cd $LIVE
PORT=3001 bun run $REPO/src/lee.ts serve      # no --handler-dir: cache misses call Claude
```

In B, send `post` requests to port 3001 instead of 3000 and repeat acts 1–4.

- The first request per intent shows `⚙ JIT generate …` taking **seconds**: one or more model round-trips, plus up to 3 repair rounds if the harness rejects a draft.
- Afterwards, `cat handlers/*.js` shows the code Claude wrote.

Manual build path: `bun run $REPO/src/lee.ts build place_order` prints the generated handler's dry-run effects and `BUILD PASS`.

## 10. Benchmark (optional, ~50 s)

```bash
cd $REPO && bun run bench/shop.bench.ts && open bench/RESULTS.md
```

## Cleanup

Ctrl-C the server, then `rm -rf /private/tmp/lee-demo /private/tmp/lee-live`.

## Cheat sheet

| HTTP | meaning |
|---|---|
| 200 | served; `tier` = gas / liquid / crystal |
| 403 | role not declared for this intent (checked before any generation) |
| 422 | rejected by the handler (business error) or the harness (sandbox / gatekeeper / invariants), with `stage` + `reason`; nothing committed |
| 404 | unknown intent / wrong route |
| 502 | JIT generation failed after 3 repair rounds; nothing cached |
| 500 | integrity error (tampered pinned bytes, corrupt `lee.lock`) |

Server env: `PORT`, `LEE_DB`, `LEE_GAS_TTL_MS` (default 600000), `LEE_PROMOTE_HITS` (default 3), `LEE_LOG=0` (silence the request log).
