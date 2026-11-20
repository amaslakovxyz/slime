import type { Database } from "bun:sqlite";

// ── A1 domain primitives ──
export type Ctx = { tenantId: number; userId: number; role: string; now: string };
export type ReadQuery = { table: string; columns: string[]; where: Record<string, string | number>; limit?: number };
export type Effect = { op: "insert" | "update" | "delete"; table: string; data?: Record<string, unknown>; where?: Record<string, string | number> };
export type HandlerResult = { response: unknown; error?: string };
export type IntentSpec = {
  name: string; roles: string[]; reads: string[];
  writes: { table: string; ops: Effect["op"][] }[];
  rule: string; invariants: { name: string; sql: string }[]; try: Record<string, unknown>[];
};
// One harness-passing real run of a handler.
export type Fixture = { intent: string; handlerHash: string; input: unknown; ctx: Ctx; response: unknown; effects: Effect[] };

// ── A2 layers ──
export type Stage = "role" | "sandbox" | "gatekeeper" | "invariants";
export type Reason =
  | "ROLE_NOT_DECLARED"
  | "READ_TABLE_NOT_DECLARED"
  | "READ_COLUMN_UNKNOWN"
  | "WRITE_NOT_DECLARED"      // table+op pair absent from spec.writes
  | "COLUMN_UNKNOWN"          // effect column not in schema
  | "FORBIDDEN_COLUMN"        // kernel-owned column supplied by handler
  | "PK_NOT_FULLY_ADDRESSED"  // update/delete without full-PK equality
  | "EFFECT_CAP_EXCEEDED"
  | "INVARIANT_VIOLATION"
  | "HANDLER_ERROR"           // handler threw or returned {error}
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_MEMORY"
  | "SANDBOX_CRASH"
  | "GENERATION_FAILED";      // agent exhausted 3 rounds
export type GateResult = { ok: true } | { ok: false; reason: Reason; detail: string };
export type HarnessOutcome =
  | { ok: true; response: unknown; effects: Effect[] }
  | { ok: false; stage: Stage; reason: Reason; detail: string };
export type DbApi = { read(q: ReadQuery): Record<string, unknown>[]; emit(e: Effect): void };
// source: full handler source text ("export function handler(...)").
// Throws GuardrailError for read violations; returns HandlerResult otherwise.
export interface Runner { run(source: string, input: unknown, db: DbApi, ctx: Ctx): HandlerResult }
export type HarnessFn = (spec: IntentSpec, source: string, input: unknown, ctx: Ctx, db: Database, opts: { commit: boolean }) => HarnessOutcome;
// Guardrail violations raised inside db.read are thrown as this tagged error
// so the harness can map them to a Reason instead of a generic HANDLER_ERROR.
export class GuardrailError extends Error { constructor(public reason: Reason, public detail: string) { super(`${reason}: ${detail}`); } }
export const EFFECT_CAP = 10;
export const FORBIDDEN_COLUMNS = ["tenant_id", "id"]; // kernel-owned: tenant forced, id autoincrement

// ── A3 aggregate ──
export type Tier = "gas" | "liquid" | "crystal";
// Tier state for one intent; changes only through the transitions in src/slot.ts.
export type IntentSlot = {
  intent: string; tier: Tier; specHash: string; handlerHash: string; source: string;
  hits: number; expiresAt: number | null; fixtures: Fixture[];
};
export type LiquidState = { intent: string; tier: "liquid"; specHash: string; handlerHash: string; promotedAt: string };
export type LockEntry = { intent: string; handlerHash: string; specHash: string; frozenAt: string };
export const GAS_TTL_MS = 600_000;
export const PROMOTE_HITS = 3;
export interface SlotStore {
  resolve(intent: string, specHash: string): IntentSlot | null;
  admitGas(intent: string, specHash: string, source: string, firstRun: Fixture): IntentSlot;
  afterGasRun(intent: string, fixture: Fixture | null): IntentSlot | null;
}

// ── A4 paths ──
export type Generate = (prompt: string) => Promise<string>;
export type TryRun = { input: Record<string, unknown>; outcome: HarnessOutcome };
export type GenResult = { ok: true; source: string; runs: TryRun[] } | { ok: false; reason: "GENERATION_FAILED"; detail: string };
export type LoadedIntent = { spec: IntentSpec; specHash: string };
export type RequestDeps = {
  loadIntent(name: string): Promise<LoadedIntent | null>;
  store: SlotStore; harness: HarnessFn; db: Database;
  generateHandler(spec: IntentSpec): Promise<GenResult>;
};
export type DispatchResult =
  | { kind: "served"; intent: string; tier: Tier; handlerHash: string; response: unknown; effectsApplied: Effect[] }
  | { kind: "rejected"; intent: string; tier: Tier; handlerHash: string; stage: Stage; reason: Reason; detail: string }
  | { kind: "unknown_intent"; intent: string }
  | { kind: "generation_failed"; intent: string; detail: string };
