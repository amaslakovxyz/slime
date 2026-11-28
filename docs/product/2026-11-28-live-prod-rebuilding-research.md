# Live Prod Rebuilding: Production as the Verifier for Slime Crystal

* **Date:** 2026-11-28
* **Author:** amaslakov
* **Status:** Research. This is not a plan, and nothing here is built.
* **Visual companion:** [2026-11-28-live-prod-rebuilding-research.html](2026-11-28-live-prod-rebuilding-research.html)
  (open it in a browser; it has the diagram, the prior-art table and the review)
* **Primary source:** Anthropic, *Migrating our Messages API to Rust*,
  <https://www.anthropic.com/research/migrating-api-to-rust> (published 2026-11-25, fetched 2026-11-28)

## Abstract

Anthropic moved its Messages API from Python to Rust while it kept serving
traffic. Its test suite could not prove the two versions behaved the same, so
the team made production the verifier. Each request was shadowed through both
versions, every difference was recorded as a fingerprint with no user content,
and agents fixed the differences inside three verification loops. This paper
asks whether Slime can make the same thing a product. Slime would sit next to a
live service at the load balancer, read its requests and responses, and grow
the service again through Gas → Liquid → Crystal, with production as the
oracle.

We find the idea is worth building **only in narrowed form**: a shadow
verifier for read-only endpoints, run inside the client's network, that is
given the service's source code. The unrestricted version, a "copy of any
backend" learned from traffic alone, fails for one structural reason.
Anthropic *ported* code it already had. A listener with no source code would
have to *infer* the logic from examples, and that guarantees parity only on
the traffic it has already seen. An adversarial review raised nine objections.
Three survive, one is deferred and five are answered.

## 1. Problem

Tests do not capture what a production service really does.

* A test suite covers the combinations someone thought of. Production users
  rely on edge cases and quirks outside it.
* Porting the tests along with the code makes them unreliable as judges:
  Anthropic found more than 100 weakened assertions in its ported tests.
* With AI writing most of the code, the bottleneck has moved from generation
  to verification. The more cheaply code can be checked, the more ambitious a
  migration can be.

The question for Slime: can the production service itself become the source
of test cases and the definition of "correct" for a generated replacement?

## 2. Background: what Anthropic did

Numbers are from the source post.

| Fact | Value |
|---|---|
| Traffic growth, early 2024 to fall 2026 | about 1,800× |
| Existing integration tests | about 700 |
| Rust tests passing vs production inputs matching (April) | about 98% vs about 25% |
| CPU per request after the move | about 70% lower |
| Median time to first token after the move | about 20% lower |
| Public traffic on Rust | September 2026 |

**Shadowing.** Requests ran through both versions. The model ran *once* and its
output was replayed into Rust, which removed model nondeterminism and kept
billing and rate limits from counting a request twice.

**Checkpoints and fingerprints.** Both versions handle a request in the same
steps (accept or reject, resolve settings, build the prompt). Each step was
compared, and the first one that differed showed roughly where the bug was. A
fingerprint (step, prompt piece, first differing byte, both lengths) told one
bug from another without anyone reading user content:

```text
step:        build prompt
piece:       2
first diff:  byte 17
python:      190 bytes
rust:        190 bytes
```

**Loops.**

1. *Grouping.* Every 10–30 minutes a script grouped the diff records by kind.
   A coordinator agent was alerted only for a new kind, and assigned it to a
   worker agent with its own Slack thread.
2. *Inner loop.* A cloud sandbox with both codebases ran input and output
   checks in under a second. The agent wrote a request that reproduced the
   fingerprint, edited the Rust until the outputs matched, and added a test.
3. *Seam.* Human PR review. The verifier rewards a match, not a good fix: an
   engineer rejected a web-search "fix" that copied tool descriptions into
   files instead of calling the service that supplies them.
4. *Outer loop.* Builds with and without the fix were compared by how often the
   fingerprint appeared on shadowed traffic of the same kind.
5. *Memory loop.* Review corrections became `CLAUDE.md` rules, tests, lints
   and a merge check that a Python change needs a matching Rust change.

## 3. The core difference: porting vs inferring

Anthropic relied on the **generator–verifier gap**: given the Python, writing
the Rust was cheap, and verifying it was the hard part. A listener at the load
balancer turns this around.

