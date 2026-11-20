# Onboarding Castdev — derived from the spec (JIT Gas model)

**Date:** Nov 20, 2026 · **Branch:** `onboarding` · **Source of truth:** `architecture-spec.md` + `docs/plans/2026-11-20-gas-v0.md` @ `chore/gas-v0-plan`

> Iterative castdev *from the spec*: walk the onboarding developer through their first session and read
> off the real input/output contract at each point. **Corrected to the JIT model (gas-v0):** Gas is a
> *runtime* tier generated just-in-time on a cache miss and **serves live traffic in prod**, not a
> dev-only build artifact. All three tiers serve prod; they differ only in *which bytes run and how
> long they live*.

---

## The core principle (which I first got wrong)

**Safety comes from the harness, not the tier — the same set of checks runs on EVERY call of EVERY
tier, inside one transaction, and commits only if everything passed.** That is why freshly generated
code can serve prod immediately: it goes through the same sandbox + gatekeeper + invariants on the real
DB as a frozen handler.

A tier answers exactly one question: **which bytes run, and how long do they live.** It is a **cache by
provenance**, not a "dev → prod" ladder:

- **GAS** — "not in cache → generate it **right now**, verify, return the answer, keep it in memory for 10 min." Ephemeral.
- **LIQUID** — "this code has proven itself on repeated use → **persist it to disk**." Permanent, earned automatically.
- **CRYSTAL** — "a human pinned **these exact bytes**." Permanent, highest precedence, manual only.

Lookup order on every request: **Crystal → Liquid → Gas → (miss) → generate into Gas.**
The invalidation key is the **spec hash**: edit the description → every tier under the old hash is
ignored, the next request regenerates into Gas. The source of truth is always the human-written spec.

---

## Part 1 — Developer journey (JIT)

| # | Dev action | Dev input | slime output | Result |
|---|---|---|---|---|
| 0 | Write the operation spec | `intents/<name>.md` (roles/reads/writes/rule/invariants/`try`) | spec hash recorded | — |
| 1 | Connect DB | connection string + table schema | seed copy for checks; schema registered | — |
| 2 | Start serving | `lee serve` | listens on `POST /dispatch` | — |
| 3 | **First request (final input)** | **`PROMPT + JSON`** → `POST /dispatch {intent, payload}` | cache miss → **generates code on the fly** → verifies on `try` → runs the harness on the real DB → **commit + `200`**, code admitted to Gas | **GAS** (lives 10 min) |
| 4 | Repeat requests | same `PROMPT + JSON` | same code reused, TTL slides; every passing run recorded as a fixture | GAS → (×3) → **LIQUID** |
| 5 | Freeze (`lee freeze`, manual for now) | human commit to `lee.lock` | bytes pinned, highest precedence | **CRYSTAL** |

**The developer's final input = step 3:** the first `PROMPT + JSON`. In the JIT model this request is
what **gives birth to the code** — generation, verification and response all happen inside it.

### admin-panel (README TODO)
Observes steps 3–5: per intent — **current tier** (Gas/Liquid/Crystal), **request count**, **tokens
spent** (only at Gas generation; ordinary reuse never calls the LLM).

### Castdev findings
1. **"First request" now does double duty** — it both onboards and generates code. So the first response
   is **slower** (an LLM call inside it); the UX must show it ("preparing handler…"), otherwise the dev
   assumes it hung.
2. **Tokens are spent only on generation (Gas miss)**, not per request. The panel must label this as
   "build cost", or the dev expects a charge on every call.
3. **Code can "disappear" and rebuild.** Gas lives 10 min and only in memory — after idle or restart the
   next request regenerates. Expected, but warn the dev (the first request after a pause is slow again).
4. **Editing the spec resets the cache.** Change `intents/<name>.md` → the spec hash differs → all
   Gas/Liquid progress under the old hash is ignored and it regenerates. The onboarding hint belongs
   right next to the edit.

---

## Part 2 — Parameters from first principles

### 2.0 — Harness: the checks that run on EVERY call of EVERY tier (the safety core)

These are not one tier's parameters — they are the shared filter. Gas, Liquid and Crystal pass through
it identically, in one transaction: `role → BEGIN → sandbox → gatekeeper → invariants → (all ok? COMMIT : ROLLBACK)`.

