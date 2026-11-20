import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeedDb, openAppDb, SCHEMA, PK } from "../src/db";

describe("seed db", () => {
  test("schema matches contract", () => {
    expect(SCHEMA.events).toEqual(["id", "tenant_id", "capacity", "price_cents"]);
    expect(SCHEMA.tickets).toEqual(["id", "tenant_id", "event_id", "user_id", "qty", "promo_code", "total_cents"]);
    expect(SCHEMA.promos).toEqual(["code", "tenant_id", "pct", "max_uses"]);
    expect(SCHEMA.products).toEqual(["id", "tenant_id", "sku", "name", "price_cents", "stock"]);
    expect(SCHEMA.orders).toEqual(["id", "tenant_id", "user_id", "product_id", "qty", "promo_code", "total_cents"]);
    expect(PK.promos).toBe("code");
  });
  test("seed rows exist for tenant 1", () => {
    const db = createSeedDb();
    const ev = db.query("SELECT * FROM events WHERE id = 7").get() as any;
    expect(ev.capacity).toBe(100);
    expect(ev.price_cents).toBe(5000);
    const promo = db.query("SELECT * FROM promos WHERE code = 'FALL10'").get() as any;
    expect(promo.pct).toBe(10);
  });
});

describe("openAppDb", () => {
  test("seeds only on first creation; data survives reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lee-db-")), "nested", "app.sqlite");
    const first = openAppDb(path);
    first.run("INSERT INTO tickets (tenant_id, event_id, user_id, qty, promo_code, total_cents) VALUES (1, 7, 42, 1, NULL, 5000)");
    first.close();
    const again = openAppDb(path);
    expect((again.query("SELECT COUNT(*) AS n FROM tickets").get() as any).n).toBe(1);
    expect(again.query("SELECT id FROM events WHERE id = 7").get()).toEqual({ id: 7 });
    again.close();
  });
});
