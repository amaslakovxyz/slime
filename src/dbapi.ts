import type { Database } from "bun:sqlite";
import { PK, SCHEMA } from "./db";
import { GuardrailError, type Ctx, type DbApi, type Effect, type IntentSpec, type ReadQuery } from "./types";

export const MAX_READ_ROWS = 100;

export const isWhereValue = (v: unknown): v is string | number | null | undefined =>
  v === undefined || v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

export function makeDbApi(db: Database, spec: IntentSpec, ctx: Ctx) {
  const collected: Effect[] = [];

  const api: DbApi = {
    read(q: ReadQuery) {
      const cols = SCHEMA[q.table];
      if (!cols || !spec.reads.includes(q.table))
        throw new GuardrailError("READ_TABLE_NOT_DECLARED", `read from '${q.table}'`);
      for (const c of [...q.columns, ...Object.keys(q.where)])
        if (!cols.includes(c))
          throw new GuardrailError("READ_COLUMN_UNKNOWN", `'${c}' on '${q.table}'`);

      // Missing values (undefined/null) bind as NULL, which equals nothing: a lookup by a missing field finds no row.
      const where: Record<string, string | number | null> = { tenant_id: ctx.tenantId };
      for (const [k, v] of Object.entries(q.where)) {
        if (!isWhereValue(v)) throw new GuardrailError("WHERE_VALUE_INVALID", `'${k}' on '${q.table}' must be a string, finite number or null`);
        if (k !== "tenant_id") where[k] = v ?? null; // kernel owns the tenant filter
      }
      const keys = Object.keys(where);
      const limit = Number.isFinite(q.limit) ? Math.min(Math.max(Math.trunc(q.limit!), 1), MAX_READ_ROWS) : MAX_READ_ROWS;
      // Table/columns are interpolated only after the SCHEMA allowlist check above; values use placeholders.
      const sql = `SELECT ${q.columns.join(", ")} FROM ${q.table}
                   WHERE ${keys.map(k => `${k} = ?`).join(" AND ")}
                   ORDER BY ${PK[q.table]} LIMIT ${limit}`;
      return db.query(sql).all(...keys.map(k => where[k])) as Record<string, unknown>[];
    },
    emit(e: Effect) {
      collected.push(e); // validation is the Gatekeeper's job, after the handler finishes
    },
  };
  return { api, effects: () => [...collected] };
}
