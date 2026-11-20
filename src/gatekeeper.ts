import { PK, SCHEMA } from "./db";
import { EFFECT_CAP, FORBIDDEN_COLUMNS, type Ctx, type Effect, type GateResult, type IntentSpec, type Reason } from "./types";

const fail = (reason: Reason, detail: string): GateResult => ({ ok: false, reason, detail });

export function checkRole(spec: IntentSpec, ctx: Ctx): GateResult {
  return spec.roles.includes(ctx.role) ? { ok: true }
    : fail("ROLE_NOT_DECLARED", `role '${ctx.role}' not in [${spec.roles}]`);
}

export function checkEffects(spec: IntentSpec, effects: Effect[]): GateResult {
  if (effects.length >= EFFECT_CAP) // spec: count must stay BELOW the cap
    return fail("EFFECT_CAP_EXCEEDED", `${effects.length} >= ${EFFECT_CAP}`);

  for (const e of effects) {
    const declared = spec.writes.find(w => w.table === e.table);
    if (!declared || !declared.ops.includes(e.op))
      return fail("WRITE_NOT_DECLARED", `${e.op} on '${e.table}'`);

    const cols = SCHEMA[e.table];
    for (const c of Object.keys(e.data ?? {})) {
      if (FORBIDDEN_COLUMNS.includes(c))
        return fail("FORBIDDEN_COLUMN", `'${c}' is kernel-owned`); // rejected, never filtered
      if (!cols.includes(c)) return fail("COLUMN_UNKNOWN", `'${c}' on '${e.table}'`);
    }
    for (const c of Object.keys(e.where ?? {})) {
      if (c === "tenant_id") return fail("FORBIDDEN_COLUMN", `'tenant_id' in where is kernel-owned`);
      if (!cols.includes(c)) return fail("COLUMN_UNKNOWN", `'${c}' on '${e.table}'`);
    }
    if ((e.op === "update" || e.op === "delete") && !(PK[e.table] in (e.where ?? {})))
      return fail("PK_NOT_FULLY_ADDRESSED", `${e.op} on '${e.table}' must address ${PK[e.table]} by equality`);
  }
  return { ok: true };
}
