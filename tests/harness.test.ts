import { describe, expect, test } from "bun:test";
import { createSeedDb } from "../src/db";
import { runThroughHarness } from "../src/harness";
import { FnRunner } from "../src/runner";
import { parseIntent } from "../src/spec";
import type { Ctx } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");
const source = await Bun.file("examples/book_ticket.handler.js").text();
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };
const run = (input: unknown, c: Ctx = ctx) =>
  runThroughHarness(new FnRunner(), spec, source, input, c, createSeedDb(), { commit: false });

describe("runThroughHarness", () => {
  test("happy path: promo applied, effects returned, db rolled back", () => {
    const db = createSeedDb();
    const out = runThroughHarness(new FnRunner(), spec, source, { eventId: 7, qty: 2, promo: "FALL10" }, ctx, db, { commit: false });
    expect(out).toMatchObject({ ok: true, response: { total_cents: 9000 } }); // 2*5000 minus 10%
    if (out.ok) expect(out.effects[0]).toMatchObject({ op: "insert", table: "tickets" });
    expect(db.query("SELECT COUNT(*) c FROM tickets").get()).toEqual({ c: 0 }); // rolled back
  });
  test("commit: true persists the effects", () => {
    const db = createSeedDb();
    expect(runThroughHarness(new FnRunner(), spec, source, { eventId: 7, qty: 2 }, ctx, db, { commit: true }).ok).toBe(true);
    expect(db.query("SELECT tenant_id, user_id, qty, total_cents FROM tickets").all())
      .toEqual([{ tenant_id: 1, user_id: 42, qty: 2, total_cents: 10000 }]);
  });
  test("promo cap: BIG90 capped at 50%", () => {
    const out = run({ eventId: 7, qty: 1, promo: "BIG90" });
    expect(out).toMatchObject({ ok: true, response: { total_cents: 2500 } });
  });
  test("undeclared role fails at role stage", () =>
    expect(run({ eventId: 7, qty: 1 }, { ...ctx, role: "admin" }))
      .toMatchObject({ ok: false, stage: "role", reason: "ROLE_NOT_DECLARED" }));
  test("handler error surfaces as HANDLER_ERROR", () =>
    expect(run({ eventId: 7, qty: 0 }))
      .toMatchObject({ ok: false, stage: "sandbox", reason: "HANDLER_ERROR" }));
  test("sold_out invariant blocks oversell", () =>
    expect(run({ eventId: 8, qty: 3 }))
      .toMatchObject({ ok: false, stage: "invariants", reason: "INVARIANT_VIOLATION" }));
  test("rogue handler writing events is stopped by gatekeeper", () => {
    const rogue = `export function handler(input, db, ctx) {
      db.emit({ op: "insert", table: "events", data: { capacity: 1, price_cents: 1 } });
      return { response: null };
    }`;
    expect(runThroughHarness(new FnRunner(), spec, rogue, {}, ctx, createSeedDb(), { commit: false }))
      .toMatchObject({ ok: false, stage: "gatekeeper", reason: "WRITE_NOT_DECLARED" });
  });
});
