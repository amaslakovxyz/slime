import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWithRepair } from "../src/build-path";
import { openAppDb } from "../src/db";
import { createFetchHandler, devSession } from "../src/dispatcher";
import { sha256Hex } from "../src/hash";
import { makeHarness } from "../src/harness";
import { createQuickJsRunner } from "../src/quickjs-runner";
import { FileSlotStore } from "../src/slot-store";
import { makeIntentLoader } from "../src/spec";
import { GAS_TTL_MS, type RequestDeps } from "../src/types";

// Shop QA over HTTP with every real part (QuickJS, harness, file-backed slot store, SQLite).
// Only the agent is replaced: each cache miss "generates" the configured source for the intent,
// exactly like `lee serve --handler-dir`, and every generation is counted.

type Body = {
  tier?: string; stage?: string; reason?: string; detail?: string; error?: string;
  response?: { order_total_cents?: number; stock_left?: number; products?: { id: number }[] } | string;
};
type Reply = { status: number; body: Body };

const harness = makeHarness(await createQuickJsRunner());
const examples: Record<string, string> = {};
for (const intent of ["place_order", "list_products", "restock"])
  examples[intent] = await Bun.file(`examples/${intent}.handler.js`).text();

const cleanups: (() => void)[] = [];
afterAll(() => { for (const c of cleanups.reverse()) c(); });

// holdGenerationUntilRequests: generation stalls until that many requests have reached dispatch —
// forces fully overlapping cache misses (as with a slow LLM) without wall-clock sleeps.
type ShopOpts = { handlers?: Record<string, string>; seed?: (db: Database) => void; holdGenerationUntilRequests?: number };

function shop(opts: ShopOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "lee-shop-"));
  // Private copy of the specs (spec-edit tests mutate it). Plain read/write, not cpSync: Bun's cpSync uses
  // APFS clonefile, which was observed to block the event loop for 40+ s while the disk flushes other writes.
  mkdirSync(join(root, "intents"));
  for (const f of readdirSync("intents")) writeFileSync(join(root, "intents", f), readFileSync(join("intents", f)));
  const db = openAppDb(join(root, "app.sqlite"));
  opts.seed?.(db);
  const sources = { ...examples, ...opts.handlers };
  const gens: Record<string, number> = {};
  let arrived = 0;
  let releaseGenerations = () => {};
  const allArrived = new Promise<void>(resolve => { releaseGenerations = resolve; });
  let server: Server<undefined>;
  const start = () => {
    const loadIntent = makeIntentLoader(join(root, "intents"));
    const deps: RequestDeps = {
      loadIntent: name => {
        if (++arrived === opts.holdGenerationUntilRequests) releaseGenerations();
        return loadIntent(name);
      },
      store: new FileSlotStore(root, { now: Date.now, ttlMs: GAS_TTL_MS, promoteHits: 3 }),
      harness, db,
      generateHandler: spec => generateWithRepair(async () => {
        gens[spec.name] = (gens[spec.name] ?? 0) + 1;
        if (opts.holdGenerationUntilRequests) await allArrived;
        return sources[spec.name];
      }, spec, harness),
    };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createFetchHandler(deps, devSession) });
  };
  start();
  cleanups.push(() => { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); });

  const send = async (body: unknown, path = "/dispatch"): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Body };
  };
  return {
    root, db, gens, send,
    order: (payload: unknown) => send({ intent: "place_order", payload }),
    restart() { server.stop(true); start(); }, // new store + server on the same root and DB
    stock: (id: number) => (db.query("SELECT stock FROM products WHERE id = ?").get(id) as { stock: number }).stock,
    orderCount: () => (db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n,
    snapshot: () => JSON.stringify([db.query("SELECT * FROM products ORDER BY id").all(), db.query("SELECT * FROM orders ORDER BY id").all()]),
  };
}

const totalOf = (r: Reply) => (r.body.response as { order_total_cents: number }).order_total_cents;

describe("pricing", () => {
  test("FALL10 takes 10%, BIG90 is capped at 50%, unknown or missing promo gives no discount", async () => {
    const s = shop();
    const totals: number[] = [];
    for (const promo of ["FALL10", "BIG90", "NOPE", undefined]) {
      const r = await s.order({ productId: 1, qty: 1, promo });
      expect(r.status).toBe(200);
      totals.push(totalOf(r));
    }
    expect(totals).toEqual([1800, 1000, 2000, 2000]);
  });

  test("discounted totals are rounded to whole cents (half up)", async () => {
    const s = shop({ seed: db => db.exec("INSERT INTO products VALUES (6, 1, 'ODD', 'Odd price', 999, 100)") });
    expect(totalOf(await s.order({ productId: 6, qty: 5, promo: "FALL10" }))).toBe(4496); // 4495.5
    expect(totalOf(await s.order({ productId: 6, qty: 1, promo: "BIG90" }))).toBe(500);   // 499.5
    expect(totalOf(await s.order({ productId: 6, qty: 1, promo: "FALL10" }))).toBe(899);  // 899.1
  });
});

