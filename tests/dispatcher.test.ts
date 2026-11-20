import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createFetchHandler, devSession } from "../src/dispatcher";
import { parseIntent } from "../src/spec";
import type { GenResult, HarnessOutcome, RequestDeps } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");

const handlerWith = (o: { outcome?: HarnessOutcome; gen?: GenResult; resolveThrows?: boolean }) => {
  const deps: RequestDeps = {
    loadIntent: async name => name === "book_ticket" ? { spec, specHash: "s" } : null,
    store: {
      resolve: () => { if (o.resolveThrows) throw new Error("handler bytes do not match hash x"); return null; },
      admitGas: () => { throw new Error("unused"); },
      afterGasRun: () => null,
    },
    harness: () => o.outcome ?? { ok: false, stage: "role", reason: "ROLE_NOT_DECLARED", detail: "role" },
    db: new Database(":memory:"),
    generateHandler: async () => o.gen ?? { ok: true, source: "src", runs: [] },
  };
  return createFetchHandler(deps, devSession);
};
const post = (body: unknown) => new Request("http://x/dispatch", { method: "POST", body: JSON.stringify(body) });

describe("createFetchHandler status mapping", () => {
  test("role rejection → 403; other stages → 422", async () => {
    expect((await handlerWith({})(post({ intent: "book_ticket" }))).status).toBe(403);
    const inv: HarnessOutcome = { ok: false, stage: "invariants", reason: "INVARIANT_VIOLATION", detail: "sold_out" };
    const res = await handlerWith({ outcome: inv })(post({ intent: "book_ticket" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ tier: "gas", stage: "invariants", reason: "INVARIANT_VIOLATION" });
  });
  test("generation failure → 502", async () => {
    const res = await handlerWith({ gen: { ok: false, reason: "GENERATION_FAILED", detail: "d" } })(post({ intent: "book_ticket" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "GENERATION_FAILED", intent: "book_ticket", detail: "d" });
  });
  test("thrown store error → 500 INTERNAL", async () => {
    const res = await handlerWith({ resolveThrows: true })(post({ intent: "book_ticket" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "INTERNAL" });
  });
  test("non-string intent → 400", async () => {
    const res = await handlerWith({})(post({ intent: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "BAD_REQUEST", detail: "intent must be a string" });
  });
});