| Parameter | In plain words | Why it must exist |
|---|---|---|
| Role is declared | code acts only as the declared role | otherwise it acts **as a role nobody allowed** (`ROLE_NOT_DECLARED`) |
| Sandbox time limit | pull the work if it didn't finish in time | fresh code could loop forever and **hang the request** (`SANDBOX_TIMEOUT`) |
| Sandbox memory limit | a slice of memory, no more | otherwise the code **eats memory** and takes down neighbor requests (`SANDBOX_MEMORY`) |
| Only `db.read`/`db.emit`, no host access | reads from an allowlist, only **proposes** writes | generated code **must not touch disk/network** or decide writes on its own |
| Only declared tables/ops/columns | nothing beyond the spec | otherwise code **reaches where access wasn't granted** (`WRITE_NOT_DECLARED`, `COLUMN_UNKNOWN`) |
| `tenant_id` forced | every write/where gets "whose tenant" glued on | without it one tenant **reads/edits another's data** |
| Forbidden columns rejected | `tenant_id`, `id` from the handler are **refused** (error, not silent strip) | silent fixup **hides the bug**; these columns are kernel-owned (`FORBIDDEN_COLUMN`) |
| Update/delete by full PK | only an exact row, by equality | otherwise one condition **wipes a batch of rows** (`PK_NOT_FULLY_ADDRESSED`) |
| Effect cap = 10 | one request changes < 10 rows | bound the **blast radius** (`EFFECT_CAP_EXCEEDED`) |
| Invariants = 0 rows | business rules ("no more than capacity") return zero violations | the rule is **above any code**, whoever generated it (`INVARIANT_VIOLATION`) |
| One transaction, commit at the end | apply effects and commit only if ALL layers passed | otherwise a **half-applied** state on a mid-way failure |

### 2.1 — GAS: JIT generation. Principle: *not cached → make it now, verify, serve, keep briefly.*

| Parameter | In plain words | Why it must exist |
|---|---|---|
| Generate on miss | no code → call the robot **on the fly**, inside the request | this is the essence: code is born from the first request, not ahead of time |
| Verify on `try`, not the live payload | judge correctness against the spec's examples | a live rejection (sold out, `BAD_QTY`) is **business logic, not a code bug**, and must not trigger regeneration |
| ≤ 3 repair rounds | failed 3 times → `502`, cache nothing | otherwise the robot **loops forever burning tokens** |
| Payload never in the prompt | the user request never enters the robot's text | protection from **injection** via request data |
| LLM call outside the transaction | generation finishes **before** `BEGIN IMMEDIATE` | you must not **hold a DB lock** during a slow, unpredictable call |
| Lives in memory, 10-min sliding TTL | every reuse extends its life; idle → eviction | weakly earned code is **not persisted**; keep hot, cheaper to rebuild cold |
| Restart = eviction | Gas only in process memory | honest ephemerality: after a restart the first request regenerates |

### 2.2 — LIQUID: auto-persist. Principle: *proven on repeated use → save it permanently.*

| Parameter | In plain words | Why it must exist |
|---|---|---|
| Threshold of 3 reuses **AND** 3 passing runs | promote from Gas only if called ≥3 times and all 3 passed the harness | popularity ≠ correctness: code that **fails on live traffic must not persist** |
| Written to disk (handler + fixtures + state) | the bytes, recorded examples and status saved to files | this is "permanent": survives restart, TTL removed |
| No TTL | not evicted by time | earned code shouldn't be rebuilt every 10 min |
| Hash check on load | `sha256(bytes)` must equal the recorded hash, else error | the file could be **corrupted/swapped**; pinned bytes must be exact |
| Bound to the spec hash | edit the description → old-hash files ignored (stale) | source of truth is the **description**; changed → old code no longer matches it |

### 2.3 — CRYSTAL: human pin. Principle: *a human pinned these exact bytes — highest precedence.*

| Parameter | In plain words | Why it must exist |
|---|---|---|
| Written to `lee.lock` by a human | `{intent, handlerHash, specHash, frozenAt}` pinned **manually** (`lee freeze`) | shipping the "main" version is a **deliberate human act**, not automation |
| Highest lookup precedence | checked first, before Liquid and Gas | an explicit human choice **overrides** any auto-cache |
| Exact-bytes check | like Liquid: the hash must match | pinned bytes must be **exactly** what was frozen |
| Corrupt lock → error (500), not silent fallback | if `lee.lock` won't read, fail loud, **don't** slide down to Liquid/Gas | a human pin **must not be silently bypassed** — that would hide a swap |
| Never automatic | Crystal is manual only | promotion to the "production reference" is always a human decision |

---

## Open questions
- [ ] DB connector v0 — supabase or raw postgres first?
- [ ] admin-panel — live during onboarding, or a dashboard afterward?
- [ ] Isolated sandboxes for prod (marked "planned") — needed by onboarding, or later?
