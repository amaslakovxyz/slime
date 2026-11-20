import { describe, expect, test } from "bun:test";
import { checkEffects, checkRole } from "../src/gatekeeper";
import { parseIntent } from "../src/spec";
import { EFFECT_CAP, type Ctx, type Effect, type IntentSpec } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };
const ins = (data: Record<string, unknown>): Effect => ({ op: "insert", table: "tickets", data });
const good = ins({ event_id: 7, user_id: 42, qty: 1, promo_code: null, total_cents: 5000 });

describe("gatekeeper", () => {
  test("role declared → ok", () => expect(checkRole(spec, ctx).ok).toBe(true));
  test("role undeclared → ROLE_NOT_DECLARED", () =>
    expect(checkRole(spec, { ...ctx, role: "admin" })).toMatchObject({ ok: false, reason: "ROLE_NOT_DECLARED" }));
  test("declared insert passes", () => expect(checkEffects(spec, [good]).ok).toBe(true));
  test("undeclared table → WRITE_NOT_DECLARED", () =>
    expect(checkEffects(spec, [{ ...good, table: "events" }])).toMatchObject({ ok: false, reason: "WRITE_NOT_DECLARED" }));
  test("undeclared op → WRITE_NOT_DECLARED", () =>
    expect(checkEffects(spec, [{ op: "delete", table: "tickets", where: { id: 1 } }])).toMatchObject({ ok: false, reason: "WRITE_NOT_DECLARED" }));
  test("unknown column → COLUMN_UNKNOWN", () =>
    expect(checkEffects(spec, [ins({ ...good.data, hacked: 1 })])).toMatchObject({ ok: false, reason: "COLUMN_UNKNOWN" }));
  test("handler-supplied tenant_id → FORBIDDEN_COLUMN, not filtered", () =>
    expect(checkEffects(spec, [ins({ ...good.data, tenant_id: 2 })])).toMatchObject({ ok: false, reason: "FORBIDDEN_COLUMN" }));
  test("effect cap: count must stay below EFFECT_CAP", () => {
    expect(checkEffects(spec, Array.from({ length: EFFECT_CAP }, () => good)))
      .toMatchObject({ ok: false, reason: "EFFECT_CAP_EXCEEDED" });
    expect(checkEffects(spec, Array.from({ length: EFFECT_CAP - 1 }, () => good)).ok).toBe(true);
  });
  test("update without full PK → PK_NOT_FULLY_ADDRESSED", () => {
    const upd: IntentSpec = { ...spec, writes: [{ table: "tickets", ops: ["update"] }] };
    expect(checkEffects(upd, [{ op: "update", table: "tickets", data: { qty: 2 }, where: { event_id: 7 } }]))
      .toMatchObject({ ok: false, reason: "PK_NOT_FULLY_ADDRESSED" });
  });
  test("update addressing a NULL id → WHERE_VALUE_INVALID", () => {
    const upd: IntentSpec = { ...spec, writes: [{ table: "tickets", ops: ["update"] }] };
    expect(checkEffects(upd, [{ op: "update", table: "tickets", data: { qty: 2 }, where: { id: null as unknown as number } }]))
      .toMatchObject({ ok: false, reason: "WHERE_VALUE_INVALID" });
  });
});
