import { checkRole } from "./gatekeeper";
import { sha256Hex } from "./hash";
import type { Ctx, DispatchResult, Fixture, HarnessOutcome, RequestDeps } from "./types";

const fixtureOf = (intent: string, handlerHash: string, payload: unknown, ctx: Ctx, out: HarnessOutcome): Fixture | null =>
  out.ok ? { intent, handlerHash, input: payload, ctx, response: out.response, effects: out.effects } : null;

// Request path (dev + prod): resolve Crystal → Liquid → Gas; on a miss generate just-in-time.
// Every handler, fresh or cached, goes through the same harness with commit: true.
export async function dispatchIntent(deps: RequestDeps, intent: string, payload: unknown, ctx: Ctx): Promise<DispatchResult> {
  const loaded = await deps.loadIntent(intent);
  if (!loaded) return { kind: "unknown_intent", intent };
  const { spec, specHash } = loaded;

  // The role is decided by spec + session, not by any handler: reject before resolving or generating,
  // so a forbidden caller never costs a generation. (The harness re-checks it on every run.)
  const role = checkRole(spec, ctx);
  if (!role.ok) return { kind: "rejected", intent, tier: null, handlerHash: null, stage: "role", reason: role.reason, detail: role.detail };

  const slot = deps.store.resolve(intent, specHash);
  if (slot) {
    const out = deps.harness(spec, slot.source, payload, ctx, deps.db, { commit: true });
    if (slot.tier === "gas") deps.store.afterGasRun(intent, fixtureOf(intent, slot.handlerHash, payload, ctx, out));
    return out.ok
      ? { kind: "served", intent, tier: slot.tier, handlerHash: slot.handlerHash, response: out.response, effectsApplied: out.effects }
      : { kind: "rejected", intent, tier: slot.tier, handlerHash: slot.handlerHash, stage: out.stage, reason: out.reason, detail: out.detail };
  }

  // Miss: repair is judged on the spec's try inputs, never on the live payload (a live rejection is
  // business logic, not a code defect), and the payload never enters the prompt (no injection).
  const gen = await deps.generateHandler(spec);
  if (!gen.ok) return { kind: "generation_failed", intent, detail: gen.detail };

  const handlerHash = sha256Hex(gen.source);
  const out = deps.harness(spec, gen.source, payload, ctx, deps.db, { commit: true });
  if (!out.ok) return { kind: "rejected", intent, tier: "gas", handlerHash, stage: out.stage, reason: out.reason, detail: out.detail };
  deps.store.admitGas(intent, specHash, gen.source, fixtureOf(intent, handlerHash, payload, ctx, out)!);
  return { kind: "served", intent, tier: "gas", handlerHash, response: out.response, effectsApplied: out.effects };
}