| Dimension | Anthropic (Python → Rust) | Slime at the load balancer |
|---|---|---|
| Source code | Both codebases in the sandbox | None (black box), or the client's repo (mode B) |
| Oracle | Production at each internal checkpoint | The production response, end to end only |
| Locating a bug | The first checkpoint that differs | A JSON path; on Slime's own side, SQL rows vs shape |
| Nondeterminism | The model ran once and was replayed | Database state at time *t*, replica lag, timestamps, ordering |
| Side effects | Billing counted once | Writes cannot be shadowed safely |
| Privacy | Shape-only records | Inferring logic needs values, but Slime Cloud promises never to store rows |
| End state | Cutover | A permanent copy, or a migration target |

Without source code, generation becomes *programming by example*: building a
program from input/output pairs. That problem is underdetermined, because many
programs fit the same examples. `ORDER BY created_at` and `ORDER BY id` agree
on every observed case until the first backfill. Anthropic's numbers bound
the optimism: porting *known* code still matched only about a quarter of
production inputs at first.

> Matching all observed traffic shows parity on the observed distribution.
> It does not show the logic is correct.

## 4. Proposal: Slime Mirror

Slime Mirror is a shadow verifier that grows a verified copy of a service's
read side, one route at a time.

```text
 user ──► LB / tee ──► prod service ──► response to the user
              │          (oracle)
              │ copy: request + prod response + build id
              ▼
   ┌──────── Slime Mirror (inside the client's network) ────────┐
   │ route template → Gas → shadow run → diff → fingerprint ─┐  │
   │                          │ match ×N            new kind │  │
   │                          ▼                             ▼  │
   │                  Liquid → Crystal ◄── PR gate ◄── agent loop│
   │                  (cases = prod outputs, still shadowed)    │
   └────────────────────────────────────────────────────────────┘
       Only production answers users. The copy never does.
```

### 4.1 The three phases in mirror mode

* **Gas.** A new route template appears in the traffic. The generator gets the
  schema, the dictionary, K observed pairs and (in mode B) the route's source
  code, and writes SQL plus a shape function. Its output is never returned to a
  user.
* **Liquid.** The handler is promoted after N matches in a row on distinct
  inputs, with no unexplained diffs and an approved review. A mismatch sends it
  back to Gas with the fingerprint as context.
* **Crystal.** The key change from today is that **the reference becomes the
  production response**, not the Liquid output. The cases file holds (input,
  prod output, build id). "Evergreen" means the continuous shadow keeps
  checking the Crystal against each new prod build.

### 4.2 Two modes

* **Mode B, source-assisted (recommended).** The client gives Slime read access
  to the route's code. The generator ports it and the traffic only verifies.
  This is Anthropic's setting.
* **Mode A, black-box (experiment).** Only for routes that are a projection of
  SQL over a known schema. It claims parity on the observed distribution and
  nothing more, and has a kill criterion (§7).

### 4.3 Reuse and new work

Checked against `main` at `0eb3aed`.

| Reuse | New |
|---|---|
| Generator, sandbox, read-only lint, row cap and timeouts (`@slime-cloud/core`) | A tee that captures the **prod response**. Istio mirroring is fire-and-forget and discards responses, so it is not enough. |
| Equivalence rules: floats to 9 significant digits, list order counts (`crystal/src/equivalence.ts`) | Route templating, and a request key that needs no `intent` text |
| `<key>.cases.json`, `slime-crystal pin` / `verify`, cost ≤ 1.1× the reference | Cases whose reference is the prod output, not the Liquid handler |
| Writer → gate → three reviewers → `merge-gate.mjs` (`crystal/agents/`, `crystal/scripts/`) | A JSON diff, fingerprints, and grouping by kind |
| Provenance drift on `schemaHash`, which extends to the upstream build id | A field-level noise classifier, and match rate per route and build |

## 5. Adversarial review

**Steelman.** Production is the most complete specification a service has.
Slime already turns observations into verified code, through its read-only
sandbox, its equivalence gate and an agent loop with a merge gate. A tee plus
production as the oracle gives an endless stream of free test cases, and Gas →
Liquid → Crystal becomes a ladder of trust.