describe("stock", () => {
  test("an order decrements stock and records one order for the session user and tenant", async () => {
    const s = shop();
    const r = await s.order({ productId: 2, qty: 3, promo: "FALL10" });
    expect(r.status).toBe(200);
    expect(r.body.response).toEqual({ order_total_cents: 3240, stock_left: 47 });
    expect(s.stock(2)).toBe(47);
    expect(s.db.query("SELECT tenant_id, user_id, product_id, qty, promo_code, total_cents FROM orders").all())
      .toEqual([{ tenant_id: 1, user_id: 42, product_id: 2, qty: 3, promo_code: "FALL10", total_cents: 3240 }]);
  });

  test("cap (stock 2): two orders succeed, the third is OUT_OF_STOCK and commits nothing", async () => {
    const s = shop();
    const replies = [];
    for (let i = 0; i < 3; i++) replies.push(await s.order({ productId: 3, qty: 1 }));
    expect(replies.map(r => r.status)).toEqual([200, 200, 422]);
    expect(replies.slice(0, 2).map(r => (r.body.response as { stock_left: number }).stock_left)).toEqual([1, 0]);
    expect(replies[2].body).toMatchObject({ stage: "sandbox", reason: "HANDLER_ERROR", detail: "OUT_OF_STOCK" });
    expect(s.stock(3)).toBe(0);
    expect(s.orderCount()).toBe(2);
  });

  test("sold-out hoodie (stock 0) → OUT_OF_STOCK, no order", async () => {
    const s = shop();
    const r = await s.order({ productId: 4, qty: 1 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ stage: "sandbox", detail: "OUT_OF_STOCK" });
    expect(s.orderCount()).toBe(0);
  });

  test("a handler that skips the stock check is stopped by no_negative_stock; nothing committed or cached", async () => {
    const skipsCheck = examples.place_order.replace(`if (product.stock < input.qty) return { response: null, error: "OUT_OF_STOCK" };`, "");
    expect(skipsCheck).not.toBe(examples.place_order);
    const s = shop({ handlers: { place_order: skipsCheck } });
    const before = s.snapshot();
    const r = await s.order({ productId: 3, qty: 3 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ stage: "invariants", reason: "INVARIANT_VIOLATION" });
    expect(s.snapshot()).toBe(before);
    await s.order({ productId: 1, qty: 1 });
    expect(s.gens.place_order).toBe(2); // the rejected handler was never admitted as Gas
  });
});

describe("concurrency", () => {
  const burst = async (order: (payload: unknown) => Promise<Reply>, n: number) => {
    const replies = await Promise.all(Array.from({ length: n }, () => order({ productId: 2, qty: 1 })));
    const ok = replies.filter(r => r.status === 200).length;
    const rejected = replies.filter(r => r.status === 422 && r.body.detail === "OUT_OF_STOCK").length;
    return { ok, rejected, other: n - ok - rejected };
  };
  const STOCK = 17;
  const seed = (db: Database) => db.exec(`UPDATE products SET stock = ${STOCK} WHERE id = 2`);

  test("60 concurrent orders on a warm handler: exactly stock-many succeed, final stock 0, no 5xx", async () => {
    const s = shop({ seed });
    await s.order({ productId: 5, qty: 1 }); // admit Gas first
    expect(await burst(s.order, 60)).toEqual({ ok: STOCK, rejected: 60 - STOCK, other: 0 });
    expect(s.stock(2)).toBe(0);
    expect((s.db.query("SELECT COUNT(*) AS n FROM orders WHERE product_id = 2").get() as { n: number }).n).toBe(STOCK);
  });

  test("60 overlapping cache misses (slow generation) still never oversell", async () => {
    const s = shop({ seed, holdGenerationUntilRequests: 60 });
    expect(await burst(s.order, 60)).toEqual({ ok: STOCK, rejected: 60 - STOCK, other: 0 });
    expect(s.stock(2)).toBe(0);
    expect(s.orderCount()).toBe(STOCK);
  });
});

