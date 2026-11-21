# Crystals & static hosting (S3 / plain HTML)

* **Date:** 2026-11-21
* **Status:** Design note — extends [product_frame_v0_2.md](product_frame_v0_2.md).
  Renames `contractId` → **crystal** and adds the static-host consumption path.

## Scenario and how it works

A developer (or their coding agent) turns an intent into a **crystal** — a
frozen, reviewed, deterministic API handler hosted by slime-cloud — and embeds
it into any static page. No backend is written or deployed by the user.

```
S3 / static HTML                    slime-cloud                       Linear/Postgres
  pk_… + crystal id   ──POST──▶  1. key valid? origin allowed?
                                 2. key scoped to this crystal?
                                 3. run the FROZEN handler  ───────▶  source
                      ◀──JSON──  4. return only the contract's        (OAuth token lives
                                    shaped response                    here, encrypted)
```

### Crystal

A crystal is the fingerprint of a frozen contract: a 24-hex hash
`crystalKey(intent fingerprint, schemaHash)`, prefixed `cry_`. It is not a
database id — it is derived from the handler itself, so any change to the
handler or the source schema yields a different crystal.

Callers send it as `expect`:

```
POST /h/cry_7f3a9e   { "expect": "cry_7f3a9e", "input": {...} }
```

* Match → the frozen handler runs: deterministic code, zero model tokens.
* Miss → an explicit error, **never a regeneration**:
  `PIN_NOT_FOUND` (not pinned), `CONTRACT_DRIFT` (handler changed),
  `SCHEMA_STALE` (source schema changed).

Invariant (Dispatch Protocol v1): *a call that carries `expect` can never
reach the generator.* Analogy: `intent` is `package.json`, the crystal is
`package-lock.json`.

### Pin = freeze

`slime pin "<intent>"`:

1. **Generate** (if no handler exists): the model builds source queries +
   `shapeJs` against the real schema.
2. **Review:** the handler passes the review gate (background review,
   value-leak reject).
3. **Freeze:** the code is frozen, the crystal is computed, the endpoint
   `/h/{crystal}` goes live, a publishable key is issued.

Re-pinning produces a **new** crystal; consumers of the old one get an honest
error, never a silently different answer. `query` = "ask" (may generate);
`pin` = "freeze and give me a permanent address".

## slime CLI / MCP

Core verbs: **`connect` → `query` → `pin`**. v0 demo needs five:
`login`, `connect`, `query`, `catalog`, `pin`.

### Account & sources

```bash
slime login                      # auth with slime-cloud
slime connect linear             # source OAuth; token stored encrypted in cloud
slime connect postgres <url>     # DB must be internet-reachable (v0)
slime sources                    # sources + schema fingerprint status
slime disconnect <source>
```

### Explore → pin

```bash
slime query "issues blocking the release"   # one-off call: generate or cache hit, shows meta
slime catalog                               # reviewed handlers: intent, shape, cost, crystal
slime pin "<intent>"                        # review → crystal + endpoint + publishable key
slime pin --emit-html                       # same + ready-to-paste <script> snippet
slime unpin <crystal>
```

### Inspection & keys

```bash
slime show <crystal>             # handler code, source queries, shape, review status
slime logs <crystal>             # calls (payload-free): status, latency, call cost
slime keys create <crystal> --origin https://my.site
slime keys revoke <pk_…>
```

### Service / roadmap

```bash
slime mcp                        # MCP server for the agent: query / catalog / pin tools
slime status                     # cloud link, quotas, rate limits
slime export <crystal>           # roadmap — Crystal export: handler as code into the repo
slime diff <crystal>             # roadmap — what stale schema will break, before it breaks
```

MCP tools mirror the CLI (`query`, `catalog`, `pin`); internally every call is
the Dispatch Protocol v1 envelope (`{intent, input, output}` + optional
`expect`).

## S3 / HTML: embedding crystals

User flow — **two steps**:

1. `slime pin "<intent>" --emit-html` → endpoint + publishable key + a ready
   `<script>` snippet.
2. Paste the snippet into the page, upload to S3 (or any static host). Done.

```html
<ul id="list">loading…</ul>
<script>
  // The ONLY thing in public static hosting. NOT a source token.
  const SLIME = {
    endpoint: "https://api.slime.cloud/h/cry_7f3a9e",
    key:      "pk_live_a81c…",          // publishable, scoped, safe to expose
  };

  fetch(SLIME.endpoint, {
    method: "POST",
    headers: { "Authorization": "Bearer " + SLIME.key },
    body: JSON.stringify({ expect: "cry_7f3a9e" }),
  })
    .then(r => r.json())
    .then(rows => {
      const list = document.getElementById("list");
      list.textContent = "";
      for (const i of rows) {
        const li = document.createElement("li");
        li.textContent = `${i.id} — ${i.title}`;   // textContent, never innerHTML
        list.appendChild(li);
      }
    });
</script>
```

### Security by structure (light, deliberate)

Target audience does not need enterprise-grade auth; safety comes from the
pinned design itself:

1. **No source tokens in the page.** Linear/Postgres OAuth tokens are
   encrypted, live only in slime-cloud, and never reach the browser.
2. **Publishable key, scoped to one crystal** (+ origin allowlist). Leaking it
   only lets someone replay the same reviewed, shaped response the page
   already shows.
3. **Only the contract's shape leaves the platform.** No arbitrary queries, no
   raw source rows; the generator is unreachable from a public page
   (`expect` miss = error).
4. **Rate limit per key**; call cost is reported in `meta`.
5. Optional hardening (not v0): short-lived signed tokens instead of a static
   publishable key.

Generation from a public page is forbidden by construction: generation happens
only at pin time, under review.

## Impact on product frame v0.2

* Decision 6 is reframed: **Crystal = the frozen contract.** v0 hosts it in
  slime-cloud; `slime export` (roadmap) takes it as code into the client's
  repo. One metaphor instead of two.
* The `crystal` naming replaces `contractId` in product language; protocol
  field stays `expect`. (Naming is one of the six open Dispatch Protocol v1
  questions — confirm with the team.)