The objections were raised one at a time, strongest first.

**O1. Porting vs inferring. Survived in part.** With no source code,
generation is underdetermined, and ten runs (`CRYSTAL_MIN_RUNS`) cannot pick
among the programs that fit. *Defense:* mode B ports real code; mode A is
limited to SQL projections and claims only observed parity. *Remaining:* the
risk stays in mode A, so the pitch must never say "copies any backend".

**O2. Authorization is invisible, which invites IDOR. Survived.** An
authorization check in middleware leaves no trace in the observed pairs, so
inferred SQL filters only by the parameter. If the copy ever served traffic, it
would return other users' rows (IDOR: an insecure direct object reference,
fetching someone else's record by changing an id). Tenant scoping and feature
flags are invisible in the same way. *Defense:* shadow-only in v0; the
verified principal or tenant is an explicit input of the key; the cases must
include 401/403/404 refusals; reads go through a database role with row-level
security. *Remaining:* serving traffic from the copy needs its own security
review.

**O3. Database state and replica lag cause false mismatches. Answered.** The
response depends on the database at time *t*, and a later replay diverges.
*Defense:* shadow at once against the same replica. On a mismatch, request the
original again (safe for GET), and treat fields that differ between two prod
responses as noise for that field only. Anthropic warns that ignoring noise
wholesale hides real bugs. Locate bugs on Slime's own side (SQL rows vs shape).
Later, capture database reads for exact replay, as Keploy does.

**O4. A copy without writes is not a backend. Deferred.** v0 covers GET routes
only. Later, compare the copy's *planned* writes with the writes the original
actually made, read from change data capture, without executing them. That is
a separate design; the product frame already rules writes out because SaaS
writes have no rollback.

**O5. Recording bodies breaks "never stores rows". Survived: needs a decision.**
`product_frame_v0_2.md` says Slime Cloud never stores rows or content. The tee
records production responses. *Defense:* Mirror runs self-hosted inside the
client's network, and recordings and cases never leave it. Only shape-only
fingerprints reach Slime Cloud. The generator gets schema, types, source code
(mode B) and redacted examples. *Remaining:* a cloud variant cannot keep the
promise.

**O6. Keploy + Diffy + Claude Code already give 80% of this. Answered, with a
caveat.** Slime's unique parts are not capture or diffing. They are the
automatic ladder, guarded by a gate the agents cannot edit, and the
self-healing loop with a merge gate, both already in the repo. Caveat: don't
build capture; use an Envoy tap, a small proxy or Keploy.

**O7. The key needs an `intent`, and REST has none. Answered.** The intent
becomes `METHOD /route/{template}` (plus the OpenAPI summary when there is
one). Numbers, UUIDs and high-cardinality path segments are templated. The
output becomes the union JSON Schema of the observed responses. This needs a
new `KEY_VERSION`.

**O8. The long tail never reaches N. Answered.** Parity is a per-route
statistic over a window, split by build, not a yes-or-no "Crystal = done". A
route counts as covered only at ≥ X% matches over ≥ M distinct inputs, and
the inner loop writes its own boundary-case requests from the schema and the
source code.

**O9. "Evergreen" becomes an endless chase with overfitted fixes. Answered.**
Match rates are counted per build id read from a response header. A spike
after a deploy demotes the Crystal to its Liquid fallback. Fixes enter only
through `merge-gate.mjs` and human PR review. Rejections become rules in
`crystal/agents/*.md`, and each fingerprint kind gets a fixed budget of agent
runs.

### 5.1 Ledger

| # | Objection | Status | Resolution or what's left |
|---|---|---|---|
| O1 | Porting vs inferring | Survived, partial | Mode B answers it; mode A claims observed parity only |
| O2 | Authorization invisible, IDOR | Survived | Shadow-only in v0; serving needs a security review |
| O5 | "Never stores rows" | Survived | Self-hosted, shape-only to the cloud; decision D2 |
| O4 | Writes | Deferred | GET only; planned writes vs CDC is a separate design |
| O3 | State, lag, no checkpoints | Answered | Immediate shadow, re-request, field-level noise |
| O6 | Existing tools suffice | Answered | The ladder and the gate are the value; reuse capture tools |
| O7 | No intent in REST | Answered | Route template as intent, new `KEY_VERSION` |
| O8 | Long tail | Answered | Match rate per route and build, with thresholds |
| O9 | Endless chase | Answered | Build id, demotion, merge gate, memory, budget |

