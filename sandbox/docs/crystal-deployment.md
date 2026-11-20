# Crystal in production: how it runs once deployed

Status: the crystallize logic is built and tested. The automation around it
(the scheduled run, the PR bot, the deploy) is a plan. Each step below says
which.

## Placeholders

This doc describes roles, not products. Two of them are not decided yet:

| Placeholder | Role | Today (OSS default) | Slime Cloud target |
|---|---|---|---|
| `{CODE_STORAGE}` | Where Liquid handlers live: the code, its hash, the review result, the run count and the recorded inputs. Core reaches it only through the `HandlerStore` contract (`src/store.ts`). | Postgres, schema `slime_meta`, written by the separate `slime_writer` user | A key-value store, such as DynamoDB or equivalent (design D6 in PR #7) |
| `{RUNTIME_FOR_SLIME_CLOUD}` | Where Slime Servers and the crystallize job run, including the runtime's scheduler and secret store | Local processes; in the Slime Cloud MVP, one Server process per tenant, started by the control plane | Not chosen |

Crystal modules themselves live in git, in the `crystal/` folder, as described
below. Where each tenant's Crystal lives in Slime Cloud is an open question;
see the end of this doc.

## The short version

The serving app never writes code. A **separate job runs on a schedule** on
`{RUNTIME_FOR_SLIME_CLOUD}`. Each run:

1. reads the Liquid handlers from `{CODE_STORAGE}`;
2. asks a model to rewrite each one;
3. checks the rewrite;
4. commits the files to a branch and opens a pull request.

From there:

1. CI tests the pull request.
2. Auto-merge merges it.
3. The normal deploy ships a new Server build with the `crystal/` folder
   inside.
4. New Servers load the folder at startup and serve those requests as
   Crystal.

The "agent" is **one model call per handler** inside that job. It is not a
long-running autonomous process. Deterministic checks decide whether its
output is used.

## The pieces

```
                ┌────────────────────── {RUNTIME_FOR_SLIME_CLOUD} ──────────────────────┐
  users ──HTTPS─▶ Slime Server(s), build vX                                              │
                │   │  loads crystal/ from its build at startup                          │
                │   ├─ read-only DB user ─▶ customer database                            │
                │   └─ HandlerStore ──────▶ {CODE_STORAGE}                               │
                │                           (Liquid code, run counts, recorded inputs)   │
                │                                                                        │
  scheduler ───▶│ crystallize job (same build as the Server, other command)              │
                │   ├─ HandlerStore ──────▶ {CODE_STORAGE}         (reads candidates)    │
                │   ├─ read-only DB user ─▶ customer database      (equivalence test)    │
                │   ├─ model API            (optimizer)                                  │
                │   └─ git push + open PR ─────────────────────────────────────────────┐ │
                └────────────────────────────────────────────────────────────────────────┘
                                                                                         ▼
                                                     GitHub: CI ─▶ auto-merge ─▶ deploy build vX+1
                                                                                 (crystal/ inside)
```

## Step by step

### While serving

1. **Gas** *(built)*. A new request gets SQL from the model. Repeat requests
   reuse it.
2. **Liquid** *(built)*. After `GAS_TO_LIQUID_HITS` successful runs and an
   approved background review, the handler is saved to `{CODE_STORAGE}`. The
   saved record holds:
   * the code and a hash of it;
   * the review result;
   * the run count;
   * up to `FIXTURES_PER_HANDLER` recorded inputs.

### The crystallize job

3. **Trigger** *(to build)*. The scheduler of `{RUNTIME_FOR_SLIME_CLOUD}`
   starts the job, for example nightly. The job is the same build as the
   Server, run with `npm run crystallize` instead of `npm start`. It gets its
   secrets from the runtime's secret store:
   * the customer database's read-only URL;
   * access to `{CODE_STORAGE}`;
   * the model API key;
   * a GitHub App key.
4. **Check out the repo** *(to build)*. The job clones `main` using a
   short-lived GitHub App token that can only write to this one repo. It
   creates a branch such as `chore/crystal-2026-11-21`.
5. **Pick candidates** *(built)*. It takes Liquid handlers that:
   * have at least `CRYSTAL_MIN_RUNS` successful runs;
   * have an approved review;
   * are not already in `crystal/manifest.json` on `main`.
6. **Optimize** *(built)*. One model call per handler, using
   `--optimizer claude|groq|none`. The model sees only:
   * the SQL and its parameter names;
   * the shaping code;
   * the output shape.

   It never sees the request text, so a crafted request can't instruct it,
   and it never sees data.
7. **Check** *(built)*. The candidate must pass:
   * the Crystal allowlist (a parse of the shaping code);
   * the read-only SQL lint;
   * `EXPLAIN`;
   * the **equivalence test**: the Liquid version and the candidate run on
     every recorded input against the customer database, through the
     read-only user (`SELECT` only), and must give identical output.

   If the optimized version fails, the unchanged Liquid code is tried. If that
   fails too, the handler stays Liquid and the reasons are printed.
8. **Write and commit** *(built)*. The job writes
   `crystal/<key>.mjs`, `crystal/<key>.fixtures.json` and the manifest entry,
   which pins the module's sha256. `--commit` commits them with the normal
   pre-commit hooks. It refuses to run on `main`.
9. **Push and open a pull request** *(to build)*. The job pushes the branch,
   opens a PR through the GitHub API and enables auto-merge. For each handler,
   the PR body shows:
   * the request;
   * the SQL before and after;
   * the equivalence result.

   The job should skip handlers that already have an open Crystal PR, so the
   next scheduled run doesn't duplicate them.

### Getting it live

10. **CI** *(built)*. The sandbox tests run on the PR. They include a check
    that every committed Crystal module matches its pinned hash, passes the
    allowlist and imports. If the checks are green, auto-merge merges with no
    human involved. Branch protection can require a review instead.
11. **Deploy** *(to build)*. The merge to `main` triggers a new Server build,
    which now contains `crystal/`. The build is rolled out on
    `{RUNTIME_FOR_SLIME_CLOUD}`.
12. **Serve** *(built)*. New Servers load `crystal/`. For each module they
    check:
    * the hash against the manifest;
    * the allowlist;
    * that it was built against the current schema.

    Matching requests are then served with a plain function call: read-only
    SQL, then `shape(rows, input)`, with no worker. During the rollout, the
    old build keeps serving the same requests as Liquid, so there is no gap.
13. **Roll back** *(built)*. Set `SLIME_CRYSTAL=off` and restart, or revert
    the commit. A schema change retires every Crystal built against the old
    schema automatically. The next run rebuilds them from new Liquid handlers.

## What the crystallize job needs from `{RUNTIME_FOR_SLIME_CLOUD}`

Whatever is chosen, the job needs:

* **The Server's own build**, so the same code that serves Liquid also
  crystallizes it. It also needs `git` and the test setup.
* **Network access** to `{CODE_STORAGE}`, the customer database (read-only),
  the model API and GitHub.
* **A scheduler and a secret store.**
* **No short time limit.** A run makes one model call per candidate, plus
  database queries for every recorded input.

## Why keep Crystal in git

Getting from "became Liquid" to "served as Crystal" takes the schedule wait
plus CI plus a deploy: hours with a nightly job. That's fine, because Liquid
already serves in milliseconds in the meantime.

In exchange, every Crystal is:

* a diff that can be reviewed;
* part of git history;
* undone with `git revert`;
* exactly the code inside the deployed build.

Storing Crystal next to Liquid in `{CODE_STORAGE}` and hot-loading it would be
faster, but it would lose all of that.

## Limits to keep in mind

* **The equivalence test proves equivalence only on recorded inputs**, not on
  every possible input. Keep the recorded inputs varied.
* **Crystal has no CPU or memory limit.** Allowed code that does heavy work
  on unusual data can block a Server. The review, the equivalence test and
  the kill switch are the protection.
* **Crystal is not much faster than Liquid** (5–10 ms either way). The
  Postgres query dominates. Its value is that the code is reviewed, kept in
  git, and independent of the model.

## Open questions

* **Where does each tenant's Crystal live in Slime Cloud?** Slime Cloud runs
  one Server per tenant, and Crystal is generated from that tenant's requests
  and database. Options:
  * a Crystal folder per tenant in a platform repo;
  * a repo per tenant;
  * Crystal in `{CODE_STORAGE}`, giving up the git benefits above.
* **Which `{RUNTIME_FOR_SLIME_CLOUD}`?** That choice decides the scheduler,
  the secret store and the deploy step.

## To build

1. **`crystallize` for unattended runs.** It needs to:
   * start a branch from `main`;
   * open the PR through the GitHub API, with the per-handler diff in the body;
   * skip handlers that already have an open Crystal PR;
   * report "optimized" only when the code actually changed.
2. **The scheduled run and the deploy step** on `{RUNTIME_FOR_SLIME_CLOUD}`,
   once it is chosen.
3. **A GitHub App** with `contents:write` and `pull_requests:write` on this
   repo, with its key in the runtime's secret store.

**For the hackathon,** steps 3 to 9 can be run by hand from a laptop:

```bash
npm run crystallize -- --optimizer groq --commit --push
```

Then open the PR. That shows the whole flow live; the schedule and the GitHub
App can come later.