describe("tenant isolation", () => {
  test("ordering another tenant's product → PRODUCT_NOT_FOUND, its stock untouched", async () => {
    const s = shop();
    const r = await s.order({ productId: 101, qty: 1 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ stage: "sandbox", detail: "PRODUCT_NOT_FOUND" });
    expect(s.stock(101)).toBe(10);
  });

  test("list_products returns only this tenant's in-stock products, sorted by id", async () => {
    const s = shop({ seed: db => db.exec("INSERT INTO products VALUES (102, 2, 'T2-B', 'Tenant 2 mug', 100, 5)") });
    const r = await s.send({ intent: "list_products" });
    expect(r.status).toBe(200);
    expect((r.body.response as { products: { id: number }[] }).products.map(p => p.id)).toEqual([1, 2, 3, 5]);
  });

  test("a handler asking for tenant 2 rows still only sees tenant 1 rows", async () => {
    const peeks = `export function handler(input, db) {
      return { response: { products: db.read({ table: "products", columns: ["id", "tenant_id"], where: { tenant_id: 2 } }) } };
    }`;
    const s = shop({ handlers: { list_products: peeks } });
    const r = await s.send({ intent: "list_products" });
    expect(r.status).toBe(200);
    const rows = (r.body.response as { products: { id: number; tenant_id: number }[] }).products;
    expect(rows).toEqual([1, 2, 3, 4, 5].map(id => ({ id, tenant_id: 1 })));
  });

  test("an update addressed at another tenant's row id changes nothing", async () => {
    const hijack = examples.place_order.replace(
      "return { response: { order_total_cents",
      `if (input.hijack) db.emit({ op: "update", table: "products", data: { stock: 0 }, where: { id: 101 } });
  return { response: { order_total_cents`);
    expect(hijack).not.toBe(examples.place_order);
    const s = shop({ handlers: { place_order: hijack } });
    expect((await s.order({ productId: 1, qty: 1, hijack: true })).status).toBe(200);
    expect(s.stock(101)).toBe(10);
  });
});

describe("roles", () => {
  test("restock (admin-only) from the user session → 403 at role stage, nothing written", async () => {
    const s = shop();
    const r = await s.send({ intent: "restock", payload: { productId: 4, qty: 10 } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ stage: "role", reason: "ROLE_NOT_DECLARED" });
    expect(s.stock(4)).toBe(0);
  });

  test("forbidden callers never trigger a generation (role checked before resolve/generate)", async () => {
    const s = shop();
    for (let i = 0; i < 3; i++) {
      const r = await s.send({ intent: "restock", payload: { productId: 4, qty: 10 } });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ tier: null, handlerHash: null, stage: "role" });
    }
    expect(s.gens.restock ?? 0).toBe(0);
  });
});

describe("regressions from QA", () => {
  test("V2: order without productId finds no product instead of buying the first row", async () => {
    const s = shop();
    const before = s.snapshot();
    const r = await s.order({ qty: 1 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ stage: "sandbox", reason: "HANDLER_ERROR", detail: "PRODUCT_NOT_FOUND" });
    expect(s.snapshot()).toBe(before);
  });

  test("T5: invariants are tenant-scoped — another tenant's bad row does not block this tenant", async () => {
    const s = shop({ seed: db => db.exec("UPDATE products SET stock = -1 WHERE id = 101") });
    const r = await s.order({ productId: 1, qty: 1 });
    expect(r.status).toBe(200);
    expect(s.stock(1)).toBe(99);
  });
});

