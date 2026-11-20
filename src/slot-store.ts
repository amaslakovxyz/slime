import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./hash";
import { isExpired, newGasSlot, onGasHit, onGasRun, shouldPromote, toLiquid } from "./slot";
import type { Fixture, IntentSlot, LiquidState, LockEntry, SlotStore } from "./types";

type Opts = { now: () => number; ttlMs: number; promoteHits: number };

// Gas lives in process memory (restart = eviction); Liquid and Crystal are files under `root`.
// Lookup order: Crystal (lee.lock) → Liquid (state/) → Gas (in-memory, sliding TTL).
export class FileSlotStore implements SlotStore {
  private gas = new Map<string, IntentSlot>();
  constructor(private root: string, private opts: Opts) {}

  resolve(intent: string, specHash: string): IntentSlot | null {
    const lockPath = join(this.root, "lee.lock");
    if (existsSync(lockPath)) {
      // Corrupt lock throws: surfaces as 500, never a silent fallback to a lower tier.
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, LockEntry>;
      const entry = lock[intent];
      if (entry && entry.specHash === specHash) return this.pinned(intent, "crystal", specHash, entry.handlerHash, "lee.lock");
    }

    const statePath = join(this.root, "state", `${intent}.json`);
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as LiquidState;
      if (state.specHash === specHash) return this.pinned(intent, "liquid", specHash, state.handlerHash, `state/${intent}.json`);
    }

    const slot = this.gas.get(intent);
    if (!slot) return null;
    const now = this.opts.now();
    if (slot.specHash !== specHash || isExpired(slot, now)) {
      this.gas.delete(intent);
      return null;
    }
    const hit = onGasHit(slot, now, this.opts.ttlMs);
    this.gas.set(intent, hit);
    return hit;
  }

  admitGas(intent: string, specHash: string, source: string, firstRun: Fixture): IntentSlot {
    const slot = newGasSlot(intent, specHash, source, this.opts.now(), this.opts.ttlMs, firstRun);
    this.gas.set(intent, slot);
    return slot;
  }

  afterGasRun(intent: string, fixture: Fixture | null): IntentSlot | null {
    const current = this.gas.get(intent);
    if (!current) return null;
    const slot = onGasRun(current, fixture);
    if (!shouldPromote(slot, this.opts.promoteHits)) {
      this.gas.set(intent, slot);
      return slot;
    }
    const liquid = toLiquid(slot);
    const state: LiquidState = {
      intent, tier: "liquid", specHash: liquid.specHash, handlerHash: liquid.handlerHash,
      promotedAt: new Date(this.opts.now()).toISOString(),
    };
    for (const dir of ["handlers", join("fixtures", intent), "state"]) mkdirSync(join(this.root, dir), { recursive: true });
    writeFileSync(join(this.root, "handlers", `${liquid.handlerHash}.js`), liquid.source);
    writeFileSync(join(this.root, "fixtures", intent, `${liquid.handlerHash}.jsonl`), liquid.fixtures.map(f => JSON.stringify(f) + "\n").join(""));
    writeFileSync(join(this.root, "state", `${intent}.json`), JSON.stringify(state, null, 2) + "\n");
    this.gas.delete(intent);
    return liquid;
  }

  // Liquid/Crystal bytes must be exactly the recorded hash.
  private pinned(intent: string, tier: "liquid" | "crystal", specHash: string, handlerHash: string, pinnedBy: string): IntentSlot {
    const path = join(this.root, "handlers", `${handlerHash}.js`);
    if (!existsSync(path)) throw new Error(`${pinnedBy} pins ${handlerHash} for ${intent} but handlers/${handlerHash}.js is missing`);
    const source = readFileSync(path, "utf8");
    if (sha256Hex(source) !== handlerHash) throw new Error(`handler bytes do not match hash ${handlerHash}`);
    return { intent, tier, specHash, handlerHash, source, hits: 0, expiresAt: null, fixtures: [] };
  }
}
