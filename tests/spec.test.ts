import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/hash";
import { makeIntentLoader, parseIntent } from "../src/spec";

const md = await Bun.file("intents/book_ticket.md").text();

describe("parseIntent", () => {
  test("parses book_ticket", () => {
    const spec = parseIntent(md, "book_ticket");
    expect(spec.name).toBe("book_ticket");
    expect(spec.roles).toEqual(["user"]);
    expect(spec.reads).toEqual(["events", "promos", "tickets"]);
    expect(spec.writes).toEqual([{ table: "tickets", ops: ["insert"] }]);
    expect(spec.rule).toContain("capped at 50%");
    expect(spec.invariants).toHaveLength(1);
    expect(spec.invariants[0].name).toBe("sold_out");
    expect(spec.invariants[0].sql.replace(/\s+/g, " ")).toContain("HAVING SUM(t.qty) > e.capacity");
    expect(spec.try).toEqual([{ eventId: 7, qty: 2, promo: "FALL10" }, { eventId: 7, qty: 1 }]);
  });
});

describe("makeIntentLoader", () => {
  const load = makeIntentLoader("intents");
  test("loads spec and hashes the raw markdown", async () => {
    const loaded = await load("book_ticket");
    expect(loaded?.spec.name).toBe("book_ticket");
    expect(loaded?.specHash).toBe(sha256Hex(md));
  });
  test("unknown or path-like names → null", async () => {
    expect(await load("nope")).toBeNull();
    expect(await load("../README")).toBeNull();
    expect(await load("Book_Ticket")).toBeNull();
  });
});