describe("input validation", () => {
  test("bad payloads are rejected by the handler and commit nothing", async () => {
    const s = shop();
    const before = s.snapshot();
    const cases: [unknown, string][] = [
      [{ intent: "place_order", payload: { productId: 1, qty: 0 } }, "BAD_QTY"],
      [{ intent: "place_order", payload: { productId: 1, qty: -1 } }, "BAD_QTY"],
      [{ intent: "place_order", payload: { productId: 1, qty: "2" } }, "BAD_QTY"],
      [{ intent: "place_order", payload: { productId: 1, qty: 1.5 } }, "BAD_QTY"],
      [{ intent: "place_order", payload: [1, 2] }, "BAD_QTY"],
      [{ intent: "place_order" }, "BAD_QTY"],
      [{ intent: "place_order", payload: { productId: null, qty: 1 } }, "PRODUCT_NOT_FOUND"],
    ];
    for (const [body, detail] of cases) {
      const r = await s.send(body);
      expect({ body, status: r.status, detail: r.body.detail }).toEqual({ body, status: 422, detail });
    }
    const nullPayload = await s.order(null);
    expect(nullPayload.status).toBe(422);
    expect(nullPayload.body).toMatchObject({ stage: "sandbox", reason: "HANDLER_ERROR" });
    expect(s.snapshot()).toBe(before);
  });

  test("malformed requests and unsafe intent names never reach a handler", async () => {
    const s = shop();
    const cases: [unknown, string, number, string][] = [
      [{ intent: "../intents/place_order" }, "/dispatch", 404, "UNKNOWN_INTENT"],
      [{ intent: "place_order/../restock" }, "/dispatch", 404, "UNKNOWN_INTENT"],
      [{ intent: "PLACE_ORDER" }, "/dispatch", 404, "UNKNOWN_INTENT"],
      [{ intent: 42 }, "/dispatch", 400, "BAD_REQUEST"],
      ["[]", "/dispatch", 400, "BAD_REQUEST"],
      [{ intent: "place_order" }, "/dispatch/", 404, "NOT_FOUND"],
      [{ intent: "place_order" }, "/orders", 404, "NOT_FOUND"],
    ];
    for (const [body, path, status, error] of cases) {
      const r = await s.send(body, path);
      expect({ body, path, status: r.status, error: r.body.error }).toEqual({ body, path, status, error });
    }
    expect(s.gens).toEqual({});
  });
});

describe("adversarial handlers", () => {
  // Trojan: honest on the spec's try inputs (so it passes JIT verification), malicious on live `evil` payloads.
  const honest = examples.place_order.replace("export function handler", "function honest");
  const trojan = (body: string) => `${honest}
export function handler(input, db, ctx) {
  if (input.evil) { ${body} }
  return honest(input, db, ctx);
}`;
  const insertOrder = (extra: string) => `db.emit({ op: "insert", table: "orders", data: { user_id: 42, product_id: 1, qty: 1, total_cents: 1${extra} } });`;
  const cases: [string, string, string, string][] = [
    ["sets tenant_id on insert", `${insertOrder(", tenant_id: 2")} return { response: 1 };`, "gatekeeper", "FORBIDDEN_COLUMN"],
    ["sets tenant_id in where", `db.emit({ op: "update", table: "products", data: { stock: 1 }, where: { id: 101, tenant_id: 2 } }); return { response: 1 };`, "gatekeeper", "FORBIDDEN_COLUMN"],
    ["chooses the order id", `${insertOrder(", id: 999")} return { response: 1 };`, "gatekeeper", "FORBIDDEN_COLUMN"],
    ["updates without id in where", `db.emit({ op: "update", table: "products", data: { stock: 0 }, where: { sku: "TEE-BLK-M" } }); return { response: 1 };`, "gatekeeper", "PK_NOT_FULLY_ADDRESSED"],
    ["updates every row (no where)", `db.emit({ op: "update", table: "products", data: { stock: 0 } }); return { response: 1 };`, "gatekeeper", "PK_NOT_FULLY_ADDRESSED"],
    ["deletes a product", `db.emit({ op: "delete", table: "products", where: { id: 1 } }); return { response: 1 };`, "gatekeeper", "WRITE_NOT_DECLARED"],
    ["inserts a product", `db.emit({ op: "insert", table: "products", data: { sku: "X", name: "X", price_cents: 1, stock: 1 } }); return { response: 1 };`, "gatekeeper", "WRITE_NOT_DECLARED"],
    ["emits 10 effects", `for (let i = 0; i < 10; i++) ${insertOrder("")} return { response: 1 };`, "gatekeeper", "EFFECT_CAP_EXCEEDED"],
    ["writes an unknown column", `db.emit({ op: "update", table: "products", data: { discount: 1 }, where: { id: 1 } }); return { response: 1 };`, "gatekeeper", "COLUMN_UNKNOWN"],
    ["smuggles __proto__ into data", `db.emit(JSON.parse('{"op":"update","table":"products","data":{"__proto__":{"x":1},"stock":5},"where":{"id":1}}')); return { response: 1 };`, "gatekeeper", "COLUMN_UNKNOWN"],
    ["calls the raw host emit", `__emit(JSON.stringify({ op: "delete", table: "products", where: { id: 1 } })); return { response: 1 };`, "gatekeeper", "WRITE_NOT_DECLARED"],
    ["reads an undeclared table", `return { response: db.read({ table: "orders", columns: ["id"], where: {} }) };`, "sandbox", "READ_TABLE_NOT_DECLARED"],
    ["reads an unknown column", `return { response: db.read({ table: "products", columns: ["secret"], where: {} }) };`, "sandbox", "READ_COLUMN_UNKNOWN"],
    ["loops forever", `while (true) {}`, "sandbox", "SANDBOX_TIMEOUT"],
    ["exhausts memory", `const a = []; let i = 0; while (true) a.push(i++);`, "sandbox", "SANDBOX_MEMORY"],
    ["calls fetch", `fetch("http://localhost:1"); return { response: 1 };`, "sandbox", "HANDLER_ERROR"],
    ["reads process.env", `return { response: process.env };`, "sandbox", "HANDLER_ERROR"],
    ["requires fs", `require("fs"); return { response: 1 };`, "sandbox", "HANDLER_ERROR"],
  ];

  test.each(cases)("handler that %s → %s %s; nothing committed, nothing cached", async (_name, body, stage, reason) => {
    const s = shop({ handlers: { place_order: trojan(body) } });
    const before = s.snapshot();
    const r = await s.order({ productId: 1, qty: 1, evil: true });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ tier: "gas", stage, reason });
    expect(s.snapshot()).toBe(before);
    expect((await s.order({ productId: 5, qty: 1 })).status).toBe(200);
    expect(s.gens.place_order).toBe(2); // the rejected handler was not admitted; the next request regenerated
  });

  test("a handler that misbehaves on the try inputs is never served: 502 after 3 repair rounds", async () => {
    const s = shop({ handlers: { place_order: `export function handler(input, db) {
      db.emit({ op: "delete", table: "products", where: { id: 1 } }); return { response: 1 };
    }` } });
    const before = s.snapshot();
    const r = await s.order({ productId: 1, qty: 1 });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("GENERATION_FAILED");
    expect(r.body.detail).toContain("WRITE_NOT_DECLARED");
    expect(s.gens.place_order).toBe(3);
    expect(s.snapshot()).toBe(before);
  });
});

