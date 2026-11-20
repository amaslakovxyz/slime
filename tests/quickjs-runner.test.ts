import { describe, expect, test } from "bun:test";
import { createSeedDb } from "../src/db";
import { runThroughHarness } from "../src/harness";
import { createQuickJsRunner } from "../src/quickjs-runner";
import { parseIntent } from "../src/spec";
import type { Ctx } from "../src/types";

const spec = parseIntent(await Bun.file("intents/book_ticket.md").text(), "book_ticket");
const source = await Bun.file("examples/book_ticket.handler.js").text();
const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" };

describe("QuickJsRunner", () => {
  test("reference handler passes the same harness as FnRunner", async () => {
    const runner = await createQuickJsRunner();
    const out = runThroughHarness(runner, spec, source, { eventId: 7, qty: 2, promo: "FALL10" }, ctx, createSeedDb(), { commit: false });
    expect(out).toMatchObject({ ok: true, response: { total_cents: 9000 } });
  });
  test("infinite loop → SANDBOX_TIMEOUT", async () => {
    const runner = await createQuickJsRunner({ deadlineMs: 100 });
    const out = runThroughHarness(runner, spec,
      "export function handler(){ while(true){} }", {}, ctx, createSeedDb(), { commit: false });
    expect(out).toMatchObject({ ok: false, reason: "SANDBOX_TIMEOUT" });
  });
  test("db.read guardrail crosses the VM boundary with its reason code", async () => {
    const runner = await createQuickJsRunner();
    const out = runThroughHarness(runner, spec, `export function handler(input, db) {
      return { response: db.read({ table: "sqlite_master", columns: ["name"], where: {} }) };
    }`, {}, ctx, createSeedDb(), { commit: false });
    expect(out).toMatchObject({ ok: false, stage: "sandbox", reason: "READ_TABLE_NOT_DECLARED" });
  });
  test("no host escape: fetch/process/require are undefined in the VM", async () => {
    const runner = await createQuickJsRunner();
    const out = runThroughHarness(runner, spec, `export function handler() {
      return { response: [typeof fetch, typeof process, typeof require] };
    }`, {}, ctx, createSeedDb(), { commit: false });
    expect(out).toMatchObject({ ok: true, response: ["undefined", "undefined", "undefined"] });
  });
});
