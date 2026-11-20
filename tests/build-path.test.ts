import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildPrompt, dryRun, generateWithRepair } from "../src/build-path";
import { parseIntent } from "../src/spec";
import type { HarnessFn, IntentSpec } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");

const fakeHarness: HarnessFn = (_spec, source) =>
  source === "bad"
    ? { ok: false, stage: "gatekeeper", reason: "WRITE_NOT_DECLARED", detail: "delete on events" }
    : { ok: true, response: { total_cents: 9000 }, effects: [] };

describe("generateWithRepair", () => {
  test("repairs after a rejected round and feeds the reason code to round 2", async () => {
    const prompts: string[] = [];
    const out = await generateWithRepair(async p => { prompts.push(p); return prompts.length === 1 ? "bad" : "good"; }, spec, fakeHarness);
    expect(out).toMatchObject({ ok: true, source: "good" });
    expect(out.ok && out.runs).toHaveLength(spec.try.length);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("WRITE_NOT_DECLARED");
  });

  test("exhausting 3 rounds → GENERATION_FAILED after exactly 3 generate calls", async () => {
    let calls = 0;
    const out = await generateWithRepair(async () => { calls++; return "bad"; }, spec, fakeHarness);
    expect(out).toEqual({ ok: false, reason: "GENERATION_FAILED", detail: "3 rounds exhausted; last: WRITE_NOT_DECLARED — delete on events" });
    expect(calls).toBe(3);
  });

  test("intent without try inputs → GENERATION_FAILED, generate never called", async () => {
    let calls = 0;
    const noTry: IntentSpec = { ...spec, try: [] };
    const out = await generateWithRepair(async () => { calls++; return "good"; }, noTry, fakeHarness);
    expect(out).toMatchObject({ ok: false, reason: "GENERATION_FAILED" });
    expect(calls).toBe(0);
  });
});

describe("dryRun", () => {
  test("never commits and uses a distinct seed db per try input", () => {
    const seen: { db: Database; commit: boolean; role: string }[] = [];
    const recording: HarnessFn = (_s, _src, _in, ctx, db, opts) => { seen.push({ db, commit: opts.commit, role: ctx.role }); return { ok: true, response: null, effects: [] }; };
    const runs = dryRun(recording, spec, "good");
    expect(runs.map(r => r.input)).toEqual(spec.try);
    expect(seen.map(s => s.commit)).toEqual([false, false]);
    expect(seen.map(s => s.role)).toEqual(["user", "user"]);
    expect(seen[0].db).not.toBe(seen[1].db);
  });
});

describe("buildPrompt", () => {
  test("contains spec rule, schema and db api contract", () => {
    const p = buildPrompt(spec);
    for (const s of ["capped at 50%", "CREATE TABLE tickets", "db.read", "db.emit", "export function handler"])
      expect(p).toContain(s);
  });
});
