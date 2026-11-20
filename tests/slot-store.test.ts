import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/hash";
import { FileSlotStore } from "../src/slot-store";
import type { Fixture } from "../src/types";

const I = "book_ticket";
const SRC = "export function handler() { return { response: 1 }; }";
const H = sha256Hex(SRC);
const fixture: Fixture = { intent: I, handlerHash: H, input: { qty: 1 }, ctx: { tenantId: 1, userId: 42, role: "user", now: "2026-11-20T12:00:00Z" }, response: 1, effects: [] };

let root: string;
let t: number;
const store = () => new FileSlotStore(root, { now: () => t, ttlMs: 600_000, promoteHits: 3 });
const writeHandler = (src = SRC) => { mkdirSync(join(root, "handlers"), { recursive: true }); writeFileSync(join(root, "handlers", `${sha256Hex(src)}.js`), src); };
const writeState = (specHash: string) => {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", `${I}.json`), JSON.stringify({ intent: I, tier: "liquid", specHash, handlerHash: H, promotedAt: "x" }));
};
const writeLock = (specHash: string) =>
  writeFileSync(join(root, "lee.lock"), JSON.stringify({ [I]: { intent: I, handlerHash: H, specHash, frozenAt: "x" } }));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lee-")); t = 0; });

describe("FileSlotStore — gas", () => {
  test("miss → null; admitted gas resolves with hits 1", () => {
    const s = store();
    expect(s.resolve(I, "a")).toBeNull();
    s.admitGas(I, "a", SRC, fixture);
    expect(s.resolve(I, "a")).toMatchObject({ tier: "gas", hits: 1, handlerHash: H });
  });

  test("3 reuses with 3 passing runs promote to liquid and survive restart", () => {
    const s = store();
    s.admitGas(I, "a", SRC, fixture);
    const tiers: string[] = [];
    for (let i = 0; i < 3; i++) { s.resolve(I, "a"); tiers.push(s.afterGasRun(I, fixture)!.tier); }
    expect(tiers).toEqual(["gas", "gas", "liquid"]);
    expect(readFileSync(join(root, "handlers", `${H}.js`), "utf8")).toBe(SRC);
    expect(JSON.parse(readFileSync(join(root, "state", `${I}.json`), "utf8"))).toMatchObject({ intent: I, tier: "liquid", specHash: "a", handlerHash: H });
    const lines = readFileSync(join(root, "fixtures", I, `${H}.jsonl`), "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map(l => JSON.parse(l))).toEqual([fixture, fixture, fixture, fixture]);
    expect(store().resolve(I, "a")).toMatchObject({ tier: "liquid", source: SRC, expiresAt: null });
  });

  test("failing runs never persist", () => {
    const s = store();
    s.admitGas(I, "a", SRC, fixture);
    for (let i = 0; i < 3; i++) { s.resolve(I, "a"); expect(s.afterGasRun(I, null)!.tier).toBe("gas"); }
    expect(existsSync(join(root, "state"))).toBe(false);
  });

  test("sliding TTL: reuse extends lifetime; idle past TTL evicts", () => {
    const s = store();
    s.admitGas(I, "a", SRC, fixture);
    t = 540_000; expect(s.resolve(I, "a")).not.toBeNull();
    t = 1_080_000; expect(s.resolve(I, "a")).not.toBeNull();
    t = 1_680_000; expect(s.resolve(I, "a")).toBeNull();
    t = 1_680_001; expect(s.resolve(I, "a")).toBeNull();
  });

  test("spec edit evicts gas and ignores liquid recorded under the old hash", () => {
    const s = store();
    s.admitGas(I, "a", SRC, fixture);
    expect(s.resolve(I, "b")).toBeNull();
    expect(s.resolve(I, "a")).toBeNull();
    writeHandler(); writeState("a");
    expect(s.resolve(I, "b")).toBeNull();
    expect(s.resolve(I, "a")).toMatchObject({ tier: "liquid" });
  });
});

describe("FileSlotStore — crystal and integrity", () => {
  test("crystal wins over liquid; lock under another spec hash falls back to liquid", () => {
    writeHandler(); writeState("a"); writeLock("a");
    expect(store().resolve(I, "a")).toMatchObject({ tier: "crystal", handlerHash: H, source: SRC });
    writeLock("old");
    expect(store().resolve(I, "a")).toMatchObject({ tier: "liquid" });
  });

  test("corrupt lee.lock throws", () => {
    writeFileSync(join(root, "lee.lock"), "{not json");
    expect(() => store().resolve(I, "a")).toThrow();
  });

  test("tampered handler bytes throw", () => {
    writeLock("a");
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers", `${H}.js`), SRC + "\n");
    expect(() => store().resolve(I, "a")).toThrow(`handler bytes do not match hash ${H}`);
  });

  test("pinned hash without handler file throws", () => {
    writeState("a");
    expect(() => store().resolve(I, "a")).toThrow(`state/${I}.json pins ${H} for ${I} but handlers/${H}.js is missing`);
  });
});
