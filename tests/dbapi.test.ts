import { describe, expect, test } from "bun:test";
import { createSeedDb } from "../src/db";
import { makeDbApi } from "../src/dbapi";
import { parseIntent } from "../src/spec";
import { GuardrailError, type Ctx } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };
const setup = () => makeDbApi(createSeedDb(), spec, ctx);

describe("db.read", () => {
  test("reads declared table with tenant filter forced", () => {
    const { api } = setup();
    const rows = api.read({ table: "events", columns: ["id", "price_cents"], where: { id: 7 } });
    expect(rows).toEqual([{ id: 7, price_cents: 5000 }]);
  });
  test("tenant filter excludes other tenants", () => {
    const db = createSeedDb();
    db.exec("INSERT INTO events VALUES (99, 2, 10, 100)"); // tenant 2
    const { api } = makeDbApi(db, spec, ctx);
    expect(api.read({ table: "events", columns: ["id"], where: { id: 99 } })).toEqual([]);
  });
  test("undeclared table rejected", () => {
    const { api } = setup();
    expect(() => api.read({ table: "sqlite_master", columns: ["name"], where: {} }))
      .toThrow(GuardrailError);
  });
  test("unknown column rejected", () => {
    const { api } = setup();
    expect(() => api.read({ table: "events", columns: ["password"], where: {} }))
      .toThrow(GuardrailError);
  });
});

const shopSpec = parseIntent(await Bun.file("intents/list_products.md").text(), "list_products");
describe("db.read limits", () => {
  test("limit is clamped to 1..100 and rows come back in primary-key order", () => {
    const db = createSeedDb();
    for (let id = 1000; id < 1150; id++) db.run("INSERT INTO products VALUES (?, 1, 'S', 'N', 100, 5)", [id]);
    const { api } = makeDbApi(db, shopSpec, ctx);
    const read = (limit?: number) => api.read({ table: "products", columns: ["id"], where: {}, limit }).map(r => r.id as number);
    expect(read(-1)).toHaveLength(1);
    expect(read(1e9)).toHaveLength(100);
    expect(read()).toHaveLength(100);
    expect(read(2.9)).toEqual([1, 2]);
  });
});

describe("db.emit", () => {
  test("collects without executing", () => {
    const db = createSeedDb();
    const { api, effects } = makeDbApi(db, spec, ctx);
    api.emit({ op: "insert", table: "tickets", data: { event_id: 7, user_id: 42, qty: 1, promo_code: null, total_cents: 5000 } });
    expect(effects()).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) c FROM tickets").get()).toEqual({ c: 0 });
  });
});
