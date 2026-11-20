import type { Database } from "bun:sqlite";
import { makeDbApi } from "./dbapi";
import { checkEffects, checkRole } from "./gatekeeper";
import { applyAndCheck } from "./invariants";
import { GuardrailError, type Ctx, type HarnessFn, type HarnessOutcome, type IntentSpec, type Runner } from "./types";

// role → BEGIN IMMEDIATE → sandbox → gatekeeper → invariants → COMMIT | ROLLBACK.
// Same pipeline on every path; callers choose the DB and whether to commit.
export function runThroughHarness(
  runner: Runner, spec: IntentSpec, source: string, input: unknown,
  ctx: Ctx, db: Database, opts: { commit: boolean },
): HarnessOutcome {
  const role = checkRole(spec, ctx);
  if (!role.ok) return { ok: false, stage: "role", reason: role.reason, detail: role.detail };

  db.exec("BEGIN IMMEDIATE");
  try {
    const { api, effects } = makeDbApi(db, spec, ctx);

    let result;
    try {
      result = runner.run(source, input, api, ctx);
    } catch (err) {
      if (err instanceof GuardrailError)
        return rollback(db, { ok: false, stage: "sandbox", reason: err.reason, detail: err.detail });
      return rollback(db, { ok: false, stage: "sandbox", reason: "HANDLER_ERROR", detail: String(err) });
    }
    if (result.error)
      return rollback(db, { ok: false, stage: "sandbox", reason: "HANDLER_ERROR", detail: result.error });

    const gate = checkEffects(spec, effects());
    if (!gate.ok) return rollback(db, { ok: false, stage: "gatekeeper", reason: gate.reason, detail: gate.detail });

    const inv = applyAndCheck(db, spec, effects(), ctx);
    if (!inv.ok) return rollback(db, { ok: false, stage: "invariants", reason: inv.reason, detail: inv.detail });

    if (opts.commit) db.exec("COMMIT");
    else db.exec("ROLLBACK"); // dry runs never commit
    return { ok: true, response: result.response, effects: effects() };
  } catch (err) {
    return rollback(db, { ok: false, stage: "sandbox", reason: "SANDBOX_CRASH", detail: String(err) });
  }
}

function rollback(db: Database, out: HarnessOutcome): HarnessOutcome {
  try { db.exec("ROLLBACK"); } catch {}
  return out;
}

export const makeHarness = (runner: Runner): HarnessFn => (spec, source, input, ctx, db, opts) =>
  runThroughHarness(runner, spec, source, input, ctx, db, opts);
