import { sha256Hex } from "./hash";
import type { Fixture, IntentSlot } from "./types";

// IntentSlot transitions (pure). See docs/plans/2026-11-20-gas-v0.md §A3.

export const newGasSlot = (intent: string, specHash: string, source: string, now: number, ttlMs: number, firstRun: Fixture): IntentSlot =>
  ({ intent, tier: "gas", specHash, handlerHash: sha256Hex(source), source, hits: 0, expiresAt: now + ttlMs, fixtures: [firstRun] });

export const isExpired = (s: IntentSlot, now: number): boolean =>
  s.tier === "gas" && s.expiresAt !== null && s.expiresAt <= now;

// Sliding TTL: every reuse extends the lifetime.
export const onGasHit = (s: IntentSlot, now: number, ttlMs: number): IntentSlot =>
  ({ ...s, hits: s.hits + 1, expiresAt: now + ttlMs });

export const onGasRun = (s: IntentSlot, f: Fixture | null): IntentSlot =>
  f ? { ...s, fixtures: [...s.fixtures, f] } : s;

// Reuse alone is not enough: only harness-passing runs (fixtures) earn persistence.
export const shouldPromote = (s: IntentSlot, n: number): boolean =>
  s.tier === "gas" && s.hits >= n && s.fixtures.length >= n;

export const toLiquid = (s: IntentSlot): IntentSlot =>
  ({ ...s, tier: "liquid", hits: 0, expiresAt: null });
