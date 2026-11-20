import type { Database } from "bun:sqlite";
import type { Ctx, Effect, GateResult, IntentSpec } from "./types";

// Caller holds the open transaction; this never commits or rolls back.
// Must only ever run on a gate-passed effect set (runThroughHarness enforces the order),
// so table/column names here are already allowlist-validated.
export function applyAndCheck(db: Database, spec: IntentSpec, effects: Effect[], ctx: Ctx): GateResult {
  for (const e of effects) {
    if (e.op === "insert") {
      const data = { ...e.data, tenant_id: ctx.tenantId }; // kernel forces tenant
      const keys = Object.keys(data);
      db.query(`INSERT INTO ${e.table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .run(...keys.map(k => (data as any)[k]));
    } else {
      const where = { ...e.where, tenant_id: ctx.tenantId }; // kernel adds tenant to every where
      const wk = Object.keys(where);
      if (e.op === "update") {
        const dk = Object.keys(e.data ?? {});
        db.query(`UPDATE ${e.table} SET ${dk.map(k => `${k} = ?`).join(", ")}
                  WHERE ${wk.map(k => `${k} = ?`).join(" AND ")}`)
          .run(...dk.map(k => (e.data as any)[k]), ...wk.map(k => (where as any)[k]));
      } else {
        db.query(`DELETE FROM ${e.table} WHERE ${wk.map(k => `${k} = ?`).join(" AND ")}`)
          .run(...wk.map(k => (where as any)[k]));
      }
    }
  }
  for (const inv of spec.invariants) {
    const rows = db.query(inv.sql).all();
    if (rows.length > 0)
      return { ok: false, reason: "INVARIANT_VIOLATION", detail: `invariant '${inv.name}' returned ${rows.length} row(s)` };
  }
  return { ok: true };
}
