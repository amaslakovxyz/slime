import { describe, expect, test } from "bun:test";
import { createSeedDb } from "../src/db";
import { applyAndCheck } from "../src/invariants";
import { parseIntent } from "../src/spec";
import type { Ctx, Effect } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };
const buy = (eventId: number, qty: number): Effect =>
  ({ op: "insert", table: "tickets", data: { event_id: eventId, user_id: 42, qty, promo_code: null, total_cents: 1 } });

describe("invariant runner", () => {
  test("within capacity → ok, effect applied with forced tenant_id", () => {
    const db = createSeedDb();
    const res = applyAndCheck(db, spec, [buy(7, 2)], ctx);
    expect(res.ok).toBe(true);
    expect(db.query("SELECT tenant_id, qty FROM tickets").get()).toEqual({ tenant_id: 1, qty: 2 });
  });
  test("over capacity → INVARIANT_VIOLATION names sold_out", () => {
    const db = createSeedDb(); // event 8 has capacity 2
    const res = applyAndCheck(db, spec, [buy(8, 3)], ctx);
    expect(res).toMatchObject({ ok: false, reason: "INVARIANT_VIOLATION" });
    if (!res.ok) expect(res.detail).toContain("sold_out");
  });
});
