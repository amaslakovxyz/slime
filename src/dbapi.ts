import type { Database } from "bun:sqlite";
import { SCHEMA } from "./db";
import { GuardrailError, type Ctx, type DbApi, type Effect, type IntentSpec, type ReadQuery } from "./types";

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

      const where: Record<string, string | number> = { ...q.where, tenant_id: ctx.tenantId }; // kernel adds tenant filter
      const keys = Object.keys(where);
      // Table/columns are interpolated only after the SCHEMA allowlist check above; values use placeholders.
      const sql = `SELECT ${q.columns.join(", ")} FROM ${q.table}
                   WHERE ${keys.map(k => `${k} = ?`).join(" AND ")}
                   LIMIT ${Math.min(q.limit ?? 100, 100)}`;
      return db.query(sql).all(...keys.map(k => where[k])) as Record<string, unknown>[];
    },
    emit(e: Effect) {
      collected.push(e); // validation is the Gatekeeper's job, after the handler finishes
    },
  };
  return { api, effects: () => [...collected] };
}
