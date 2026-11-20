# Crystal in production: how it runs once deployed

Status: the crystallize logic is built and tested. The automation around it
(the scheduled task, the GitHub App, the deploy pipeline) is a plan. Each step
below says which.

## The short version

The serving app never writes code. A **separate job runs on a schedule**, for
example nightly. Each run:

1. reads the Liquid handlers saved in Postgres;
2. asks a model to rewrite each one;
3. checks the rewrite;
4. commits the files to a branch and opens a pull request.

From there:

1. CI tests the pull request.
2. Auto-merge merges it.
3. The normal deploy builds a new image with the `crystal/` folder inside.
4. New servers load the folder at startup and serve those requests as Crystal.

The "agent" is **one model call per handler** inside that job. It is not a
long-running autonomous process. Deterministic checks decide whether its
output is used.

## The pieces on AWS

```
                 ┌──────────────────────────── VPC ────────────────────────────┐
  users ──HTTPS──▶ ALB ──▶ ECS service: Slime (N tasks, image vX)               │
                 │          │  reads crystal/ from the image at startup        │
                 │          ├─ slime_reader ─▶ RDS: app tables (read-only)     │
                 │          └─ slime_writer ─▶ RDS: slime_meta.handlers        │
                 │                              (Liquid code, run counts,      │
                 │                               recorded inputs)              │
                 │                                                             │
  EventBridge ──cron──▶ ECS task: "crystallize" (same image, other command)     │
  Scheduler      │          ├─ reads slime_meta (writer) + runs SELECTs (reader)│
                 │          ├─ calls Groq/Claude (optimizer)                    │
                 │          └─ git push + open PR (GitHub App token) ──────────┼──▶ GitHub
                 └─────────────────────────────────────────────────────────────┘      │
                                                                                      ▼
                                          CI tests the PR ─▶ auto-merge ─▶ deploy pipeline
                                                                         builds image vX+1
                                                                         (crystal/ baked in)
                                                                         ─▶ ECS rolling deploy
```

## Step by step

### While serving

1. **Gas** *(built)*. A new request gets SQL from the model. Repeat
   requests reuse it.
2. **Liquid** *(built)*. After `GAS_TO_LIQUID_HITS` successful runs and an
   approved background review, the handler is saved in
   `slime_meta.handlers`. The saved row holds:
   * the code and a hash of it;
   * the review result;
   * the run count;
   * up to `FIXTURES_PER_HANDLER` recorded inputs.

### The crystallize job

3. **Trigger** *(to build)*. EventBridge Scheduler starts a one-off ECS task,
   for example nightly at 03:00. The task uses the same Docker image as the
   service, with the command `npm run crystallize` instead of `npm start`.
   Its secrets come from Secrets Manager:
   * the reader and writer database URLs;
   * the model API key;
   * a GitHub App key.
4. **Check out the repo** *(to build)*. The task clones `main` using a
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
     every recorded input against the real database, through the read-only
     user (`SELECT` only), and must give identical output.

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
11. **Deploy** *(to build)*. The merge to `main` triggers:
    1. building the image, which now contains `crystal/`;
    2. pushing it to ECR;
    3. an ECS rolling deploy.
12. **Serve** *(built)*. New tasks load `crystal/`. For each module they check:
    * the hash against the manifest;
    * the allowlist;
    * that it was built against the current schema.

    Matching requests are then served with a plain function call: read-only
    SQL, then `shape(rows, input)`, with no worker. During the rollout, old
    tasks keep serving the same requests as Liquid, so there is no gap.
13. **Roll back** *(built)*. Set `SLIME_CRYSTAL=off` and redeploy, or revert
    the commit. A schema change retires every Crystal built against the old
    schema automatically. The next run rebuilds them from new Liquid handlers.

## Why an ECS task, not Lambda

The job needs `git`, a full checkout, Node and the test setup. It must reach
RDS, GitHub and the model API.

A Lambda (a container image, 15-minute limit) could do it. But in a VPC it
needs a NAT gateway to reach the internet, and it would duplicate the
packaging. An ECS task reuses the service image, has no time limit, and runs
in the same subnets, which already reach RDS and the internet with no NAT.

## Why keep Crystal in git

Getting from "became Liquid" to "served as Crystal" takes the schedule wait
plus CI plus a deploy: hours with a nightly job. That's fine, because Liquid
already serves in milliseconds in the meantime.

In exchange, every Crystal is:

* a diff that can be reviewed;
* part of git history;
* undone with `git revert`;
* exactly the code inside the deployed image.

Storing Crystal in the database and hot-loading it would be faster, but it
would lose all of that.

## Limits to keep in mind

* **The equivalence test proves equivalence only on recorded inputs**, not on
  every possible input. Keep the recorded inputs varied.
* **Crystal has no CPU or memory limit.** Allowed code that does heavy work
  on unusual data can block a server. The review, the equivalence test and the
  kill switch are the protection.
* **Crystal is not much faster than Liquid** (5–10 ms either way). The
  Postgres query dominates. Its value is that the code is reviewed, kept in
  git, and independent of the model.

## To build

1. **`crystallize` for unattended runs.** It needs to:
   * start a branch from `main`;
   * open the PR through the GitHub API, with the per-handler diff in the body;
   * skip handlers that already have an open Crystal PR;
   * report "optimized" only when the code actually changed.
2. **Infrastructure**, in CDK:
   * a Dockerfile;
   * the ECS service and the `crystallize` task definition;
   * the EventBridge schedule.
3. **A GitHub App** with `contents:write` and `pull_requests:write` on this
   repo, with its key in Secrets Manager.
4. **A deploy workflow** from `main` to ECR and ECS.

**For the hackathon,** steps 3 to 9 can be run by hand from a laptop:

```bash
npm run crystallize -- --optimizer groq --commit --push
```

Then open the PR. That shows the whole flow live; the schedule and the GitHub
App can come later.
