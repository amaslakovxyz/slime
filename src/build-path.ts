import Anthropic from "@anthropic-ai/sdk";
import { createSeedDb, DDL } from "./db";
import type { GenResult, Generate, HarnessFn, IntentSpec, TryRun } from "./types";

export const SEED_CTX = { tenantId: 1, userId: 42, now: "2026-11-20T12:00:00Z" };

export function buildPrompt(spec: IntentSpec, priorFailure?: { reason: string; detail: string }): string {
  return [
    "Write a JavaScript handler for this business intent. Return ONLY the code, no prose, no markdown fence.",
    "",
    "Contract:",
    "  export function handler(input, db, ctx) -> { response, error? }",
    "  db.read({ table, columns, where, limit }) -> rows   // where: equality map only; tenant filtering is automatic",
    "  db.emit({ op: 'insert'|'update'|'delete', table, data?, where? })  // propose a write; never applied directly",
    "  ctx = { tenantId, userId, role, now }",
    "  Never set tenant_id or id yourself — the kernel owns them and will reject the write.",
    "  No imports, no fetch, no fs, no Date.now — pure logic over db.read/db.emit only.",
    "",
    `Intent: ${spec.name}`,
    `Rule: ${spec.rule}`,
    `Allowed reads: ${spec.reads.join(", ")}`,
    `Allowed writes: ${spec.writes.map(w => `${w.table}(${w.ops.join(",")})`).join(", ")}`,
    ...spec.invariants.map(i => `Invariant '${i.name}' (your writes must not make this SELECT return rows): ${i.sql}`),
    "",
    "Schema:", DDL,
    ...(priorFailure
      ? ["", `Your previous attempt was REJECTED by the harness: ${priorFailure.reason} — ${priorFailure.detail}`, "Fix exactly that and return the full corrected handler."]
      : []),
  ].join("\n");
}

// Every try input runs through the full harness on its own fresh seed copy; nothing commits.
export function dryRun(harness: HarnessFn, spec: IntentSpec, source: string): TryRun[] {
  return spec.try.map(input => ({
    input,
    outcome: harness(spec, source, input, { ...SEED_CTX, role: spec.roles[0] }, createSeedDb(), { commit: false }),
  }));
}

export async function generateWithRepair(generate: Generate, spec: IntentSpec, harness: HarnessFn, maxRounds = 3): Promise<GenResult> {
  if (spec.try.length === 0)
    return { ok: false, reason: "GENERATION_FAILED", detail: "intent declares no try inputs; JIT code cannot be verified" };
  let failure: { reason: string; detail: string } | undefined;
  for (let round = 1; round <= maxRounds; round++) {
    const source = await generate(buildPrompt(spec, failure));
    const runs = dryRun(harness, spec, source);
    const failed = runs.find(r => !r.outcome.ok)?.outcome;
    if (!failed) return { ok: true, source, runs };
    failure = failed.ok ? undefined : { reason: failed.reason, detail: failed.detail };
  }
  return { ok: false, reason: "GENERATION_FAILED", detail: `${maxRounds} rounds exhausted; last: ${failure!.reason} — ${failure!.detail}` };
}

export async function anthropicGenerate(prompt: string): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const msg = await client.messages.create({
    model: "claude-sonnet-5", max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  return text.replace(/^```(?:js|javascript)?\n?/, "").replace(/\n?```\s*$/, ""); // belt & braces
}
