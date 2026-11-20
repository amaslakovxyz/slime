// Serves the static landing page (landing/) from a Lambda Function URL.
//
// The site files ship as a Lambda layer, so they are unpacked under /opt.
// Only files present in the layer at cold start, with a known content type,
// are served; every other path returns 404. That allowlist is the path
// traversal guard: request paths are never joined onto the filesystem.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const SITE_ROOT = process.env.SITE_ROOT ?? "/opt";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt"]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// url path -> { body, gzip, type, cacheControl }
function loadSite(root) {
  const files = new Map();
  for (const full of walk(root)) {
    const ext = extname(full).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) continue;
    const body = readFileSync(full);
    files.set("/" + relative(root, full).split("\\").join("/"), {
      body,
      gzip: COMPRESSIBLE.has(ext) ? gzipSync(body) : null,
      type,
      // HTML must pick up redeploys quickly; assets change rarely.
      cacheControl: ext === ".html" ? "public, max-age=300" : "public, max-age=86400",
    });
  }
  return files;
}

const SITE = loadSite(SITE_ROOT);

function respond(statusCode, headers, body = "", isBase64Encoded = false) {
  return { statusCode, headers: { ...SECURITY_HEADERS, ...headers }, body, isBase64Encoded };
}

export function handle(event, site = SITE) {
  const method = event.requestContext?.http?.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return respond(405, { allow: "GET, HEAD", "content-type": "text/plain" }, "Method Not Allowed");
  }

  let path = event.rawPath || "/";
  if (path.endsWith("/")) path += "index.html";

  const file = site.get(path);
  if (!file) {
    return respond(404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
  }

  const acceptsGzip = /\bgzip\b/.test(event.headers?.["accept-encoding"] ?? "");
  const useGzip = acceptsGzip && file.gzip !== null;
  const payload = useGzip ? file.gzip : file.body;
  const headers = {
    "content-type": file.type,
    "cache-control": file.cacheControl,
    vary: "accept-encoding",
    ...(useGzip ? { "content-encoding": "gzip" } : {}),
  };

  if (method === "HEAD") return respond(200, headers);
  return respond(200, headers, payload.toString("base64"), true);
}

export const handler = async (event) => handle(event);