describe("tier ladder and integrity", () => {
  const liquidShop = async () => {
    const s = shop();
    const tiers: string[] = [];
    for (let i = 0; i < 5; i++) tiers.push((await s.order({ productId: 5, qty: 1 })).body.tier!);
    expect(tiers).toEqual(["gas", "gas", "gas", "gas", "liquid"]);
    const state = JSON.parse(readFileSync(join(s.root, "state", "place_order.json"), "utf8")) as { handlerHash: string; specHash: string };
    return { s, state };
  };

  test("liquid survives a restart; editing the intent spec regenerates into gas", async () => {
    const { s } = await liquidShop();
    s.restart();
    expect((await s.order({ productId: 5, qty: 1 })).body.tier).toBe("liquid");
    expect(s.gens.place_order).toBe(1);
    appendFileSync(join(s.root, "intents", "place_order.md"), "\n<!-- edited -->\n");
    const r = await s.order({ productId: 5, qty: 1 });
    expect(r.status).toBe(200);
    expect(r.body.tier).toBe("gas");
    expect(s.gens.place_order).toBe(2);
  });

  test("tampered liquid handler bytes → 500 and nothing committed", async () => {
    const { s, state } = await liquidShop();
    appendFileSync(join(s.root, "handlers", `${state.handlerHash}.js`), "\n// tampered\n");
    const before = s.snapshot();
    const r = await s.order({ productId: 5, qty: 1 });
    expect(r.status).toBe(500);
    expect(r.body.detail).toContain("handler bytes do not match hash");
    expect(s.snapshot()).toBe(before);
  });

  test("corrupt lee.lock → 500, never a silent fallback to a lower tier", async () => {
    const { s } = await liquidShop();
    writeFileSync(join(s.root, "lee.lock"), "{not json");
    const r = await s.order({ productId: 5, qty: 1 });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("INTERNAL");
  });

  test("hand-written lee.lock serves crystal over liquid; a lock entry for an old spec is ignored", async () => {
    const { s, state } = await liquidShop();
    const specHash = sha256Hex(readFileSync(join(s.root, "intents", "place_order.md"), "utf8"));
    expect(state.specHash).toBe(specHash);
    const lock = (hash: string) => writeFileSync(join(s.root, "lee.lock"),
      JSON.stringify({ place_order: { intent: "place_order", handlerHash: state.handlerHash, specHash: hash, frozenAt: "2026-11-20T12:00:00Z" } }));
    lock(specHash);
    expect((await s.order({ productId: 5, qty: 1 })).body.tier).toBe("crystal");
    lock("0".repeat(64));
    expect((await s.order({ productId: 5, qty: 1 })).body.tier).toBe("liquid");
  });
});
