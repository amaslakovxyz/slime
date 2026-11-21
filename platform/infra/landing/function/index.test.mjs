// Run: node --test platform/infra/landing/function/index.test.mjs
// Serves the real platform/landing/ directory, the same files the layer ships.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.SITE_ROOT = fileURLToPath(new URL("../../../../platform/landing", import.meta.url));
const { handler } = await import("./index.mjs");

const get = (rawPath, headers = {}, method = "GET") =>
  handler({ rawPath, headers, requestContext: { http: { method } } });

test("root serves index.html", async () => {
  const res = await get("/");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.ok(res.isBase64Encoded);
  assert.match(Buffer.from(res.body, "base64").toString(), /<html/i);
});

// CloudFront compresses at the edge (gzip/brotli); the origin never does.
test("origin returns identity encoding even if the client accepts gzip", async () => {
  const res = await get("/", { "accept-encoding": "gzip, br" });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.headers["cache-control"], "public, max-age=300");
  assert.match(Buffer.from(res.body, "base64").toString(), /<html/i);
});

test("assets are served as binary with long cache", async () => {
  const res = await get("/assets/state-gas.webp", { "accept-encoding": "gzip" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.headers["cache-control"], "public, max-age=86400");
  assert.equal(Buffer.from(res.body, "base64").subarray(8, 12).toString(), "WEBP");
});

test("unknown paths, traversal and unlisted types are 404", async () => {
  for (const p of ["/nope.html", "/../../etc/passwd", "/assets/../../index.mjs", "/README.md"]) {
    assert.equal((await get(p)).statusCode, 404, p);
  }
});

test("HEAD has headers but no body; POST is 405", async () => {
  const head = await get("/", {}, "HEAD");
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal((await get("/", {}, "POST")).statusCode, 405);
});
