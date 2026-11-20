import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sha256Hex } from "../src/hash";
import { dispatchIntent } from "../src/request-path";
import { parseIntent } from "../src/spec";
import type { Ctx, Effect, Fixture, GenResult, HarnessFn, HarnessOutcome, IntentSlot, RequestDeps, SlotStore, Tier } from "../src/types";

const md = await Bun.file("intents/book_ticket.md").text();
const spec = parseIntent(md, "book_ticket");
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };
const payload = { eventId: 7, qty: 2 };
const RESPONSE = { total_cents: 10000 };
const EFFECTS: Effect[] = [{ op: "insert", table: "tickets", data: { qty: 2 } }];
const PASS: HarnessOutcome = { ok: true, response: RESPONSE, effects: EFFECTS };
const REJECT: HarnessOutcome = { ok: false, stage: "invariants", reason: "INVARIANT_VIOLATION", detail: "sold_out" };

function setup(opts: { known?: boolean; slot?: Tier | null; outcome?: HarnessOutcome; gen?: GenResult }) {
  const calls = { resolve: 0, admit: [] as string[], afterGasRun: [] as (Fixture | null)[], harness: [] as { source: string; commit: boolean }[], generate: 0 };
  const slot = (tier: Tier): IntentSlot => ({ intent: "book_ticket", tier, specHash: "s", handlerHash: `h-${tier}`, source: `src-${tier}`, hits: 1, expiresAt: null, fixtures: [] });
  const store: SlotStore = {
    resolve: () => { calls.resolve++; return opts.slot ? slot(opts.slot) : null; },
    admitGas: (_i, _s, source) => { calls.admit.push(source); return slot("gas"); },
    afterGasRun: (_i, f) => { calls.afterGasRun.push(f); return slot("gas"); },
  };
  const harness: HarnessFn = (_spec, source, _input, _ctx, _db, o) => { calls.harness.push({ source, commit: o.commit }); return opts.outcome ?? PASS; };
  const deps: RequestDeps = {
    loadIntent: async name => (opts.known ?? true) && name === "book_ticket" ? { spec, specHash: sha256Hex(md) } : null,
    store, harness, db: new Database(":memory:"),
    generateHandler: async () => { calls.generate++; return opts.gen ?? { ok: true, source: "generated", runs: [] }; },
  };
  return { deps, calls };
}

describe("dispatchIntent", () => {
  test("unknown intent → unknown_intent; nothing generated or run", async () => {
    const { deps, calls } = setup({ known: false });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toEqual({ kind: "unknown_intent", intent: "book_ticket" });
    expect(calls.generate).toBe(0);
    expect(calls.harness).toHaveLength(0);
  });

  test("miss + generation fails → generation_failed; harness and admitGas never called", async () => {
    const { deps, calls } = setup({ gen: { ok: false, reason: "GENERATION_FAILED", detail: "3 rounds exhausted" } });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toEqual({ kind: "generation_failed", intent: "book_ticket", detail: "3 rounds exhausted" });
    expect(calls.harness).toHaveLength(0);
    expect(calls.admit).toHaveLength(0);
  });

  test("miss + harness rejects → rejected gas; nothing admitted", async () => {
    const { deps, calls } = setup({ outcome: REJECT });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toMatchObject({ kind: "rejected", tier: "gas", stage: "invariants", reason: "INVARIANT_VIOLATION", handlerHash: sha256Hex("generated") });
    expect(calls.admit).toHaveLength(0);
  });

  test("miss + pass → served gas, committed, admitted once with generated source", async () => {
    const { deps, calls } = setup({});
    const r = await dispatchIntent(deps, "book_ticket", payload, ctx);
    expect(r).toEqual({ kind: "served", intent: "book_ticket", tier: "gas", handlerHash: sha256Hex("generated"), response: RESPONSE, effectsApplied: EFFECTS });
    expect(calls.harness).toEqual([{ source: "generated", commit: true }]);
    expect(calls.admit).toEqual(["generated"]);
  });

  test("gas hit → no generation; afterGasRun gets fixture on pass", async () => {
    const { deps, calls } = setup({ slot: "gas" });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toMatchObject({ kind: "served", tier: "gas", handlerHash: "h-gas" });
    expect(calls.generate).toBe(0);
    expect(calls.harness).toEqual([{ source: "src-gas", commit: true }]);
    expect(calls.afterGasRun).toEqual([{ intent: "book_ticket", handlerHash: "h-gas", input: payload, ctx, response: RESPONSE, effects: EFFECTS }]);
  });

  test("gas hit + reject → afterGasRun(null)", async () => {
    const { deps, calls } = setup({ slot: "gas", outcome: REJECT });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toMatchObject({ kind: "rejected", tier: "gas", reason: "INVARIANT_VIOLATION" });
    expect(calls.afterGasRun).toEqual([null]);
    expect(calls.generate).toBe(0);
  });

  test("liquid hit → served liquid; afterGasRun never called", async () => {
    const { deps, calls } = setup({ slot: "liquid" });
    expect(await dispatchIntent(deps, "book_ticket", payload, ctx)).toMatchObject({ kind: "served", tier: "liquid", handlerHash: "h-liquid" });
    expect(calls.afterGasRun).toHaveLength(0);
    expect(calls.generate).toBe(0);
  });
});
