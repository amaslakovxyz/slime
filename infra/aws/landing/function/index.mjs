// Serves the static landing page (landing/) from a Lambda Function URL.
//
// The site files ship as a Lambda layer, so they are unpacked under /opt.
// Only files present in the layer at cold start, with a known content type,
// are served; every other path returns 404. That allowlist is the path
// traversal guard: request paths are never joined onto the filesystem.
//
// Compression and security headers are CloudFront's job (edge gzip/brotli,
// Managed-SecurityHeadersPolicy; see domain.tf), not this function's.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

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

// url path -> { body, type, cacheControl }
function loadSite(root) {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const ext = extname(full).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) continue;
    files.set("/" + relative(root, full).split("\\").join("/"), {
      body: readFileSync(full),
      type,
      // HTML must pick up redeploys quickly; assets change rarely.
      cacheControl: ext === ".html" ? "public, max-age=300" : "public, max-age=86400",
    });
  }
  return files;
}

const SITE = loadSite(SITE_ROOT);

function respond(statusCode, headers, body = "", isBase64Encoded = false) {
  return { statusCode, headers, body, isBase64Encoded };
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

  const headers = { "content-type": file.type, "cache-control": file.cacheControl };
  if (method === "HEAD") return respond(200, headers);
  return respond(200, headers, file.body.toString("base64"), true);
}

export const handler = async (event) => handle(event);
