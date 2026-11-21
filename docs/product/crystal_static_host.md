# Crystals & static hosting (S3 / plain HTML)

* **Date:** 2026-11-21
* **Status:** Design note — calling a Crystal endpoint from a static page.
  Vocabulary per [product_frame_v0_2.md](product_frame_v0_2.md) (2026-11-21
  calibration).

## Scenario and how it works

A developer (or their coding agent) crystallizes a proven Liquid handler into
a **Crystal** — frozen, deterministic code hosted by slime-cloud with its own
endpoint — and embeds it into any static page. No backend is written or
deployed by the user.

```
S3 / static HTML                    slime-cloud                       Linear/Postgres
  slc_ token + crystal key ─POST─▶  1. token valid?
                                    2. token scoped to this Crystal?
                                    3. run the FROZEN handler  ───────▶  source
                         ◀──JSON──  4. return only the handler's         (OAuth token lives
                                       shaped response                    here, encrypted)
```

### Crystal

A Crystal is frozen plain code with its own Crystal endpoint. Its **Crystal
key** is the core handler key: a hash of `KEY_VERSION`, the normalized intent,
the sorted input names and the output shape. It has no prefix and does not
include the schema hash, so it stays the same across migrations; it changes
when the key version, the input names or the output shape change.

Callers send only the input:

```
POST /v0/e/<crystal key>
x-api-key: slc_…
{ "input": {...} }
```

* Known key, exact input names → the frozen handler runs: deterministic code,
  zero model tokens.
* Unknown Crystal key or wrong token → 401 `UNAUTHORIZED` (the token is
  checked first); a token whose Crystal is not loaded yet (before the
  endpoint restarts) → `HANDLER_NOT_FOUND`.
* Missing or unknown input names → `INVALID_REQUEST`.
* Never a generation.

### Crystallize = freeze

Crystallize (admin today; `slime crystallize "<intent>"` later):

1. **Readiness:** needs a Liquid handler with at least 10 runs and current
   provenance (no generation step).
2. **Review:** review status `approved`, or `none` when review is off.
3. **Freeze:** an equivalence test on recorded inputs, then the code is
   frozen; the Crystal endpoint goes live after the endpoint restarts, and an
   `slc_` token is issued.

Re-crystallizing in place is not built (core answers `already` for a key in the
manifest); after a migration the Crystal must be removed first. Today that means
deleting the Endpoint, which also changes its URL and every `slc_` token, so the
page must be updated; the Crystal key itself comes back the same. `query` = "ask"
(may generate); `crystallize` = "freeze and give me a permanent address".

## slime CLI / MCP

**Planned; not built.** The v0 flow is admin-driven.

Core verbs: **`connect` → `query` → `crystallize`**. v0 demo needs five:
`login`, `connect`, `query`, `catalog`, `crystallize`.

### Account & sources

```bash
slime login                      # auth with slime-cloud
slime connect linear             # source OAuth; token stored encrypted in cloud
slime connect postgres <url>     # DB must be internet-reachable (v0)
slime sources                    # sources + schema fingerprint status
slime disconnect <source>
```

### Explore → crystallize

```bash
slime query "issues blocking the release"   # one-off call: generate or cache hit, shows meta
slime catalog                               # Liquid and Crystal intents: shape, cost, crystal key
slime crystallize "<intent>"                # Crystal + Crystal endpoint + slc_ token
slime crystallize --emit-html               # same + ready-to-paste <script> snippet
slime uncrystallize <crystal key>
```

### Inspection & keys

```bash
slime show <crystal key>         # handler code, source queries, shape, review status
slime logs <crystal key>         # calls (payload-free): status, latency, call cost
slime keys create <crystal key>  # issues an slc_ token
slime keys revoke <slc_…>
```

### Service / roadmap

```bash
slime mcp                        # MCP server for the agent: query / catalog / crystallize tools
slime status                     # cloud link, quotas, rate limits
slime export <crystal key>       # roadmap — Crystal export: handler as code into the repo
slime diff <crystal key>         # roadmap — what stale schema will break, before it breaks
```

MCP tools mirror the CLI (`query`, `catalog`, `crystallize`); internally every
call is the Dispatch Protocol v1 envelope (`{intent, input, output}`).

## S3 / HTML: embedding Crystals

User flow — **two steps**:

1. `slime crystallize "<intent>" --emit-html` → Crystal endpoint + `slc_`
   token + a ready `<script>` snippet.
2. Paste the snippet into the page, upload to S3 (or any static host). Done.

```html
<ul id="list">loading…</ul>
<script>
  // The ONLY thing in public static hosting. NOT a source token.
  const SLIME = {
    endpoint: "https://<endpoint URL>/v0/e/<crystal key>",
    key:      "slc_…",                  // scoped to this one Crystal
  };

  fetch(SLIME.endpoint, {
    method: "POST",
    headers: { "x-api-key": SLIME.key, "content-type": "application/json" },
    body: JSON.stringify({ input: {} }),
  })
    .then(r => r.json())
    .then(({ data }) => {                  // the route answers { data, meta }
      const list = document.getElementById("list");
      list.textContent = "";
      for (const i of data) {
        const li = document.createElement("li");
        li.textContent = `${i.id} — ${i.title}`;   // textContent, never innerHTML
        list.appendChild(li);
      }
    });
</script>
```

### Security by structure (light, deliberate)

Target audience does not need enterprise-grade auth; safety comes from the
Crystal design itself:

1. **No source tokens in the page.** Linear/Postgres OAuth tokens are
   encrypted, live only in slime-cloud, and never reach the browser.
2. **Own `slc_` token per Crystal, opens only its own route.** A leaked token
   runs that Crystal with any input values, not only the page's: for a Crystal
   with no inputs that is the same response the page shows; for one with
   inputs it is every row those inputs can select. Never make an identity
   (org, user) a Crystal input on a public page.
3. **Only the handler's shape leaves the platform.** No arbitrary queries, no
   raw source rows; the route rejects unknown input names and serves only the
   Crystal, so a public page can never reach the generator.
4. **Rate limit per token:** later.
5. Optional hardening (later): short-lived signed tokens; publishable `pk_`
   keys with an origin allowlist.
6. Browser calls need CORS on the runtime: not built (later).

Generation from a public page is impossible by construction: a Crystal is
frozen at Crystallize time from a handler that already ran.

## Impact on product frame v0.2

Aligned with frame decisions 5, 6 and 8 (2026-11-21 calibration): Crystal =
frozen code hosted with its own endpoint; the Dispatch Protocol v1 contract
field and contract ID are dropped.
