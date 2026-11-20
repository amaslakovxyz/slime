import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWithRepair } from "../src/build-path";
import { openAppDb } from "../src/db";
import { createFetchHandler, devSession } from "../src/dispatcher";
import { makeHarness } from "../src/harness";
import { createQuickJsRunner } from "../src/quickjs-runner";
import { FileSlotStore } from "../src/slot-store";
import { makeIntentLoader } from "../src/spec";
import { GAS_TTL_MS, type RequestDeps } from "../src/types";

// End-to-end over HTTP with every real part; only the LLM is replaced by the reference handler.
const root = mkdtempSync(join(tmpdir(), "lee-ladder-"));
const reference = await Bun.file("examples/book_ticket.handler.js").text();
const harness = makeHarness(await createQuickJsRunner());
const db = openAppDb(join(root, "app.sqlite"));
let generated = 0;
const countingFake = async () => { generated++; return reference; };

const servers: ReturnType<typeof Bun.serve>[] = [];
function start(): string {
  const deps: RequestDeps = {
    loadIntent: makeIntentLoader("intents"),
    store: new FileSlotStore(root, { now: Date.now, ttlMs: GAS_TTL_MS, promoteHits: 3 }),
    harness, db,
    generateHandler: spec => generateWithRepair(countingFake, spec, harness),
  };
  const server = Bun.serve({ port: 0, fetch: createFetchHandler(deps, devSession) });
  servers.push(server);
  return `http://localhost:${server.port}/dispatch`;
}
afterAll(() => { for (const s of servers) s.stop(true); db.close(); });

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const tickets = (d: Database) => (d.query("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
const book = { intent: "book_ticket", payload: { eventId: 7, qty: 2, promo: "FALL10" } };

describe("gas → liquid ladder over HTTP", () => {
  const url = start();

  test("4 gas serves, 5th is liquid; generated once; all committed", async () => {
    const tiers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post(url, book);
      expect(res.status).toBe(200);
      const body = await res.json() as { tier: string; response: { total_cents: number } };
      expect(body.response.total_cents).toBe(9000);
      tiers.push(body.tier);
    }
    expect(tiers).toEqual(["gas", "gas", "gas", "gas", "liquid"]);
    expect(existsSync(join(root, "state", "book_ticket.json"))).toBe(true);
    expect(generated).toBe(1);
    expect(tickets(db)).toBe(5);
  });

  test("oversell → 422 INVARIANT_VIOLATION, nothing committed", async () => {
    const res = await post(url, { intent: "book_ticket", payload: { eventId: 8, qty: 3 } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ stage: "invariants", reason: "INVARIANT_VIOLATION" });
    expect(tickets(db)).toBe(5);
  });

  test("restart (new store + server on same root) serves liquid without regenerating", async () => {
    const res = await post(start(), book);
    expect(await res.json()).toMatchObject({ tier: "liquid" });
    expect(generated).toBe(1);
  });

  test("HTTP errors: unknown intent 404, non-JSON 400, GET 404", async () => {
    const unknown = await post(url, { intent: "nope" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "UNKNOWN_INTENT", intent: "nope" });
    expect((await post(url, "not json")).status).toBe(400);
    const get = await fetch(url);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: "NOT_FOUND" });
  });
});