### 5.2 What would have to be true

* The target routes are read-only, over one database whose schema Slime can see.
* Once noise fields are removed, a response is a deterministic function of
  (input, principal, database snapshot).
* Authorization can be expressed as an input.
* Each route gets enough traffic to reach M distinct inputs within the window.
* The client allows a tee at the load balancer and Slime inside its network.
* For mode B, the client grants read access to the route's source code.

## 6. Prior art

Links checked by HTTP status on 2026-11-28. The claims about Diffy, Keploy,
Scientist and Istio were checked against their own READMEs or docs.

| Work | What it does | What Slime takes |
|---|---|---|
| [Diffy](https://github.com/opendiffy/diffy) | Runs a candidate and two copies of the known-good primary; primary-vs-secondary differences are noise | Field-level noise detection |
| [GitHub Scientist](https://github.com/github/scientist) | Control/candidate experiments; the control's value is always the one returned | "The copy never answers the user" |
| [Keploy](https://github.com/keploy/keploy) | Uses eBPF to capture API calls and database queries and replay them as tests with mocks | Capture database reads; don't build capture |
| [GoReplay](https://github.com/buger/goreplay) | HTTP traffic capture and replay | Offline replay for the inner loop |
| [Istio mirroring](https://istio.io/latest/docs/tasks/traffic-management/mirroring/) | Fire-and-forget mirroring; the mirror's responses are discarded | Mirroring alone lacks the prod response |
| [Envoy HTTP tap](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/tap_filter) | Records HTTP traffic at the proxy | A ready-made tee |
| [AWS VPC Traffic Mirroring](https://docs.aws.amazon.com/vpc/latest/mirroring/what-is-traffic-mirroring.html) | Copies packets at the network interface | Rejected: needs TLS termination and stream reassembly |
| [Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html) | Replaces a system route by route behind a facade | The unit of cutover is a route |
| [Daikon](https://plse.cs.washington.edu/daikon/) | Infers likely invariants from runs | Inferred specs hold only on what was observed |
| Programming by example (Gulwani, FlashFill, POPL 2011; link not checked) | Synthesizes programs from input/output pairs | Why mode A is underdetermined |

## 7. Evaluation: a hackathon slice

**Setup.** A hand-written REST service with 3–4 GET routes over
`examples/express/db/init.sql` plays the legacy prod. A small Node tee proxy in
front of it captures request, response and `x-build-id`, and a load script
drives traffic.

**Demo.** On screen, the match rate per route climbs from 0% to 100% as the
routes move Gas → Liquid → Crystal. Then a deploy changes `$.total` from cents
to dollars. The fingerprint `GET /orders/{id} · $.total · value · build 7`
appears, the Crystal is demoted, the agent loop opens a PR, and after the
merge the route is green again.

**Success.** At least 3 of the 4 routes reach Crystal with a ≥ 99% match rate
over ≥ 200 distinct inputs, and a new fingerprint after the deploy is caught
within one minute.

**Kill.** If mode A cannot reach 80% on any route without source code, mode A
is dropped and only mode B is pitched.

**Out of scope.** Writes, a cloud variant, Envoy or Kubernetes, and serving
traffic from the copy.

## 8. Decisions requested

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Mode | B as the main mode, A as an experiment / A only | B, with A as an experiment under its kill criterion |
| D2 | Where it runs | Self-hosted in the client's network / Slime Cloud | Self-hosted: it keeps "never stores rows" |
| D3 | End state | Shadow-only verifier / migration target with gradual cutover | Shadow-only for v0 |

## 9. Limits of this research

* Not measured: how much latency or load the tee adds, and the model's
  accuracy in mode A. The latter is what the kill criterion tests.
* The thresholds N, X and M are placeholders, to be set from the hackathon run.
* All Anthropic numbers come from one public post and were not independently
  verified.

## One-line takeaway

Production can tell you whether the copy *matched*. It cannot tell you
whether the copy's logic is right outside the traffic it has seen. So give
Slime the source code, keep the copy in the shadow, and stick to reads.
