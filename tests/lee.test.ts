import { describe, expect, test } from "bun:test";

const lee = (...args: string[]) => Bun.spawn(["bun", "run", "src/lee.ts", ...args], { stdout: "pipe", stderr: "pipe" });

describe("lee build --handler-file", () => {
  test("prints effects and PASS, exits 0", async () => {
    const proc = lee("build", "book_ticket", "--handler-file", "examples/book_ticket.handler.js");
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("BUILD PASS");
    expect(stdout).toContain('"table": "tickets"');
    expect(stdout).toContain("rolled back"); // build path never commits
  });
  test("unknown intent exits 1", async () => {
    const proc = lee("build", "nope");
    expect(await new Response(proc.stderr).text()).toContain("unknown intent 'nope' (no intents/nope.md)");
    expect(await proc.exited).toBe(1);
  });
  test("bad args print usage and exit 1", async () => {
    const proc = lee("frobnicate");
    expect(await new Response(proc.stderr).text()).toContain("usage: lee serve");
    expect(await proc.exited).toBe(1);
  });
});
